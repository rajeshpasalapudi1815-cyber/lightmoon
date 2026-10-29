package app.lightmoon.assistant;

import android.Manifest;
import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.provider.CallLog;
import androidx.core.content.ContextCompat;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.DateFormat;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.Date;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

// The spoken briefings, at times the user picks in Settings → Phone, even with LightMoon closed:
//   morning: the weather, today's meetings and reminders, calls missed and messages received overnight
//   evening: tomorrow's meetings, reminders and weather
// BriefingReceiver hands the work to SpeakService, which builds the text here (it may fetch the weather)
// and says it at alarm volume, like a reminder.
final class Briefings {

    static final String MORNING = "morning";
    static final String EVENING = "evening";
    private static final String ACTION = "app.lightmoon.assistant.BRIEFING";
    private static final int MAX_NAMED = 3;

    private Briefings() {}

    // "07:00", or "" when off.
    static String time(Context context, String kind) {
        return PhonePrefs.get(context).getString("briefing_" + kind, "");
    }

    static void scheduleAll(Context context) {
        schedule(context, MORNING);
        schedule(context, EVENING);
    }

    // Sets the alarm for this briefing's next time (today if still ahead, else tomorrow), or clears it.
    static void schedule(Context context, String kind) {
        AlarmManager alarms = context.getSystemService(AlarmManager.class);
        PendingIntent operation = alarmIntent(context, kind);
        alarms.cancel(operation);
        String time = time(context, kind);
        if (!time.matches("\\d{2}:\\d{2}")) return;
        Calendar next = Calendar.getInstance();
        next.set(Calendar.HOUR_OF_DAY, Integer.parseInt(time.substring(0, 2)));
        next.set(Calendar.MINUTE, Integer.parseInt(time.substring(3)));
        next.set(Calendar.SECOND, 0);
        next.set(Calendar.MILLISECOND, 0);
        if (next.getTimeInMillis() <= System.currentTimeMillis() + 30_000) next.add(Calendar.DAY_OF_YEAR, 1);
        try {
            if (ReminderStore.canUseExactAlarms(context)) {
                PendingIntent show = PendingIntent.getActivity(context, 0, new Intent(context, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);
                alarms.setAlarmClock(new AlarmManager.AlarmClockInfo(next.getTimeInMillis(), show), operation);
            } else {
                alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, next.getTimeInMillis(), operation);
            }
        } catch (SecurityException ignored) {
            // Exact alarms not allowed: no briefing.
        }
    }

    private static PendingIntent alarmIntent(Context context, String kind) {
        Intent intent = new Intent(context, BriefingReceiver.class)
            .setAction(ACTION)
            .setData(Uri.parse("lightmoon://briefing/" + kind))
            .putExtra("kind", kind);
        return PendingIntent.getBroadcast(context, 0, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    // ---------- What to say (runs off the main thread: it may fetch the weather) ----------

    static String compose(Context context, String kind) {
        boolean morning = !EVENING.equals(kind);
        String address = PhonePrefs.address(context);
        Calendar day = Calendar.getInstance();
        if (!morning) day.add(Calendar.DAY_OF_YEAR, 1);
        long dayStart = startOf(day);
        long dayEnd = dayStart + 86_400_000L;
        long from = morning ? System.currentTimeMillis() : dayStart;
        String when = morning ? "today" : "tomorrow";

        List<String> parts = new ArrayList<>();
        parts.add((morning ? "Good morning, " : "Good evening, ") + address + ".");
        String weather = weather(context, morning ? 0 : 1, when);
        if (weather != null) parts.add(weather);
        parts.add(meetings(context, from, dayEnd, when));
        String reminders = reminders(context, from, dayEnd, when);
        if (reminders != null) parts.add(reminders);
        if (morning) {
            String calls = missedCalls(context, System.currentTimeMillis() - 12 * 3_600_000L);
            if (calls != null) parts.add(calls);
            String messages = newMessages(context, System.currentTimeMillis() - 10 * 3_600_000L);
            if (messages != null) parts.add(messages);
        }
        parts.add(morning ? "Have a good day." : "Sleep well.");
        parts.removeIf(String::isEmpty);
        return String.join(" ", parts);
    }

    private static long startOf(Calendar day) {
        Calendar start = (Calendar) day.clone();
        start.set(Calendar.HOUR_OF_DAY, 0);
        start.set(Calendar.MINUTE, 0);
        start.set(Calendar.SECOND, 0);
        start.set(Calendar.MILLISECOND, 0);
        return start.getTimeInMillis();
    }

    private static String clock(long ms) {
        return DateFormat.getTimeInstance(DateFormat.SHORT).format(new Date(ms));
    }

    private static String meetings(Context context, long from, long to, String when) {
        if (!Meetings.canRead(context)) return "";
        try {
            JSONArray events = Meetings.events(context, from, to);
            List<String> timed = new ArrayList<>();
            List<String> allDay = new ArrayList<>();
            for (int i = 0; i < events.length(); i++) {
                JSONObject e = events.getJSONObject(i);
                if (e.getBoolean("allDay")) allDay.add(e.getString("title"));
                else if (e.getLong("start") >= from) timed.add(e.getString("title") + " at " + clock(e.getLong("start")));
            }
            StringBuilder said = new StringBuilder();
            if (timed.isEmpty()) said.append("No meetings ").append(when).append(".");
            else {
                said.append(timed.size() == 1 ? "One meeting " + when + ": " : timed.size() + " meetings " + when + ". First, ");
                said.append(String.join(", then ", timed.subList(0, Math.min(timed.size(), MAX_NAMED)))).append(".");
            }
            if (!allDay.isEmpty()) said.append(" All day: ").append(String.join(", ", allDay.subList(0, Math.min(allDay.size(), MAX_NAMED)))).append(".");
            return said.toString();
        } catch (JSONException | RuntimeException err) {
            return "";
        }
    }

    private static String reminders(Context context, long from, long to, String when) {
        List<String> due = new ArrayList<>();
        for (ReminderStore.Reminder r : ReminderStore.all(context)) {
            if (r.at >= from && r.at < to && !r.id.startsWith("test-")) due.add(r.title + " at " + clock(r.at));
        }
        if (due.isEmpty()) return null;
        return "Reminders " + when + ": " + String.join(", ", due.subList(0, Math.min(due.size(), MAX_NAMED)))
            + (due.size() > MAX_NAMED ? ", and " + (due.size() - MAX_NAMED) + " more." : ".");
    }

    private static String missedCalls(Context context, long since) {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CALL_LOG) != PackageManager.PERMISSION_GRANTED) return null;
        Set<String> who = new LinkedHashSet<>();
        int count = 0;
        String[] columns = { CallLog.Calls.NUMBER, CallLog.Calls.CACHED_NAME };
        String where = CallLog.Calls.TYPE + " = " + CallLog.Calls.MISSED_TYPE + " AND " + CallLog.Calls.DATE + " >= ?";
        try (Cursor cursor = context.getContentResolver().query(CallLog.Calls.CONTENT_URI, columns, where, new String[] { String.valueOf(since) }, null)) {
            while (cursor != null && cursor.moveToNext()) {
                count++;
                String name = cursor.isNull(1) || cursor.getString(1).isEmpty() ? Contacts.nameFor(context, cursor.getString(0)) : cursor.getString(1);
                who.add(name == null ? "an unknown number" : name);
            }
        } catch (RuntimeException err) {
            return null;
        }
        if (count == 0) return null;
        return "You missed " + (count == 1 ? "a call" : count + " calls") + ", from " + names(who) + ".";
    }

    private static String newMessages(Context context, long since) {
        if (!MessageListener.isEnabled(context)) return null;
        try {
            JSONArray messages = MessageListener.recent(context, since);
            if (messages.length() == 0) return null;
            Set<String> who = new LinkedHashSet<>();
            for (int i = 0; i < messages.length(); i++) who.add(messages.getJSONObject(i).optString("from"));
            return (messages.length() == 1 ? "One new message" : messages.length() + " new messages") + ", from " + names(who) + ".";
        } catch (JSONException err) {
            return null;
        }
    }

    private static String names(Set<String> who) {
        List<String> list = new ArrayList<>(who);
        if (list.size() > MAX_NAMED) {
            int others = list.size() - MAX_NAMED;
            list = new ArrayList<>(list.subList(0, MAX_NAMED));
            list.add(others + (others == 1 ? " other" : " others"));
        }
        if (list.size() == 1) return list.get(0);
        return String.join(", ", list.subList(0, list.size() - 1)) + " and " + list.get(list.size() - 1);
    }

    // "In Hyderabad today, 22 to 33 degrees, partly cloudy, with a 60 percent chance of rain." (Open-Meteo, no key)
    private static String weather(Context context, int dayOffset, String when) {
        SharedPreferences prefs = PhonePrefs.get(context);
        String lat = prefs.getString("placeLat", "");
        String lon = prefs.getString("placeLon", "");
        if (lat.isEmpty() || lon.isEmpty()) return null;
        String place = prefs.getString("placeName", "");
        try {
            URL url = new URL("https://api.open-meteo.com/v1/forecast?latitude=" + lat + "&longitude=" + lon
                + "&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code&timezone=auto&forecast_days=2");
            JSONObject daily = new JSONObject(download(url)).getJSONObject("daily");
            long max = Math.round(daily.getJSONArray("temperature_2m_max").getDouble(dayOffset));
            long min = Math.round(daily.getJSONArray("temperature_2m_min").getDouble(dayOffset));
            int rain = daily.getJSONArray("precipitation_probability_max").optInt(dayOffset, 0);
            String sky = sky(daily.getJSONArray("weather_code").optInt(dayOffset, 0));
            String where = place.isEmpty() || "your location".equals(place) ? "" : "In " + place + " ";
            return (where.isEmpty() ? "The weather " + when + ": " : where + when + ", ")
                + min + " to " + max + " degrees, " + sky + (rain >= 40 ? ", with a " + rain + " percent chance of rain." : ".");
        } catch (Exception err) {
            return null; // offline or the service is down: skip the weather
        }
    }

    private static String sky(int code) {
        if (code == 0) return "clear";
        if (code <= 3) return "partly cloudy";
        if (code == 45 || code == 48) return "foggy";
        if (code >= 51 && code <= 57) return "drizzly";
        if (code >= 61 && code <= 67) return "rainy";
        if (code >= 71 && code <= 77) return "snowy";
        if (code >= 80 && code <= 82) return "with showers";
        if (code >= 95) return "with thunderstorms";
        return "mixed";
    }

    private static String download(URL url) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setConnectTimeout(8_000);
        connection.setReadTimeout(8_000);
        try (InputStream in = connection.getInputStream()) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            for (int read; (read = in.read(buffer)) != -1; ) out.write(buffer, 0, read);
            return out.toString(StandardCharsets.UTF_8.name());
        } finally {
            connection.disconnect();
        }
    }
}
