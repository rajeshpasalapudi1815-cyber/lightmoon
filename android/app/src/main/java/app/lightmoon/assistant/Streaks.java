package app.lightmoon.assistant;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Base64;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

// The streak guard: once an evening (from the time in Settings → Phone, 9 pm unless changed), if Life Levelling's
// latest summary from today shows habits still open, the phone says so once, gently, even with LightMoon closed:
// "Sir, your reading and walk habits are still open tonight. Your streak is 12 days." SyncWorker calls it every
// 15 minutes. It reads the summary Life Levelling shares in the sync space (encrypted with the sync code, like
// docs/js/lifelevelling.js reads it) and never changes anything there.
final class Streaks {

    private static final String SAID_ON = "streakSaidOn";
    private static final int WINDOW_HOURS = 2; // from the chosen time; later than that it stays quiet

    private Streaks() {}

    // "21:00", or "" when switched off.
    static String time(Context context) {
        return PhonePrefs.get(context).getString("streakGuard", "21:00");
    }

    static void checkNow(Context context, String feedAddress, String code) {
        SharedPreferences prefs = PhonePrefs.get(context);
        String today = SyncWorker.localStamp(System.currentTimeMillis()).substring(0, 10);
        if (today.equals(prefs.getString(SAID_ON, "")) || !due(time(context), Calendar.getInstance())) return;
        try {
            String body = SyncWorker.fetch(feedAddress);
            if (body == null) return;
            JSONObject feed = new JSONObject(body);
            JSONObject summary = new JSONObject(CloudCrypto.decrypt(code, Base64.decode(feed.getString("blob"), Base64.DEFAULT)));
            String say = compose(summary, PhonePrefs.address(context), System.currentTimeMillis());
            if (say == null) return;
            if (!PhonePrefs.maySpeakNow(context) || Focus.active(context)) return; // try again in 15 minutes
            prefs.edit().putString(SAID_ON, today).apply();
            Voice.say(context, say, null);
        } catch (Exception err) {
            // Offline, or a summary written with another code: try again on the next run.
        }
    }

    // Whether now is within the evening window that starts at "HH:MM".
    static boolean due(String time, Calendar now) {
        if (time == null || !time.matches("\\d{2}:\\d{2}")) return false;
        int start = Integer.parseInt(time.substring(0, 2)) * 60 + Integer.parseInt(time.substring(3));
        int minute = now.get(Calendar.HOUR_OF_DAY) * 60 + now.get(Calendar.MINUTE);
        return minute >= start && minute < start + WINDOW_HOURS * 60;
    }

    // What to say about today's open habits, or null when there's nothing to say (all done, none, or the summary
    // isn't from today, so it can't tell what was done).
    static String compose(JSONObject summary, String address, long now) {
        if (summary.optBoolean("disconnected")) return null;
        long made = summary.optLong("generatedAt");
        if (made <= 0 || !SyncWorker.localStamp(made).substring(0, 10).equals(SyncWorker.localStamp(now).substring(0, 10))) return null;
        JSONArray habits = summary.optJSONArray("habits");
        if (habits == null) return null;
        List<String> open = new ArrayList<>();
        for (int i = 0; i < habits.length(); i++) {
            JSONObject h = habits.optJSONObject(i);
            if (h == null) continue;
            String status = h.optString("status");
            if ("done".equals(status) || "over".equals(status) || "limit".equals(h.optString("kind"))) continue;
            String name = h.optString("name").trim();
            if (!name.isEmpty()) open.add(name.toLowerCase(java.util.Locale.ROOT));
        }
        if (open.isEmpty()) return null;
        // Life Levelling only updates its summary while it's open, so say what it shows, not what was done.
        String which = open.size() == 1 ? "your " + open.get(0) + " habit"
            : open.size() <= 3 ? "your " + String.join(", ", open.subList(0, open.size() - 1)) + " and " + open.get(open.size() - 1) + " habits"
            : open.size() + " of your habits";
        JSONObject you = summary.optJSONObject("you");
        int streak = you == null ? 0 : you.optInt("streak");
        return address + ", Life Levelling still shows " + which + " open tonight."
            + (streak >= 2 ? " Your streak is " + streak + " days; there's still time." : " There's still time.");
    }
}
