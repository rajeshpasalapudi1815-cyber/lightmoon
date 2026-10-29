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
    private static final String KEY_ANSWERS = "answers";
    private static final String KEY_VOICE = "voice";
    private static final String KEY_RATE = "rate";
    private static final String KEY_SAY_AS = "sayAs";
    private static final String ACTION = "app.lightmoon.assistant.REMINDER";
    private static final long FORGET_ANSWERS_MS = 2 * 86_400_000L;

    // A task's reminder has the task's id; its check-ins add "-c1", "-c2"... (docs/js/announce.js).
    static String taskIdOf(String alertId) {
        return alertId == null ? "" : alertId.replaceFirst("-c\\d+$", "");
    }

    static boolean isTaskAlert(String alertId) {
        return alertId != null && alertId.matches("[a-z0-9]+(-c\\d+)?");
    }

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

    // The voice the app speaks with (an Android voice name, "" for the phone's British voice) and its speed, so
    // what the phone says by itself sounds the same (ReminderAlarmsPlugin.setVoice, Voice.useChosenVoice).
    // `sayAs`: the words the user taught LightMoon to say their way, as JSON ({ "Rajesh": "Raa-jesh" }); null keeps them.
    static void setVoice(Context context, String name, float rate, String sayAs) {
        SharedPreferences.Editor edit = prefs(context).edit().putString(KEY_VOICE, name == null ? "" : name).putFloat(KEY_RATE, rate);
        if (sayAs != null) edit.putString(KEY_SAY_AS, sayAs);
        edit.apply();
    }

    static String sayAs(Context context) {
        return prefs(context).getString(KEY_SAY_AS, "{}");
    }

    static String voiceName(Context context) {
        return prefs(context).getString(KEY_VOICE, "");
    }

    static float voiceRate(Context context) {
        return prefs(context).getFloat(KEY_RATE, 1f);
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

    // ---------- Answers given on a notification: Done, Snooze, Stop asking ----------
    // Kept for the app (it applies them to the task when it next runs) and for SyncWorker (it writes them into
    // the synced copy at once, so the user's other devices stop asking too). { id, action, at, until, uploaded }

    static synchronized void addAnswer(Context context, String taskId, String action, long at, long until) {
        JSONArray answers = answers(context);
        try {
            answers.put(new JSONObject().put("id", taskId).put("action", action).put("at", at).put("until", until).put("uploaded", false));
        } catch (JSONException ignored) {
            return;
        }
        prefs(context).edit().putString(KEY_ANSWERS, answers.toString()).apply();
    }

    // All answers the app hasn't applied yet, newest last.
    static synchronized JSONArray answers(Context context) {
        try {
            return new JSONArray(prefs(context).getString(KEY_ANSWERS, "[]"));
        } catch (JSONException err) {
            return new JSONArray();
        }
    }

    // For the app: every answer, once. Ones the app never collected are dropped after a couple of days.
    static synchronized JSONArray takeAnswers(Context context) {
        JSONArray answers = answers(context);
        prefs(context).edit().remove(KEY_ANSWERS).apply();
        return answers;
    }

    // Answers not yet written into the synced copy.
    static synchronized JSONArray answersToUpload(Context context) {
        JSONArray answers = answers(context);
        JSONArray waiting = new JSONArray();
        for (int i = 0; i < answers.length(); i++) {
            JSONObject answer = answers.optJSONObject(i);
            if (answer != null && !answer.optBoolean("uploaded")) waiting.put(answer);
        }
        return waiting;
    }

    // The answers given up to `upTo` are in the synced copy now (one given meanwhile waits for the next run).
    static synchronized void markAnswersUploaded(Context context, long upTo) {
        JSONArray answers = answers(context);
        JSONArray kept = new JSONArray();
        long now = System.currentTimeMillis();
        for (int i = 0; i < answers.length(); i++) {
            JSONObject answer = answers.optJSONObject(i);
            if (answer == null || answer.optLong("at") < now - FORGET_ANSWERS_MS) continue;
            try {
                kept.put(answer.optLong("at") <= upTo ? answer.put("uploaded", true) : answer);
            } catch (JSONException ignored) {
                // Leave it out.
            }
        }
        prefs(context).edit().putString(KEY_ANSWERS, kept.toString()).apply();
    }

    // No more alarms for a task: its reminder and check-ins (it was answered).
    static synchronized void dropTask(Context context, String taskId) {
        List<Reminder> left = new ArrayList<>();
        for (Reminder reminder : load(context).values()) {
            if (!taskIdOf(reminder.id).equals(taskId)) left.add(reminder);
        }
        replaceAll(context, left, hideText(context));
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
