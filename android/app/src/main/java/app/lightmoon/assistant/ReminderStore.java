package app.lightmoon.assistant;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

// The reminders this phone should speak, with an Android alarm set for each so they go off on time
// even when LightMoon is closed or the phone is asleep. BootReceiver sets them again after a restart.
final class ReminderStore {

    static final class Reminder {
        final String id;
        final String title;
        final String say;
        final long at;
        final long updated; // when the task last changed, so an older synced copy can't undo a newer edit

        Reminder(String id, String title, String say, long at, long updated) {
            this.id = id;
            this.title = title;
            this.say = say;
            this.at = at;
            this.updated = updated;
        }

        JSONObject toJson() throws JSONException {
            return new JSONObject().put("id", id).put("title", title).put("say", say).put("at", at).put("updated", updated);
        }

        static Reminder fromJson(JSONObject json) {
            return new Reminder(json.optString("id"), json.optString("title"), json.optString("say"), json.optLong("at"), json.optLong("updated"));
        }
    }

    private static final String PREFS = "lightmoon.reminders";
    private static final String KEY_LIST = "reminders";
    private static final String KEY_HIDE_TEXT = "hideText";
    private static final String KEY_SPOKEN = "spoken";
    private static final String ACTION = "app.lightmoon.assistant.REMINDER";

    private ReminderStore() {}

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    // Replaces the whole set of upcoming reminders (the app and the background sync both know the full list).
    static synchronized void replaceAll(Context context, List<Reminder> reminders, boolean hideText) {
        AlarmManager alarms = context.getSystemService(AlarmManager.class);
        for (Reminder old : load(context).values()) alarms.cancel(alarmIntent(context, old.id));
        long now = System.currentTimeMillis();
        JSONArray saved = new JSONArray();
        for (Reminder reminder : reminders) {
            if (reminder.at <= now) continue;
            try {
                saved.put(reminder.toJson());
                setAlarm(context, alarms, reminder);
            } catch (JSONException | SecurityException ignored) {
                // Skip a reminder that can't be stored or scheduled.
            }
        }
        prefs(context).edit().putString(KEY_LIST, saved.toString()).putBoolean(KEY_HIDE_TEXT, hideText).apply();
    }

    // Adds one reminder without touching the others (used by the "test" button).
    static synchronized void add(Context context, Reminder reminder) {
        Map<String, Reminder> all = load(context);
        all.put(reminder.id, reminder);
        replaceAll(context, new ArrayList<>(all.values()), hideText(context));
    }

    static synchronized void rescheduleAll(Context context) {
        replaceAll(context, all(context), hideText(context));
    }

    static synchronized List<Reminder> all(Context context) {
        return new ArrayList<>(load(context).values());
    }

    static synchronized Reminder get(Context context, String id) {
        return load(context).get(id);
    }

    static int count(Context context) {
        return all(context).size();
    }

    static boolean hideText(Context context) {
        return prefs(context).getBoolean(KEY_HIDE_TEXT, false);
    }

    static boolean canUseExactAlarms(Context context) {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.S || context.getSystemService(AlarmManager.class).canScheduleExactAlarms();
    }

    // Reminders spoken while the app was closed, so the app doesn't announce them again when it opens.
    static synchronized void markSpoken(Context context, String id) {
        Set<String> spoken = new HashSet<>(prefs(context).getStringSet(KEY_SPOKEN, new HashSet<>()));
        spoken.add(id);
        prefs(context).edit().putStringSet(KEY_SPOKEN, spoken).apply();
    }

    static synchronized List<String> takeSpoken(Context context) {
        List<String> spoken = new ArrayList<>(prefs(context).getStringSet(KEY_SPOKEN, new HashSet<>()));
        prefs(context).edit().remove(KEY_SPOKEN).apply();
        return spoken;
    }

    private static Map<String, Reminder> load(Context context) {
        Map<String, Reminder> reminders = new LinkedHashMap<>();
        try {
            JSONArray list = new JSONArray(prefs(context).getString(KEY_LIST, "[]"));
            for (int i = 0; i < list.length(); i++) {
                Reminder reminder = Reminder.fromJson(list.getJSONObject(i));
                reminders.put(reminder.id, reminder);
            }
        } catch (JSONException ignored) {
            // Corrupt list: start again empty.
        }
        return reminders;
    }

    // An alarm-clock alarm: Android wakes the phone for it exactly on time, even in deep sleep.
    private static void setAlarm(Context context, AlarmManager alarms, Reminder reminder) {
        PendingIntent operation = alarmIntent(context, reminder.id);
        if (canUseExactAlarms(context)) {
            Intent open = new Intent(context, MainActivity.class);
            PendingIntent show = PendingIntent.getActivity(context, 0, open, PendingIntent.FLAG_IMMUTABLE);
            alarms.setAlarmClock(new AlarmManager.AlarmClockInfo(reminder.at, show), operation);
        } else {
            // Exact alarms switched off for LightMoon (possible on Android 12): still goes off, a little late.
            alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, reminder.at, operation);
        }
    }

    // One alarm per reminder: the reminder id in the data URI keeps the intents distinct.
    static PendingIntent alarmIntent(Context context, String id) {
        Intent intent = new Intent(context, AlarmReceiver.class)
            .setAction(ACTION)
            .setData(Uri.parse("lightmoon://reminder/" + Uri.encode(id)))
            .putExtra("id", id);
        return PendingIntent.getBroadcast(context, 0, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }
}
