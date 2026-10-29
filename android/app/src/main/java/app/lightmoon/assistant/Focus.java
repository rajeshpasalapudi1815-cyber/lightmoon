package app.lightmoon.assistant;

import android.Manifest;
import android.app.AlarmManager;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.provider.CallLog;
import androidx.core.content.ContextCompat;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;

// Focus mode ("focus for 45 minutes"): LightMoon holds its call and message announcements, except for the people
// the user lets through, and, if asked and Android allows it, puts the phone on Do Not Disturb. When the time is
// up (FocusReceiver) or the user ends it, the phone goes back as it was and LightMoon says what came in meanwhile.
final class Focus {

    private static final String KEY_UNTIL = "focusUntil";
    private static final String KEY_SINCE = "focusSince";
    private static final String KEY_ALLOW = "focusAllow";
    private static final String KEY_FILTER = "focusPreviousFilter"; // Do Not Disturb as it was; -1 when not changed
    private static final String ACTION = "app.lightmoon.assistant.FOCUS_END";

    private Focus() {}

    static long until(Context context) {
        return PhonePrefs.get(context).getLong(KEY_UNTIL, 0);
    }

    static boolean active(Context context) {
        return until(context) > System.currentTimeMillis();
    }

    // Whether a call or message from `who` is announced now: always outside focus; during it, only from the people
    // the user let through, matched loosely ("mom" lets "Mom" and "Mom mobile" through).
    static boolean letsThrough(Context context, String who) {
        if (!active(context)) return true;
        String name = who == null ? "" : who.trim().toLowerCase(Locale.ROOT);
        if (name.isEmpty()) return false;
        for (String allowed : PhonePrefs.get(context).getString(KEY_ALLOW, "").split(",")) {
            String person = allowed.trim().toLowerCase(Locale.ROOT);
            if (!person.isEmpty() && (name.contains(person) || person.contains(name))) return true;
        }
        return false;
    }

    // Starts (or extends) focus until `until`. Returns whether Do Not Disturb went on: that needs the user's
    // permission, given on Android's own screen (PhonePlugin.openSilenceAccess).
    static boolean start(Context context, long until, String allow, boolean quiet) {
        SharedPreferences prefs = PhonePrefs.get(context);
        boolean already = active(context);
        int previous = prefs.getInt(KEY_FILTER, -1);
        boolean dnd = false;
        NotificationManager notifications = context.getSystemService(NotificationManager.class);
        if (quiet && notifications.isNotificationPolicyAccessGranted()) {
            int now = notifications.getCurrentInterruptionFilter();
            try {
                notifications.setInterruptionFilter(NotificationManager.INTERRUPTION_FILTER_PRIORITY);
                dnd = true;
                if (previous < 0) previous = now; // extending: keep how the phone was before the first one
            } catch (RuntimeException ignored) {
                // Android refused (e.g. a work profile rule): focus still holds LightMoon's own announcements.
            }
        }
        prefs.edit()
            .putLong(KEY_UNTIL, until)
            .putLong(KEY_SINCE, already ? prefs.getLong(KEY_SINCE, System.currentTimeMillis()) : System.currentTimeMillis())
            .putString(KEY_ALLOW, allow == null ? "" : allow)
            .putInt(KEY_FILTER, previous)
            .apply();
        AlarmManager alarms = context.getSystemService(AlarmManager.class);
        if (ReminderStore.canUseExactAlarms(context)) alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, until, endIntent(context));
        else alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, until, endIntent(context));
        return dnd;
    }

    // Ends focus: Do Not Disturb back as it was, and what came in meanwhile as one sentence (null if it wasn't on).
    static String end(Context context) {
        SharedPreferences prefs = PhonePrefs.get(context);
        long since = prefs.getLong(KEY_SINCE, 0);
        int previous = prefs.getInt(KEY_FILTER, -1);
        context.getSystemService(AlarmManager.class).cancel(endIntent(context));
        if (previous >= 0) {
            NotificationManager notifications = context.getSystemService(NotificationManager.class);
            try {
                if (notifications.isNotificationPolicyAccessGranted()) notifications.setInterruptionFilter(previous);
            } catch (RuntimeException ignored) {
                // The user changed Do Not Disturb themselves meanwhile: leave it as they set it.
            }
        }
        prefs.edit().remove(KEY_UNTIL).remove(KEY_SINCE).remove(KEY_ALLOW).remove(KEY_FILTER).apply();
        return since > 0 ? summary(context, since) : null;
    }

    // After a restart: focus that should still be on gets its end alarm back; focus that ran out meanwhile ends.
    static void restore(Context context) {
        long until = until(context);
        if (until == 0) return;
        if (until > System.currentTimeMillis()) {
            AlarmManager alarms = context.getSystemService(AlarmManager.class);
            alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, until, endIntent(context));
        } else {
            end(context);
        }
    }

    // "Sir, focus time is over. While you focused: 2 missed calls, from Mom and Asha; and 3 messages, from Team."
    private static String summary(Context context, long since) {
        List<String> callers = missedCallers(context, since);
        List<String> senders = MessageListener.sendersSince(context, since);
        String start = PhonePrefs.address(context) + ", focus time is over.";
        if (callers.isEmpty() && senders.isEmpty()) return start + " Nothing came in while you focused.";
        StringBuilder say = new StringBuilder(start).append(" While you focused: ");
        if (!callers.isEmpty()) {
            say.append(callers.size()).append(callers.size() == 1 ? " missed call, from " : " missed calls, from ").append(names(callers));
        }
        if (!callers.isEmpty() && !senders.isEmpty()) say.append("; and ");
        if (!senders.isEmpty()) {
            say.append(senders.size()).append(senders.size() == 1 ? " message, from " : " messages, from ").append(names(senders));
        }
        return say.append('.').toString();
    }

    private static String names(List<String> people) {
        List<String> distinct = new ArrayList<>(new LinkedHashSet<>(people));
        if (distinct.size() > 4) {
            int more = distinct.size() - 3;
            distinct = new ArrayList<>(distinct.subList(0, 3));
            distinct.add(more + " others");
        }
        if (distinct.size() == 1) return distinct.get(0);
        return String.join(", ", distinct.subList(0, distinct.size() - 1)) + " and " + distinct.get(distinct.size() - 1);
    }

    private static List<String> missedCallers(Context context, long since) {
        List<String> callers = new ArrayList<>();
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CALL_LOG) != PackageManager.PERMISSION_GRANTED) return callers;
        String[] columns = { CallLog.Calls.CACHED_NAME, CallLog.Calls.NUMBER };
        String where = CallLog.Calls.TYPE + " = ? AND " + CallLog.Calls.DATE + " >= ?";
        String[] args = { String.valueOf(CallLog.Calls.MISSED_TYPE), String.valueOf(since) };
        try (Cursor cursor = context.getContentResolver().query(CallLog.Calls.CONTENT_URI, columns, where, args, CallLog.Calls.DATE)) {
            while (cursor != null && cursor.moveToNext()) {
                String name = cursor.getString(0);
                String number = cursor.getString(1);
                callers.add(name != null && !name.isEmpty() ? name : number != null && !number.isEmpty() ? number : "a hidden number");
            }
        } catch (RuntimeException ignored) {
            // No call log on this phone: say nothing about calls.
        }
        return callers;
    }

    private static PendingIntent endIntent(Context context) {
        Intent intent = new Intent(context, FocusReceiver.class).setAction(ACTION);
        return PendingIntent.getBroadcast(context, 0, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }
}
