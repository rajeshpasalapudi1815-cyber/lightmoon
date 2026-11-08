package app.lightmoon.assistant;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.SystemClock;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import java.util.Calendar;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

// The morning briefing as a phone call (Settings → Phone → Morning briefing → "as a call"): at the briefing time the
// phone rings with a LightMoon call screen (CallActivity), on the lock screen too, and a watch paired with the phone
// buzzes with it. Answering opens LightMoon, which gives the day's briefing and plan aloud and listens for the reply
// (docs/app.js, launch action "call"). Declined: nothing more. Not answered within RING_MS: a "missed call" note,
// which plays the briefing when tapped.
// Other calls at any time (Settings, or "call me at 3 pm"): a list of { id, time "HH:MM", daily, date "YYYY-MM-DD" }
// kept here and rung the same way; answered later in the day, LightMoon gives a check-in instead of the morning plan.
public class MorningCall extends BroadcastReceiver {

    // The ringing is played here in bursts (RING_ON_MS, then a pause), so "Speak out" can be heard between them; the
    // notification itself only vibrates. (The first channel, "lightmoon_call", rang by itself without pauses.)
    static final String CHANNEL = "lightmoon_call_2";
    private static final long RING_ON_MS = 2_200, RING_OFF_MS = 2_300;
    private static final android.os.Handler main = new android.os.Handler(android.os.Looper.getMainLooper());
    private static android.media.Ringtone tone;
    private static volatile long hushedUntil = 0;
    private static final long HUSH_MS = 5_000;

    // They started talking: no ring for a few seconds, so the answer words come through clean.
    static void hush() {
        hushedUntil = SystemClock.elapsedRealtime() + HUSH_MS;
        main.post(() -> { if (tone != null) tone.stop(); });
    }
    static final int NOTIFICATION = 11;
    private static final int MISSED_NOTIFICATION = 12;
    static final long RING_MS = 45_000;
    static final String ACTION_DECLINE = "app.lightmoon.assistant.CALL_DECLINE";
    private static final String ACTION_MISSED = "app.lightmoon.assistant.CALL_MISSED";
    private static final String ACTION_RING = "app.lightmoon.assistant.CALL_RING";
    private static final String CALLS = "calls";
    private static final int MAX_CALLS = 12;

    static volatile boolean ringing = false;

    static boolean on(Context context) {
        return PhonePrefs.get(context).getBoolean("briefing_call", false);
    }

    // Whether Android lets the call cover the screen (Android 14 asks the user for apps that aren't phone apps).
    static boolean canCoverScreen(Context context) {
        return Build.VERSION.SDK_INT < 34 || context.getSystemService(NotificationManager.class).canUseFullScreenIntent();
    }

    static void ring(Context context) {
        Context app = context.getApplicationContext();
        createChannel(app);
        ringing = true;
        Intent screen = new Intent(app, CallActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_NO_USER_ACTION);
        PendingIntent full = PendingIntent.getActivity(app, 20, screen, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        PendingIntent answer = PendingIntent.getActivity(app, 21, new Intent(screen).putExtra(CallActivity.EXTRA_ANSWER, true),
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        PendingIntent decline = PendingIntent.getBroadcast(app, 22, new Intent(app, MorningCall.class).setAction(ACTION_DECLINE),
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification call = new NotificationCompat.Builder(app, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_moon)
            .setContentTitle("LightMoon")
            .setContentText(subtitle())
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOngoing(true)
            .setAutoCancel(false)
            .setTimeoutAfter(RING_MS)
            .setFullScreenIntent(full, true)
            .setContentIntent(full)
            .addAction(0, "Decline", decline)
            .addAction(0, "Answer", answer)
            .build();
        try {
            NotificationManagerCompat.from(app).notify(NOTIFICATION, call);
        } catch (SecurityException err) {
            ringing = false; // notifications are off: no call
            return;
        }
        WakeWordService.forgetRingVoices(app);
        startRinging(app);
        WakeWordService.ringingChanged(); // listens for "Speak out" between the rings
        PendingIntent missed = PendingIntent.getBroadcast(app, 23, new Intent(app, MorningCall.class).setAction(ACTION_MISSED),
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        app.getSystemService(AlarmManager.class).set(AlarmManager.ELAPSED_REALTIME_WAKEUP, SystemClock.elapsedRealtime() + RING_MS + 1000, missed);
    }

    // "Your morning call" before noon, a check-in after (what LightMoon gives once answered: docs/js/brain.js).
    static String subtitle() {
        return Calendar.getInstance().get(Calendar.HOUR_OF_DAY) < 12 ? "Your morning call" : "Checking in on your day";
    }

    // Stops the ringing (answered, declined or missed).
    static void stop(Context context) {
        boolean was = ringing;
        ringing = false;
        NotificationManagerCompat.from(context).cancel(NOTIFICATION);
        stopRinging();
        if (was) WakeWordService.ringingChanged();
    }

    // The ringtone, on and off like a phone's, until stopped or RING_MS has passed.
    private static void startRinging(Context app) {
        stopRinging();
        try {
            tone = RingtoneManager.getRingtone(app, RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE));
            if (tone == null) return;
            tone.setAudioAttributes(new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build());
        } catch (RuntimeException err) {
            tone = null;
            return;
        }
        long until = SystemClock.elapsedRealtime() + RING_MS;
        Runnable[] burst = new Runnable[1];
        burst[0] = () -> {
            if (!ringing || tone == null || SystemClock.elapsedRealtime() > until) return;
            if (SystemClock.elapsedRealtime() < hushedUntil) {
                main.postDelayed(burst[0], 500);
                return;
            }
            try { tone.play(); } catch (RuntimeException ignored) { }
            main.postDelayed(() -> { if (tone != null) tone.stop(); }, RING_ON_MS);
            main.postDelayed(burst[0], RING_ON_MS + RING_OFF_MS);
        };
        main.post(burst[0]);
    }

    private static void stopRinging() {
        main.removeCallbacksAndMessages(null);
        if (tone != null) {
            try { tone.stop(); } catch (RuntimeException ignored) { }
            tone = null;
        }
    }

    // "Speak out" while it rang, in their voice (WakeWordService): LightMoon talks over the lock screen, no
    // fingerprint, shown only as the thin panel at the bottom.
    static void answerByVoice(Context context) {
        answered(context);
        WakeWordPlugin.pendingOwner = true;
        Intent open = new Intent(context, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            .putExtra(MainActivity.EXTRA_OVER_LOCK, true)
            .putExtra(MainActivity.EXTRA_PANEL, MainActivity.panelPossible());
        try {
            context.startActivity(open);
        } catch (RuntimeException err) {
            // Android wouldn't open it from here: the missed-call note still plays it.
        }
    }

    // Answered: LightMoon opens with the call waiting for it (WakeWordPlugin.takeWake -> call).
    static void answered(Context context) {
        hushedUntil = 0;
        stop(context);
        NotificationManagerCompat.from(context).cancel(MISSED_NOTIFICATION);
        WakeWordPlugin.pendingWake = true;
        WakeWordPlugin.pendingCall = true;
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if (ACTION_RING.equals(action)) {
            int id = intent.getIntExtra("id", -1);
            JSONArray kept = new JSONArray();
            boolean found = false;
            JSONArray all = calls(context);
            for (int i = 0; i < all.length(); i++) {
                JSONObject entry = all.optJSONObject(i);
                if (entry == null) continue;
                if (entry.optInt("id") == id) {
                    found = true;
                    if (!entry.optBoolean("daily")) continue; // a one-off call is used up
                }
                kept.put(entry);
            }
            saveCalls(context, kept);
            scheduleCalls(context);
            if (found) ring(context);
        } else if (ACTION_DECLINE.equals(action)) {
            stop(context);
        } else if (ACTION_MISSED.equals(action) && ringing) {
            stop(context);
            showMissed(context);
        }
    }

    private static void showMissed(Context context) {
        Intent open = new Intent(context, CallActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK).putExtra(CallActivity.EXTRA_ANSWER, true);
        PendingIntent tap = PendingIntent.getActivity(context, 24, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification missed = new NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_moon)
            .setContentTitle("Missed call from LightMoon")
            .setContentText("Tap to hear your morning briefing.")
            .setCategory(NotificationCompat.CATEGORY_MISSED_CALL)
            .setSilent(true)
            .setAutoCancel(true)
            .setContentIntent(tap)
            .build();
        try {
            NotificationManagerCompat.from(context).notify(MISSED_NOTIFICATION, missed);
        } catch (SecurityException err) {
            // Notifications are off.
        }
    }

    // ---------- Calls at other times ----------

    static JSONArray calls(Context context) {
        try {
            return new JSONArray(PhonePrefs.get(context).getString(CALLS, "[]"));
        } catch (JSONException err) {
            return new JSONArray();
        }
    }

    private static void saveCalls(Context context, JSONArray calls) {
        PhonePrefs.get(context).edit().putString(CALLS, calls.toString()).apply();
    }

    // Replaces the list ({ time, daily, date }; ids are given here), drops one-offs already past, and sets the alarms.
    static JSONArray setCalls(Context context, JSONArray wanted) {
        cancelAll(context);
        JSONArray kept = new JSONArray();
        int id = 1;
        for (int i = 0; i < wanted.length() && kept.length() < MAX_CALLS; i++) {
            JSONObject entry = wanted.optJSONObject(i);
            if (entry == null || !entry.optString("time").matches("\\d{2}:\\d{2}")) continue;
            boolean daily = entry.optBoolean("daily");
            String date = entry.optString("date", "");
            if (!daily && !date.matches("\\d{4}-\\d{2}-\\d{2}")) continue;
            try {
                JSONObject clean = new JSONObject().put("id", id++).put("time", entry.optString("time")).put("daily", daily);
                if (!daily) clean.put("date", date);
                if (next(clean) > 0) kept.put(clean);
            } catch (JSONException ignored) {
                // Skipped.
            }
        }
        saveCalls(context, kept);
        scheduleCalls(context);
        return kept;
    }

    // When this call rings next, in ms (0 = never: a one-off already past).
    static long next(JSONObject entry) {
        String time = entry.optString("time");
        Calendar at = Calendar.getInstance();
        if (!entry.optBoolean("daily")) {
            String date = entry.optString("date");
            at.set(Integer.parseInt(date.substring(0, 4)), Integer.parseInt(date.substring(5, 7)) - 1, Integer.parseInt(date.substring(8, 10)));
        }
        at.set(Calendar.HOUR_OF_DAY, Integer.parseInt(time.substring(0, 2)));
        at.set(Calendar.MINUTE, Integer.parseInt(time.substring(3, 5)));
        at.set(Calendar.SECOND, 0);
        at.set(Calendar.MILLISECOND, 0);
        long now = System.currentTimeMillis() + 30_000;
        if (at.getTimeInMillis() > now) return at.getTimeInMillis();
        if (!entry.optBoolean("daily")) return 0;
        at.add(Calendar.DAY_OF_YEAR, 1);
        return at.getTimeInMillis();
    }

    static void scheduleCalls(Context context) {
        AlarmManager alarms = context.getSystemService(AlarmManager.class);
        JSONArray all = calls(context);
        for (int i = 0; i < all.length(); i++) {
            JSONObject entry = all.optJSONObject(i);
            long at = entry == null ? 0 : next(entry);
            if (at == 0) continue;
            PendingIntent operation = ringIntent(context, entry.optInt("id"));
            try {
                if (ReminderStore.canUseExactAlarms(context)) {
                    PendingIntent show = PendingIntent.getActivity(context, 0, new Intent(context, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);
                    alarms.setAlarmClock(new AlarmManager.AlarmClockInfo(at, show), operation);
                } else {
                    alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, operation);
                }
            } catch (SecurityException ignored) {
                // Exact alarms not allowed: this call won't ring.
            }
        }
    }

    private static void cancelAll(Context context) {
        AlarmManager alarms = context.getSystemService(AlarmManager.class);
        for (int id = 1; id <= MAX_CALLS; id++) alarms.cancel(ringIntent(context, id));
    }

    private static PendingIntent ringIntent(Context context, int id) {
        Intent intent = new Intent(context, MorningCall.class).setAction(ACTION_RING).setData(Uri.parse("lightmoon://call/" + id)).putExtra("id", id);
        return PendingIntent.getBroadcast(context, 100 + id, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    static void createChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL, "Morning call", NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription("LightMoon calling you with your morning briefing or a check-in");
        channel.setSound(null, null); // rung by startRinging, with pauses to hear "Speak out"
        channel.enableVibration(true);
        channel.setVibrationPattern(new long[] { 0, 800, 600, 800, 600 });
        channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        channel.setBypassDnd(false);
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        manager.createNotificationChannel(channel);
        manager.deleteNotificationChannel("lightmoon_call"); // the first one, which rang without pauses
    }
}
