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
import android.os.Build;
import android.os.SystemClock;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

// The morning briefing as a phone call (Settings → Phone → Morning briefing → "as a call"): at the briefing time the
// phone rings with a LightMoon call screen (CallActivity), on the lock screen too, and a watch paired with the phone
// buzzes with it. Answering opens LightMoon, which gives the day's briefing and plan aloud and listens for the reply
// (docs/app.js, launch action "call"). Declined: nothing more. Not answered within RING_MS: a "missed call" note,
// which plays the briefing when tapped.
public class MorningCall extends BroadcastReceiver {

    static final String CHANNEL = "lightmoon_call";
    static final int NOTIFICATION = 11;
    private static final int MISSED_NOTIFICATION = 12;
    static final long RING_MS = 45_000;
    static final String ACTION_DECLINE = "app.lightmoon.assistant.CALL_DECLINE";
    private static final String ACTION_MISSED = "app.lightmoon.assistant.CALL_MISSED";

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
            .setContentText("Your morning call")
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
        call.flags |= Notification.FLAG_INSISTENT; // rings until answered, declined or timed out
        try {
            NotificationManagerCompat.from(app).notify(NOTIFICATION, call);
        } catch (SecurityException err) {
            ringing = false; // notifications are off: no call
            return;
        }
        PendingIntent missed = PendingIntent.getBroadcast(app, 23, new Intent(app, MorningCall.class).setAction(ACTION_MISSED),
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        app.getSystemService(AlarmManager.class).set(AlarmManager.ELAPSED_REALTIME_WAKEUP, SystemClock.elapsedRealtime() + RING_MS + 1000, missed);
    }

    // Stops the ringing (answered, declined or missed).
    static void stop(Context context) {
        ringing = false;
        NotificationManagerCompat.from(context).cancel(NOTIFICATION);
    }

    // Answered: LightMoon opens with the call waiting for it (WakeWordPlugin.takeWake -> call).
    static void answered(Context context) {
        stop(context);
        NotificationManagerCompat.from(context).cancel(MISSED_NOTIFICATION);
        WakeWordPlugin.pendingWake = true;
        WakeWordPlugin.pendingCall = true;
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if (ACTION_DECLINE.equals(action)) {
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

    static void createChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL, "Morning call", NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription("LightMoon calling you with your morning briefing");
        channel.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE), new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build());
        channel.enableVibration(true);
        channel.setVibrationPattern(new long[] { 0, 800, 600, 800, 600 });
        channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        channel.setBypassDnd(false);
        context.getSystemService(NotificationManager.class).createNotificationChannel(channel);
    }
}
