package app.lightmoon.assistant;

import android.Manifest;
import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.provider.CalendarContract;
import androidx.core.content.ContextCompat;
import java.text.DateFormat;
import java.util.Date;
import java.util.Iterator;
import java.util.TimeZone;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

// The phone's calendar (Google Calendar and the rest): reading meetings, adding them, and saying each one
// out loud a few minutes before it starts, even with LightMoon closed. The alarms are set again whenever
// the app opens, every 15 minutes (MeetingWorker) and after a restart (BootReceiver).
final class Meetings {

    private static final String PREFS = "lightmoon.meetings";
    private static final String KEY_SAY = "say"; // alarm id -> what to say
    private static final String ACTION = "app.lightmoon.assistant.MEETING";
    private static final long LOOK_AHEAD_MS = 26 * 3_600_000L;

    private Meetings() {}

    static boolean canRead(Context context) {
        return ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CALENDAR) == PackageManager.PERMISSION_GRANTED;
    }

    static boolean canWrite(Context context) {
        return ContextCompat.checkSelfPermission(context, Manifest.permission.WRITE_CALENDAR) == PackageManager.PERMISSION_GRANTED;
    }

    // [{ id, title, start, end, allDay, location, calendar }] between two times (ms), soonest first.
    static JSONArray events(Context context, long from, long to) throws JSONException {
        JSONArray result = new JSONArray();
        if (!canRead(context)) return result;
        Uri.Builder range = CalendarContract.Instances.CONTENT_URI.buildUpon();
        ContentUris.appendId(range, from);
        ContentUris.appendId(range, to);
        String[] columns = {
            CalendarContract.Instances.EVENT_ID,
            CalendarContract.Instances.TITLE,
            CalendarContract.Instances.BEGIN,
            CalendarContract.Instances.END,
            CalendarContract.Instances.ALL_DAY,
            CalendarContract.Instances.EVENT_LOCATION,
            CalendarContract.Instances.CALENDAR_DISPLAY_NAME,
            CalendarContract.Instances.SELF_ATTENDEE_STATUS,
        };
        String visible = CalendarContract.Instances.VISIBLE + " = 1";
        try (Cursor cursor = context.getContentResolver().query(range.build(), columns, visible, null, CalendarContract.Instances.BEGIN + " ASC")) {
            while (cursor != null && cursor.moveToNext()) {
                if (cursor.getInt(7) == CalendarContract.Attendees.ATTENDEE_STATUS_DECLINED) continue;
                result.put(new JSONObject()
                    .put("id", cursor.getLong(0))
                    .put("title", cursor.isNull(1) ? "(no title)" : cursor.getString(1))
                    .put("start", cursor.getLong(2))
                    .put("end", cursor.getLong(3))
                    .put("allDay", cursor.getInt(4) == 1)
                    .put("location", cursor.isNull(5) ? "" : cursor.getString(5))
                    .put("calendar", cursor.isNull(6) ? "" : cursor.getString(6)));
            }
        }
        return result;
    }

    // Adds an event to the user's main calendar, with the phone's own reminder too. Returns its id.
    static long add(Context context, String title, long start, long end, String location, String notes) {
        long calendarId = mainCalendar(context);
        if (calendarId < 0) throw new IllegalStateException("No calendar on this phone can take new events.");
        ContentValues event = new ContentValues();
        event.put(CalendarContract.Events.CALENDAR_ID, calendarId);
        event.put(CalendarContract.Events.TITLE, title);
        event.put(CalendarContract.Events.DTSTART, start);
        event.put(CalendarContract.Events.DTEND, end);
        event.put(CalendarContract.Events.EVENT_TIMEZONE, TimeZone.getDefault().getID());
        if (location != null && !location.isEmpty()) event.put(CalendarContract.Events.EVENT_LOCATION, location);
        if (notes != null && !notes.isEmpty()) event.put(CalendarContract.Events.DESCRIPTION, notes);
        Uri created = context.getContentResolver().insert(CalendarContract.Events.CONTENT_URI, event);
        if (created == null) throw new IllegalStateException("The calendar didn't take the event.");
        long id = ContentUris.parseId(created);
        ContentValues reminder = new ContentValues();
        reminder.put(CalendarContract.Reminders.EVENT_ID, id);
        reminder.put(CalendarContract.Reminders.MINUTES, Math.max(PhonePrefs.meetingLead(context), 10));
        reminder.put(CalendarContract.Reminders.METHOD, CalendarContract.Reminders.METHOD_ALERT);
        context.getContentResolver().insert(CalendarContract.Reminders.CONTENT_URI, reminder);
        reschedule(context);
        return id;
    }

    // The calendar new events go into: the main (primary) one the user can write to, shown in their calendar app.
    private static long mainCalendar(Context context) {
        String[] columns = { CalendarContract.Calendars._ID, CalendarContract.Calendars.IS_PRIMARY };
        String writable = CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL + " >= " + CalendarContract.Calendars.CAL_ACCESS_CONTRIBUTOR
            + " AND " + CalendarContract.Calendars.VISIBLE + " = 1";
        long fallback = -1;
        try (Cursor cursor = context.getContentResolver().query(CalendarContract.Calendars.CONTENT_URI, columns, writable, null, null)) {
            while (cursor != null && cursor.moveToNext()) {
                if (cursor.getInt(1) == 1) return cursor.getLong(0);
                if (fallback < 0) fallback = cursor.getLong(0);
            }
        }
        return fallback;
    }

    // Sets an alarm to announce each meeting in the next day, replacing the previous set.
    static synchronized void reschedule(Context context) {
        AlarmManager alarms = context.getSystemService(AlarmManager.class);
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        JSONObject old = parse(prefs.getString(KEY_SAY, "{}"));
        for (Iterator<String> ids = old.keys(); ids.hasNext(); ) alarms.cancel(alarmIntent(context, ids.next()));

        JSONObject next = new JSONObject();
        int lead = PhonePrefs.meetingLead(context);
        if (lead > 0 && canRead(context)) {
            long now = System.currentTimeMillis();
            try {
                JSONArray upcoming = events(context, now, now + LOOK_AHEAD_MS);
                for (int i = 0; i < upcoming.length(); i++) {
                    JSONObject meeting = upcoming.getJSONObject(i);
                    if (meeting.getBoolean("allDay")) continue;
                    long start = meeting.getLong("start");
                    long at = start - lead * 60_000L;
                    if (at <= now) continue;
                    String id = meeting.getLong("id") + "@" + start;
                    next.put(id, sayFor(context, meeting, lead));
                    setAlarm(context, alarms, id, at);
                }
            } catch (JSONException | RuntimeException ignored) {
                // Calendar unreadable right now: try again at the next refresh.
            }
        }
        prefs.edit().putString(KEY_SAY, next.toString()).apply();
    }

    static String sayFor(Context context, String id) {
        JSONObject all = parse(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_SAY, "{}"));
        return all.optString(id, null);
    }

    // "Sir, in 10 minutes: Team stand-up, at 10:30, in Room 4."
    private static String sayFor(Context context, JSONObject meeting, int lead) throws JSONException {
        String time = DateFormat.getTimeInstance(DateFormat.SHORT).format(new Date(meeting.getLong("start")));
        String location = meeting.optString("location");
        return PhonePrefs.address(context) + ", in " + lead + " minutes: " + meeting.getString("title") + ", at " + time
            + (location.isEmpty() ? "" : ", in " + location) + ".";
    }

    private static void setAlarm(Context context, AlarmManager alarms, String id, long at) {
        PendingIntent operation = alarmIntent(context, id);
        try {
            if (ReminderStore.canUseExactAlarms(context)) {
                Intent open = new Intent(context, MainActivity.class);
                PendingIntent show = PendingIntent.getActivity(context, 0, open, PendingIntent.FLAG_IMMUTABLE);
                alarms.setAlarmClock(new AlarmManager.AlarmClockInfo(at, show), operation);
            } else {
                alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, operation);
            }
        } catch (SecurityException ignored) {
            // Exact alarms not allowed: this meeting won't be announced.
        }
    }

    private static PendingIntent alarmIntent(Context context, String id) {
        Intent intent = new Intent(context, MeetingReceiver.class)
            .setAction(ACTION)
            .setData(Uri.parse("lightmoon://meeting/" + Uri.encode(id)))
            .putExtra("id", id);
        return PendingIntent.getBroadcast(context, 0, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private static JSONObject parse(String text) {
        try {
            return new JSONObject(text);
        } catch (JSONException err) {
            return new JSONObject();
        }
    }
}
