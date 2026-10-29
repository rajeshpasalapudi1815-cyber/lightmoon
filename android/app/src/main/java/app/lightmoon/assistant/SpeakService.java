package app.lightmoon.assistant;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;
import java.util.ArrayDeque;
import java.util.Locale;

// Says reminders out loud with Android's text-to-speech when their time comes, even while LightMoon is
// closed, on the alarm volume so it's heard like an alarm clock. Each reminder also gets a notification.
public class SpeakService extends Service implements TextToSpeech.OnInitListener {

    private static final String CHANNEL_REMINDERS = "reminders";
    private static final String CHANNEL_SPEAKING = "speaking";
    private static final int SPEAKING_NOTIFICATION = 1;
    private static final long GIVE_UP_AFTER_MS = 60_000;

    private final ArrayDeque<ReminderStore.Reminder> queue = new ArrayDeque<>();
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable giveUp = this::finish;
    private final AudioAttributes alarmAudio = new AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_ALARM)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build();
    private TextToSpeech tts;
    private boolean ready;
    private boolean speaking; // a line has been handed to the voice and isn't finished yet
    private boolean finished; // this run has ended: late results (a slow briefing) are dropped, never said hours later
    private int composing; // briefings still being put together
    private int lastStartId;
    private AudioFocusRequest focus;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        lastStartId = startId;
        finished = false;
        createChannels(this);
        // Android requires the "speaking" notification at once; it goes away when the reminder has been said.
        Notification speaking = new NotificationCompat.Builder(this, CHANNEL_SPEAKING)
            .setSmallIcon(R.drawable.ic_stat_moon)
            .setContentTitle("LightMoon")
            .setContentText("Speaking a reminder")
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build();
        int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK : 0;
        ServiceCompat.startForeground(this, SPEAKING_NOTIFICATION, speaking, type);

        String id = intent == null ? null : intent.getStringExtra("id");
        ReminderStore.Reminder reminder = id == null ? null : ReminderStore.get(this, id);
        // Or a line to say that isn't a stored reminder (a meeting about to start, from MeetingReceiver).
        String say = intent == null ? null : intent.getStringExtra("say");
        if (reminder == null && say != null && !say.isEmpty()) {
            String sayId = intent.getStringExtra("sayId");
            long now = System.currentTimeMillis();
            reminder = new ReminderStore.Reminder(sayId != null ? sayId : "say-" + now, intent.getStringExtra("title"), say, now, 0);
        }
        // Or a briefing, put together first (it may fetch the weather) by Briefings, off the main thread.
        String briefing = intent == null ? null : intent.getStringExtra("briefing");
        if (reminder == null && briefing != null) {
            composing++;
            handler.removeCallbacks(giveUp);
            handler.postDelayed(giveUp, GIVE_UP_AFTER_MS);
            Context app = getApplicationContext();
            new Thread(() -> {
                String text = Briefings.compose(app, briefing);
                long now = System.currentTimeMillis();
                handler.post(() -> {
                    if (finished) return; // gave up waiting for it
                    composing--;
                    enqueue(new ReminderStore.Reminder("briefing-" + briefing + "-" + now, "Briefing", text, now, 0));
                });
            }).start();
            return START_NOT_STICKY;
        }
        if (reminder == null) {
            if (queue.isEmpty() && tts == null && composing == 0) finish();
            return START_NOT_STICKY;
        }
        enqueue(reminder);
        return START_NOT_STICKY;
    }

    private void enqueue(ReminderStore.Reminder reminder) {
        showReminder(this, reminder);
        queue.add(reminder);
        handler.removeCallbacks(giveUp);
        handler.postDelayed(giveUp, GIVE_UP_AFTER_MS);
        if (tts == null) tts = new TextToSpeech(this, this);
        else if (ready && !speaking) speakNext();
    }

    @Override
    public void onInit(int status) {
        if (tts == null) return; // already gave up
        if (status != TextToSpeech.SUCCESS) {
            finish();
            return;
        }
        ready = true;
        if (tts.setLanguage(Locale.UK) < 0) tts.setLanguage(Locale.getDefault());
        tts.setAudioAttributes(alarmAudio);
        tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            @Override
            public void onStart(String utteranceId) {}

            @Override
            public void onDone(String utteranceId) {
                handler.post(SpeakService.this::lineDone);
            }

            @Override
            public void onError(String utteranceId) {
                handler.post(SpeakService.this::lineDone);
            }
        });
        speakNext();
    }

    private void lineDone() {
        speaking = false;
        speakNext();
    }

    private void speakNext() {
        if (finished || tts == null) return;
        ReminderStore.Reminder reminder = queue.poll();
        if (reminder == null) {
            if (composing == 0) finish(); // else a briefing is still being put together
            return;
        }
        speaking = true;
        requestAudioFocus();
        ReminderStore.markSpoken(this, reminder.id);
        tts.speak(reminder.say, TextToSpeech.QUEUE_ADD, null, "reminder-" + reminder.id);
    }

    static void showReminder(Context context, ReminderStore.Reminder reminder) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
            && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            return;
        }
        createChannels(context);
        // With the app lock on, keep the words off the lock screen.
        String text = ReminderStore.hideText(context) ? "You have a reminder." : reminder.say;
        Intent open = new Intent(context, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent tap = PendingIntent.getActivity(context, reminder.id.hashCode(), open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification notification = new NotificationCompat.Builder(context, CHANNEL_REMINDERS)
            .setSmallIcon(R.drawable.ic_stat_moon)
            .setContentTitle("LightMoon reminder")
            .setContentText(text)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setAutoCancel(true)
            .setContentIntent(tap)
            .build();
        NotificationManagerCompat.from(context).notify(reminder.id.hashCode(), notification);
    }

    private void requestAudioFocus() {
        AudioManager audio = getSystemService(AudioManager.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (focus == null) {
                focus = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK).setAudioAttributes(alarmAudio).build();
            }
            audio.requestAudioFocus(focus);
        } else {
            audio.requestAudioFocus(null, AudioManager.STREAM_ALARM, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK);
        }
    }

    private void finish() {
        finished = true;
        handler.removeCallbacks(giveUp);
        AudioManager audio = getSystemService(AudioManager.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && focus != null) audio.abandonAudioFocusRequest(focus);
        if (tts != null) {
            tts.shutdown();
            tts = null;
        }
        ready = false;
        speaking = false;
        composing = 0;
        queue.clear();
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        // Only if no newer start is on its way (that one carries on with a fresh voice).
        stopSelfResult(lastStartId);
    }

    static void createChannels(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        NotificationChannel reminders = new NotificationChannel(CHANNEL_REMINDERS, "Reminders", NotificationManager.IMPORTANCE_HIGH);
        reminders.setDescription("Your LightMoon reminders");
        manager.createNotificationChannel(reminders);
        NotificationChannel speaking = new NotificationChannel(CHANNEL_SPEAKING, "Speaking", NotificationManager.IMPORTANCE_LOW);
        speaking.setDescription("Shown briefly while LightMoon says a reminder");
        manager.createNotificationChannel(speaking);
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacks(giveUp);
        if (tts != null) tts.shutdown();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
