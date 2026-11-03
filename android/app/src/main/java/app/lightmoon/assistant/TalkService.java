package app.lightmoon.assistant;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

// Keeps a conversation going when the screen goes off or LightMoon goes behind another app: while the user and
// LightMoon are talking (listening, thinking, speaking, or about to listen for the answer), this keeps the processor
// awake and holds a microphone service, which Android requires before an app out of sight may keep listening. It
// starts while LightMoon is on screen (Android doesn't let one start from the background) and ends a little after
// the conversation does. Its notification says so, with a Stop button. The wake word stays paused meanwhile, so it
// doesn't take the microphone away from the conversation (WakeWordService.update).
public class TalkService extends Service {

    static final String ACTION_STOP = "app.lightmoon.assistant.TALK_STOP";
    private static final String CHANNEL = "talk";
    private static final int NOTIFICATION = 7;
    private static final long MAX_TALK_MS = 30 * 60_000; // never kept awake longer than this, whatever happens

    static volatile boolean active = false;
    static volatile boolean stopAsked = false; // Stop was tapped on its notification

    private final Handler main = new Handler(Looper.getMainLooper());
    private PowerManager.WakeLock awake;

    // The page says a conversation started (true) or ended (false).
    static void set(Context context, boolean on) {
        Context app = context.getApplicationContext();
        if (on) {
            if (active) return;
            stopAsked = false;
            try {
                ContextCompat.startForegroundService(app, new Intent(app, TalkService.class));
            } catch (RuntimeException err) {
                // Out of sight already (Android refuses): the conversation goes on as far as it can.
            }
        } else if (active) {
            app.stopService(new Intent(app, TalkService.class));
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopAsked = true;
            WakeWordPlugin.talkStopped();
            stopSelf();
            return START_NOT_STICKY;
        }
        createChannel(this);
        try {
            int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
                ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE | ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK : 0;
            ServiceCompat.startForeground(this, NOTIFICATION, notification(), type);
        } catch (RuntimeException err) {
            stopSelf();
            return START_NOT_STICKY;
        }
        active = true;
        if (awake == null) {
            awake = getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "LightMoon:talk");
            awake.acquire(MAX_TALK_MS);
        }
        main.removeCallbacksAndMessages(null);
        main.postDelayed(this::stopSelf, MAX_TALK_MS);
        WakeWordService.appVisibilityChanged(); // the wake word keeps out of the way
        return START_NOT_STICKY;
    }

    private Notification notification() {
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent tap = PendingIntent.getActivity(this, 3, open, PendingIntent.FLAG_IMMUTABLE);
        PendingIntent stop = PendingIntent.getService(this, 4, new Intent(this, TalkService.class).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE);
        String text = "Keeps listening and talking with the screen off. It stops when you're done talking.";
        return new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_moon)
            .setContentTitle("Talking with you")
            .setContentText(text)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setOngoing(true)
            .setContentIntent(tap)
            .addAction(0, "Stop", stop)
            .build();
    }

    private static void createChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL, "Conversation", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Shown while LightMoon keeps a conversation going with the screen off");
        context.getSystemService(NotificationManager.class).createNotificationChannel(channel);
    }

    @Override
    public void onDestroy() {
        active = false;
        main.removeCallbacksAndMessages(null);
        if (awake != null && awake.isHeld()) awake.release();
        awake = null;
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        WakeWordService.appVisibilityChanged(); // the wake word may listen again
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
