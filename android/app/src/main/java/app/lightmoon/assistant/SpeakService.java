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
// Ask first (on unless switched off, PhonePrefs.askFirst): it never just says what a reminder is. It says "Boss, are
// you free now? I have a reminder for you." and keeps it waiting (KEY_WAITING), with a notification: "Tell me" says
// it, "Later" asks again in LATER_MS. Opened, LightMoon asks the same and listens for the answer (docs/js/askfirst.js).
public class SpeakService extends Service implements TextToSpeech.OnInitListener {

    private static final String CHANNEL_REMINDERS = "reminders";
    private static final String CHANNEL_SPEAKING = "speaking";
    private static final int SPEAKING_NOTIFICATION = 1;
    private static final long GIVE_UP_AFTER_MS = 60_000;
    private static final long WAIT_FOR_CALL_MS = 90 * 60_000;
    private static final long CALL_CHECK_MS = 15_000;
    private static final String ACTION_STOP = "app.lightmoon.assistant.STOP_SPEAKING";
    private static final String ACTION_TELL = "app.lightmoon.assistant.TELL_ME";
    private static final String ACTION_LATER = "app.lightmoon.assistant.ASK_LATER";
    static final String ACTION_ASK_AGAIN = "app.lightmoon.assistant.ASK_AGAIN";
    private static final String KEY_WAITING = "waiting_to_say";
    private static final int ASK_NOTIFICATION = 13;
    private static final long LATER_MS = 10 * 60_000;
    private static final long WAITING_KEEP_MS = 3 * 3600_000; // waited longer than this: the notifications have it
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
    private boolean telling; // this run says the waiting reminders ("Tell me"): no asking
    private boolean askedThisRun;
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
        if (intent != null && ACTION_LATER.equals(intent.getAction())) {
            askLater(this);
            if (queue.isEmpty() && tts == null && composing == 0) stopSelfResult(startId);
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

        if (intent != null && (ACTION_TELL.equals(intent.getAction()) || ACTION_ASK_AGAIN.equals(intent.getAction()))) {
            boolean tell = ACTION_TELL.equals(intent.getAction());
            NotificationManagerCompat.from(this).cancel(ASK_NOTIFICATION);
            java.util.List<ReminderStore.Reminder> waiting = takeWaiting(this);
            if (waiting.isEmpty()) {
                if (queue.isEmpty() && tts == null && composing == 0) finish();
                return START_NOT_STICKY;
            }
            if (tell) telling = true;
            else askedThisRun = false;
            for (ReminderStore.Reminder kept : waiting) queue.add(kept);
            restartGiveUp();
            if (tts == null) tts = new TextToSpeech(this, this);
            else if (ready && !this.speaking) speakNext();
            return START_NOT_STICKY;
        }
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
        if (!telling && PhonePrefs.askFirst(this) && !queue.isEmpty()) {
            askInstead();
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

    // ---------- Ask first ----------

    // What is queued waits; only the question is said (once a run: later ones join the same question).
    private void askInstead() {
        int count = keepWaiting(this, queue);
        queue.clear();
        showAsk(this, count);
        if (askedThisRun) {
            if (composing == 0) finish();
            return;
        }
        askedThisRun = true;
        speaking = true;
        saying = null;
        requestAudioFocus();
        tts.speak(Voice.sayTheirWay(this, askLine(this, count)), TextToSpeech.QUEUE_ADD, null, "ask-" + System.currentTimeMillis());
    }

    static String askLine(Context context, int count) {
        String who = PhonePrefs.address(context);
        String what = count <= 1 ? "I have a reminder for you." : "I have " + count + " things for you.";
        return who + ", are you free now? " + what + " Tap Tell me when you are, or wake me.";
    }

    private static int keepWaiting(Context context, java.util.Collection<ReminderStore.Reminder> more) {
        org.json.JSONArray kept = new org.json.JSONArray();
        long now = System.currentTimeMillis();
        java.util.Set<String> ids = new java.util.HashSet<>();
        for (ReminderStore.Reminder old : readWaiting(context)) {
            if (now - old.at > WAITING_KEEP_MS || !ids.add(old.id)) continue;
            kept.put(toJson(old));
        }
        for (ReminderStore.Reminder add : more) {
            if (!ids.add(add.id)) continue;
            kept.put(toJson(add));
        }
        PhonePrefs.get(context).edit().putString(KEY_WAITING, kept.toString()).apply();
        return kept.length();
    }

    private static org.json.JSONObject toJson(ReminderStore.Reminder reminder) {
        org.json.JSONObject entry = new org.json.JSONObject();
        try {
            entry.put("id", reminder.id).put("title", reminder.title == null ? "" : reminder.title).put("say", reminder.say)
                .put("at", Math.max(reminder.at, 1)).put("kept", System.currentTimeMillis());
        } catch (org.json.JSONException ignored) {
            // Plain strings and numbers: can't fail.
        }
        return entry;
    }

    private static java.util.List<ReminderStore.Reminder> readWaiting(Context context) {
        java.util.List<ReminderStore.Reminder> out = new java.util.ArrayList<>();
        try {
            org.json.JSONArray all = new org.json.JSONArray(PhonePrefs.get(context).getString(KEY_WAITING, "[]"));
            for (int i = 0; i < all.length(); i++) {
                org.json.JSONObject entry = all.optJSONObject(i);
                if (entry == null) continue;
                // "at" for how long it has waited: when it was kept.
                out.add(new ReminderStore.Reminder(entry.optString("id"), entry.optString("title"), entry.optString("say"), entry.optLong("kept"), 0));
            }
        } catch (org.json.JSONException ignored) {
            // Spoilt list: nothing waits.
        }
        return out;
    }

    private static java.util.List<ReminderStore.Reminder> takeWaiting(Context context) {
        java.util.List<ReminderStore.Reminder> all = readWaiting(context);
        PhonePrefs.get(context).edit().remove(KEY_WAITING).apply();
        java.util.List<ReminderStore.Reminder> fresh = new java.util.ArrayList<>();
        long now = System.currentTimeMillis();
        for (ReminderStore.Reminder reminder : all) if (now - reminder.at <= WAITING_KEEP_MS) fresh.add(reminder);
        return fresh;
    }

    // Opened LightMoon itself asks and says them (the page has the same reminders): nothing waits here any more.
    static void forgetWaiting(Context context) {
        PhonePrefs.get(context).edit().remove(KEY_WAITING).apply();
        NotificationManagerCompat.from(context).cancel(ASK_NOTIFICATION);
    }

    private static void showAsk(Context context, int count) {
        createChannels(context);
        Intent tell = new Intent(context, SpeakService.class).setAction(ACTION_TELL);
        Intent later = new Intent(context, SpeakService.class).setAction(ACTION_LATER);
        Intent open = new Intent(context, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL_REMINDERS)
            .setSmallIcon(R.drawable.ic_stat_moon)
            .setContentTitle("LightMoon")
            .setContentText(PhonePrefs.address(context) + ", " + (count <= 1 ? "I have a reminder for you" : "I have " + count + " things for you") + " when you're free.")
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setSilent(true)
            .setAutoCancel(true)
            .setContentIntent(PendingIntent.getActivity(context, 31, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT))
            // Saying it aloud needs the phone unlocked: a reminder isn't read to whoever picks the phone up.
            .addAction(new NotificationCompat.Action.Builder(0, "Tell me", PendingIntent.getService(context, 32, tell, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT))
                .setAuthenticationRequired(true).build())
            .addAction(0, "Later", PendingIntent.getService(context, 33, later, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
        try {
            NotificationManagerCompat.from(context).notify(ASK_NOTIFICATION, builder.build());
        } catch (SecurityException err) {
            // Notifications off: the question was still said.
        }
    }

    // "Later": asked again in LATER_MS (an alarm, so it happens with the phone asleep too).
    private static void askLater(Context context) {
        NotificationManagerCompat.from(context).cancel(ASK_NOTIFICATION);
        android.app.AlarmManager alarms = context.getSystemService(android.app.AlarmManager.class);
        Intent again = new Intent(context, AlarmReceiver.class).setAction(ACTION_ASK_AGAIN);
        PendingIntent operation = PendingIntent.getBroadcast(context, 34, again, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        long at = System.currentTimeMillis() + LATER_MS;
        if (ReminderStore.canUseExactAlarms(context)) {
            PendingIntent show = PendingIntent.getActivity(context, 0, new Intent(context, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);
            alarms.setAlarmClock(new android.app.AlarmManager.AlarmClockInfo(at, show), operation);
        } else {
            alarms.setAndAllowWhileIdle(android.app.AlarmManager.RTC_WAKEUP, at, operation);
        }
    }

    static void showReminder(Context context, ReminderStore.Reminder reminder) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
            && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            return;
        }
        createChannels(context);
        // With the app lock on, keep the words off the lock screen. Asking first: only that there is one, until they're free.
        String text = ReminderStore.hideText(context) || PhonePrefs.askFirst(context) ? "You have a reminder." : reminder.say;
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
        telling = false;
        askedThisRun = false;
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
