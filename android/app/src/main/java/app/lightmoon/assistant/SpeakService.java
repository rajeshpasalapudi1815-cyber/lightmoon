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

// Says reminders out loud with Android's text-to-speech when their time comes, even while LightMoon is
// closed, on the alarm volume so it's heard like an alarm clock. Each reminder also gets a notification.
// Never over a phone or WhatsApp call: it waits for the call to end (up to WAIT_FOR_CALL_MS; the notification stays
// meanwhile), and a call that starts mid-sentence stops it. Volume down (VolumeStop) or Stop on its notification
// silences it.
public class SpeakService extends Service implements TextToSpeech.OnInitListener {

    private static final String CHANNEL_REMINDERS = "reminders";
    private static final String CHANNEL_SPEAKING = "speaking";
    private static final int SPEAKING_NOTIFICATION = 1;
    private static final long GIVE_UP_AFTER_MS = 60_000;
    private static final long WAIT_FOR_CALL_MS = 90 * 60_000;
    private static final long CALL_CHECK_MS = 15_000;
    private static final String ACTION_STOP = "app.lightmoon.assistant.STOP_SPEAKING";
    private static volatile SpeakService running;

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
    private ReminderStore.Reminder saying; // the line being said now
    private long waitingSince; // > 0 while waiting for a call to end
    private final Runnable callCheck = this::checkCallOver;

    static boolean speakingNow() {
        SpeakService service = running;
        return service != null && service.speaking;
    }

    // Volume down (VolumeStop) or Stop on the notification: quiet now, and what was still to come is dropped.
    static void stopNow() {
        SpeakService service = running;
        if (service == null) return;
        service.handler.post(() -> {
            if (service.tts != null) service.tts.stop();
            service.finish();
        });
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        lastStartId = startId;
        running = this;
        createChannels(this);
        VolumeStop.watch(this);
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            if (tts != null) tts.stop();
            finish();
            return START_NOT_STICKY;
        }
        finished = false;
        // Android requires the "speaking" notification at once; it goes away when the reminder has been said.
        Notification speaking = new NotificationCompat.Builder(this, CHANNEL_SPEAKING)
            .setSmallIcon(R.drawable.ic_stat_moon)
            .setContentTitle("LightMoon")
            .setContentText("Speaking a reminder")
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .addAction(0, "Stop", stopIntent(this))
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
            restartGiveUp();
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
        restartGiveUp();
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
        Voice.useChosenVoice(this, tts);
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
        saying = null;
        speakNext();
    }

    private static PendingIntent stopIntent(Context context) {
        Intent stop = new Intent(context, SpeakService.class).setAction(ACTION_STOP);
        return PendingIntent.getService(context, 7, stop, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    // While waiting for a call to end, the 60-second give-up waits too.
    private void restartGiveUp() {
        handler.removeCallbacks(giveUp);
        if (waitingSince == 0) handler.postDelayed(giveUp, GIVE_UP_AFTER_MS);
    }

    // On a call: nothing is said until it ends (checked every 15 s). The reminders are on their notifications meanwhile.
    private void waitForCall() {
        if (waitingSince == 0) {
            waitingSince = System.currentTimeMillis();
            handler.removeCallbacks(giveUp);
            NotificationManagerCompat manager = NotificationManagerCompat.from(this);
            try {
                manager.notify(SPEAKING_NOTIFICATION, new NotificationCompat.Builder(this, CHANNEL_SPEAKING)
                    .setSmallIcon(R.drawable.ic_stat_moon)
                    .setContentTitle("LightMoon")
                    .setContentText("You're on a call: I'll say it when you're free")
                    .setPriority(NotificationCompat.PRIORITY_LOW)
                    .addAction(0, "Stop", stopIntent(this))
                    .build());
            } catch (SecurityException err) {
                // No notification permission: it still waits.
            }
        }
        handler.removeCallbacks(callCheck);
        handler.postDelayed(callCheck, CALL_CHECK_MS);
    }

    private void checkCallOver() {
        if (finished) return;
        if (System.currentTimeMillis() - waitingSince > WAIT_FOR_CALL_MS) {
            finish(); // a very long call: the notifications have it
            return;
        }
        if (PhonePrefs.inCall(this)) {
            waitForCall();
            return;
        }
        waitingSince = 0;
        restartGiveUp();
        speakNext();
    }

    private void speakNext() {
        if (finished || tts == null || waitingSince > 0) return;
        if (PhonePrefs.inCall(this)) {
            waitForCall();
            return;
        }
        ReminderStore.Reminder reminder = queue.poll();
        if (reminder == null) {
            if (composing == 0) finish(); // else a briefing is still being put together
            return;
        }
        speaking = true;
        saying = reminder;
        requestAudioFocus();
        ReminderStore.markSpoken(this, reminder.id);
        tts.speak(Voice.sayTheirWay(this, reminder.say), TextToSpeech.QUEUE_ADD, null, "reminder-" + reminder.id);
    }

    static void showReminder(Context context, ReminderStore.Reminder reminder) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
            && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            return;
        }
        createChannels(context);
        // With the app lock on, keep the words off the lock screen.
        String text = ReminderStore.hideText(context) ? "You have a reminder." : reminder.say;
        boolean task = ReminderStore.isTaskAlert(reminder.id);
        boolean headsUp = ReminderStore.isHeadsUp(reminder.id);
        boolean checkIn = task && !headsUp && !ReminderStore.taskIdOf(reminder.id).equals(reminder.id);
        // One notification per task: a check-in replaces the reminder's (or the earlier check-in's).
        int notificationId = (task ? ReminderStore.taskIdOf(reminder.id) : reminder.id).hashCode();
        Intent open = new Intent(context, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent tap = PendingIntent.getActivity(context, reminder.id.hashCode(), open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_REMINDERS)
            .setSmallIcon(R.drawable.ic_stat_moon)
            .setContentTitle(headsUp ? "LightMoon heads-up" : checkIn ? "LightMoon is checking in" : "LightMoon reminder")
            .setContentText(text)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setAutoCancel(true)
            .setContentIntent(tap);
        if (headsUp) {
            builder.addAction(0, "Done already", ReminderActionReceiver.intent(context, reminder, ReminderActionReceiver.DONE));
        } else if (task) {
            // Answer it without opening LightMoon (ReminderActionReceiver).
            builder.addAction(0, "Done", ReminderActionReceiver.intent(context, reminder, ReminderActionReceiver.DONE))
                .addAction(0, "Snooze 10 min", ReminderActionReceiver.intent(context, reminder, ReminderActionReceiver.SNOOZE))
                .addAction(0, "Stop asking", ReminderActionReceiver.intent(context, reminder, ReminderActionReceiver.STOP));
        }
        NotificationManagerCompat.from(context).notify(notificationId, builder.build());
    }

    private void requestAudioFocus() {
        AudioManager audio = getSystemService(AudioManager.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (focus == null) {
                focus = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK).setAudioAttributes(alarmAudio)
                    .setOnAudioFocusChangeListener(change -> handler.post(() -> focusLost(change)), handler)
                    .build();
            }
            audio.requestAudioFocus(focus);
        } else {
            audio.requestAudioFocus(null, AudioManager.STREAM_ALARM, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK);
        }
    }

    // A call (or another app) took the sound away mid-sentence: stop, and say that line again when it's free.
    private void focusLost(int change) {
        if (change != AudioManager.AUDIOFOCUS_LOSS && change != AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) return;
        if (finished || !speaking || tts == null) return;
        ReminderStore.Reminder again = saying;
        tts.stop();
        speaking = false;
        saying = null;
        if (again != null) queue.addFirst(again);
        handler.postDelayed(this::speakNext, 1500); // the call's audio mode comes a moment after it takes the sound
    }

    private void finish() {
        finished = true;
        waitingSince = 0;
        saying = null;
        handler.removeCallbacks(giveUp);
        handler.removeCallbacks(callCheck);
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
        if (running == this) running = null;
        handler.removeCallbacks(giveUp);
        handler.removeCallbacks(callCheck);
        if (tts != null) tts.shutdown();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
