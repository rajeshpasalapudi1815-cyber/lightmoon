package app.lightmoon.assistant;

import android.Manifest;
import android.app.KeyguardManager;
import android.app.Notification;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

// The web app's switch for the wake word (see docs/js/native.js and WakeWordService).
@CapacitorPlugin(
    name = "WakeWord",
    permissions = { @Permission(strings = { Manifest.permission.RECORD_AUDIO }, alias = "microphone") }
)
public class WakeWordPlugin extends Plugin {

    private static final String PREFS = "lightmoon.wake";
    private static final String CHANNEL_HEARD = "reminders"; // high-importance channel made by SpeakService
    private static final int HEARD_NOTIFICATION = 3;

    // Set when "LightMoon" was heard; the app takes it when it opens and starts listening.
    static volatile boolean pendingWake;

    @PluginMethod
    public void status(PluginCall call) {
        call.resolve(currentStatus());
    }

    // Downloads the offline voice model if needed, reporting "modelProgress" { percent } as it goes.
    @PluginMethod
    public void prepare(PluginCall call) {
        if (WakeModel.ready(getContext())) {
            call.resolve(currentStatus());
            return;
        }
        new Thread(() -> {
            try {
                WakeModel.download(getContext(), percent -> {
                    JSObject progress = new JSObject();
                    progress.put("percent", percent);
                    notifyListeners("modelProgress", progress);
                });
                call.resolve(currentStatus());
            } catch (Exception err) {
                call.reject("Couldn't download the voice model. Check the internet connection and try again.");
            }
        }, "lightmoon-model-download").start();
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "microphoneAnswered");
        } else {
            begin(call);
        }
    }

    @PermissionCallback
    private void microphoneAnswered(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) begin(call);
        else call.reject("LightMoon needs the microphone to hear its name.");
    }

    private void begin(PluginCall call) {
        if (!WakeModel.ready(getContext())) {
            call.reject("The voice model isn't downloaded yet.");
            return;
        }
        setEnabled(getContext(), true);
        ContextCompat.startForegroundService(getContext(), new Intent(getContext(), WakeWordService.class));
        call.resolve(currentStatus());
    }

    @PluginMethod
    public void stop(PluginCall call) {
        setEnabled(getContext(), false);
        getContext().stopService(new Intent(getContext(), WakeWordService.class));
        call.resolve(currentStatus());
    }

    // Android only lets an app open itself from the background if it may "display over other apps".
    @PluginMethod
    public void openOverlaySettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + getContext().getPackageName()));
        getActivity().startActivity(intent);
        call.resolve();
    }

    @PluginMethod
    public void takeWake(PluginCall call) {
        JSObject result = new JSObject();
        result.put("wake", pendingWake);
        pendingWake = false;
        call.resolve(result);
    }

    private JSObject currentStatus() {
        Context context = getContext();
        JSObject status = new JSObject();
        status.put("modelReady", WakeModel.ready(context));
        status.put("enabled", isEnabled(context));
        status.put("listening", WakeWordService.running != null);
        status.put("microphone", ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED);
        status.put("canOpenItself", Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || Settings.canDrawOverlays(context));
        return status;
    }

    static boolean isEnabled(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean("enabled", false);
    }

    static void setEnabled(Context context, boolean on) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean("enabled", on).apply();
    }

    // Called when LightMoon opens: Android doesn't allow listening to start by itself after a restart,
    // so the wake word comes back on the next time the app is opened.
    static void resumeIfEnabled(Context context) {
        if (!isEnabled(context) || WakeWordService.running != null || !WakeModel.ready(context)) return;
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) return;
        try {
            ContextCompat.startForegroundService(context, new Intent(context, WakeWordService.class));
        } catch (IllegalStateException err) {
            // Not in the foreground after all; the next open will try again.
        }
    }

    // "LightMoon" was heard: open the app ready to listen. A locked phone asks to be unlocked first,
    // so nobody can talk to LightMoon from the lock screen.
    static void wakeUp(Context context) {
        pendingWake = true;
        KeyguardManager keyguard = context.getSystemService(KeyguardManager.class);
        Class<?> screen = keyguard.isKeyguardLocked() ? UnlockActivity.class : MainActivity.class;
        Intent open = new Intent(context, screen).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        // If Android blocks opening from the background, this notification is the way in.
        showHeard(context, open);
        try {
            context.startActivity(open);
        } catch (RuntimeException err) {
            // The notification stays.
        }
    }

    private static void showHeard(Context context, Intent open) {
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return;
        SpeakService.createChannels(context);
        PendingIntent tap = PendingIntent.getActivity(context, 3, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification notification = new NotificationCompat.Builder(context, CHANNEL_HEARD)
            .setSmallIcon(R.drawable.ic_stat_moon)
            .setContentTitle("Yes?")
            .setContentText("Tap to talk to LightMoon")
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setAutoCancel(true)
            .setTimeoutAfter(30_000)
            .setContentIntent(tap)
            .build();
        try {
            NotificationManagerCompat.from(context).notify(HEARD_NOTIFICATION, notification);
        } catch (SecurityException err) {
            // Notifications not allowed.
        }
    }

    static void clearHeard(Context context) {
        NotificationManagerCompat.from(context).cancel(HEARD_NOTIFICATION);
    }
}
