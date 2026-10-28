package app.lightmoon.assistant;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONException;
import org.json.JSONObject;

// The web app's way to the phone's alarms (see docs/js/native.js): it hands over the upcoming reminders
// with the words to say, and the phone speaks them at their time even when LightMoon is closed.
@CapacitorPlugin(
    name = "ReminderAlarms",
    permissions = { @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "notifications") }
)
public class ReminderAlarmsPlugin extends Plugin {

    private static volatile ReminderAlarmsPlugin active;

    @Override
    public void load() {
        active = this;
        SpeakService.createChannels(getContext());
    }

    @Override
    protected void handleOnDestroy() {
        if (active == this) active = null;
    }

    // An alarm went off while LightMoon is on screen: the app says it in the conversation instead.
    static boolean notifyDue(ReminderStore.Reminder reminder) {
        ReminderAlarmsPlugin plugin = active;
        if (plugin == null || !plugin.hasListeners("reminderDue")) return false;
        JSObject event = new JSObject();
        event.put("id", reminder.id);
        event.put("say", reminder.say);
        plugin.notifyListeners("reminderDue", event);
        return true;
    }

    // { reminders: [{ id, at, say, title, updated }], hideText } — the full list of upcoming reminders.
    @PluginMethod
    public void schedule(PluginCall call) {
        JSArray list = call.getArray("reminders", new JSArray());
        List<ReminderStore.Reminder> reminders = new ArrayList<>();
        try {
            for (int i = 0; i < list.length(); i++) {
                JSONObject item = list.getJSONObject(i);
                String id = item.optString("id");
                String say = item.optString("say");
                long at = item.optLong("at");
                if (id.isEmpty() || say.isEmpty() || at <= 0) continue;
                reminders.add(new ReminderStore.Reminder(id, item.optString("title"), say, at, item.optLong("updated")));
            }
        } catch (JSONException err) {
            call.reject("Reminders were in the wrong format.");
            return;
        }
        ReminderStore.replaceAll(getContext(), reminders, call.getBoolean("hideText", false));
        call.resolve();
    }

    // { url, spaceId, code } to check the synced copy for new reminders every 15 minutes, or {} to stop.
    @PluginMethod
    public void configureBackground(PluginCall call) {
        String url = call.getString("url");
        String spaceId = call.getString("spaceId");
        String code = call.getString("code");
        if (url == null || spaceId == null || code == null) {
            SyncWorker.stop(getContext());
        } else {
            SyncWorker.start(getContext(), url, spaceId, code);
        }
        call.resolve();
    }

    // Reminders the phone has spoken since the app last asked, so the app doesn't announce them again,
    // and whether LightMoon is on screen (when it isn't, the phone's alarms do the announcing).
    @PluginMethod
    public void takeSpoken(PluginCall call) {
        JSObject result = new JSObject();
        result.put("ids", new JSArray(ReminderStore.takeSpoken(getContext())));
        result.put("visible", MainActivity.visible);
        call.resolve(result);
    }

    // Says something in a minute, so the user can lock the phone and hear that it works.
    @PluginMethod
    public void test(PluginCall call) {
        String say = call.getString("say", "This is LightMoon. Spoken reminders are working.");
        long at = System.currentTimeMillis() + call.getInt("seconds", 60) * 1000L;
        ReminderStore.add(getContext(), new ReminderStore.Reminder("test-" + at, "Test", say, at, Long.MAX_VALUE));
        JSObject result = new JSObject();
        result.put("at", at);
        call.resolve(result);
    }

    @PluginMethod
    public void status(PluginCall call) {
        call.resolve(currentStatus());
    }

    @PluginMethod
    public void requestNotifications(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "notificationsAnswered");
        } else {
            call.resolve(currentStatus());
        }
    }

    @PermissionCallback
    private void notificationsAnswered(PluginCall call) {
        call.resolve(currentStatus());
    }

    // Some phones stop apps in the background to save battery; this asks to leave LightMoon alone.
    @SuppressLint("BatteryLife")
    @PluginMethod
    public void openBatterySettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
            .setData(Uri.parse("package:" + getContext().getPackageName()));
        try {
            getActivity().startActivity(intent);
        } catch (Exception err) {
            getActivity().startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
        }
        call.resolve();
    }

    private JSObject currentStatus() {
        PowerManager power = getContext().getSystemService(PowerManager.class);
        JSObject status = new JSObject();
        status.put("notifications", NotificationManagerCompat.from(getContext()).areNotificationsEnabled());
        status.put("exactAlarms", ReminderStore.canUseExactAlarms(getContext()));
        status.put("batteryUnrestricted", power.isIgnoringBatteryOptimizations(getContext().getPackageName()));
        status.put("backgroundSync", SyncWorker.isConfigured(getContext()));
        status.put("upcoming", ReminderStore.count(getContext()));
        return status;
    }
}
