package app.lightmoon.assistant;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Base64;
import androidx.annotation.NonNull;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.ParseException;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.Date;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

// With sync on, checks the encrypted cloud copy every 15 minutes (Android's shortest interval) and sets
// alarms for reminders made on the user's other devices, and for their check-ins, so the phone speaks them
// even if LightMoon hasn't been opened. Reads the copy exactly as the web app writes it (docs/js/store.js,
// cloud.js). Answers given on this phone's notifications (ReminderActionReceiver) are written into the copy
// first, right after they're given, so the user's other devices stop asking too.
public class SyncWorker extends Worker {

    private static final String PREFS = "lightmoon.sync";
    private static final String WORK_NAME = "lightmoon-sync";
    private static final String ANSWER_WORK_NAME = "lightmoon-answer";
    // Checking in after a reminder: the same rules and words as docs/js/announce.js. Change both together.
    static final int[] CHECK_IN_MINUTES = {15, 45, 90};
    private static final int QUIET_FROM_HOUR = 23;
    private static final int QUIET_UNTIL_HOUR = 7;

    public SyncWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static Constraints online() {
        return new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
    }

    static void start(Context context, String url, String spaceId, String code) {
        prefs(context).edit().putString("url", url).putString("spaceId", spaceId).putString("code", code).apply();
        PeriodicWorkRequest request = new PeriodicWorkRequest.Builder(SyncWorker.class, 15, TimeUnit.MINUTES)
            .setConstraints(online())
            .build();
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(WORK_NAME, ExistingPeriodicWorkPolicy.KEEP, request);
    }

    static void stop(Context context) {
        prefs(context).edit().clear().apply();
        WorkManager.getInstance(context).cancelUniqueWork(WORK_NAME);
    }

    static boolean isConfigured(Context context) {
        return prefs(context).contains("code");
    }

    // One run as soon as the phone is online, after an answer on a notification.
    static void runSoon(Context context) {
        if (!isConfigured(context)) return;
        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(SyncWorker.class).setConstraints(online()).build();
        WorkManager.getInstance(context).enqueueUniqueWork(ANSWER_WORK_NAME, ExistingWorkPolicy.APPEND_OR_REPLACE, request);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context context = getApplicationContext();
        SharedPreferences sync = prefs(context);
        String url = sync.getString("url", null);
        String spaceId = sync.getString("spaceId", null);
        String code = sync.getString("code", null);
        if (url == null || spaceId == null || code == null) return Result.success();
        try {
            String space = url.replaceAll("/+$", "") + "/spaces/" + spaceId;
            Streaks.checkNow(context, space + "/feeds/lifelevelling", code);
            Steps.today(context); // keeps the day's starting point close to midnight
            JSONObject data = downloadWithAnswers(context, space + "/data", code);
            if (data == null) return Result.success(); // nothing synced yet
            ReminderStore.replaceAll(context, merge(data, ReminderStore.all(context)), ReminderStore.hideText(context));
            return Result.success();
        } catch (IOException err) {
            return Result.retry();
        } catch (Exception err) {
            return Result.failure(); // unreadable copy (e.g. the code changed); the next run tries again
        }
    }

    // The synced copy, with this phone's notification answers written into it first (with the cloud's version
    // check: if another device saved at the same moment, it starts again from that copy). Null if there is none.
    private static JSONObject downloadWithAnswers(Context context, String address, String code) throws Exception {
        for (int attempt = 0; attempt < 3; attempt++) {
            String body = download(address);
            if (body == null) return null;
            JSONObject remote = new JSONObject(body);
            JSONObject data = new JSONObject(CloudCrypto.decrypt(code, Base64.decode(remote.getString("blob"), Base64.DEFAULT)));
            JSONArray answers = ReminderStore.answersToUpload(context);
            if (answers.length() == 0) return data;
            long upTo = 0;
            for (int i = 0; i < answers.length(); i++) upTo = Math.max(upTo, answers.getJSONObject(i).optLong("at"));
            if (applyAnswers(data, answers)) {
                String blob = Base64.encodeToString(CloudCrypto.encrypt(code, data.toString()), Base64.NO_WRAP);
                int status = upload(address, new JSONObject().put("version", remote.getInt("version")).put("blob", blob).toString());
                if (status == 409) continue;
                if (status < 200 || status >= 300) throw new IOException("Cloud answered " + status);
            }
            ReminderStore.markAnswersUploaded(context, upTo);
            return data;
        }
        throw new IOException("Another device kept saving at the same moment");
    }

    // The app's own rules for an answer (docs/js/store.js: complete, snooze, stopCheckingIn). True if anything changed.
    static boolean applyAnswers(JSONObject data, JSONArray answers) throws JSONException {
        JSONArray tasks = data.optJSONArray("tasks");
        if (tasks == null) return false;
        Map<String, JSONObject> byId = new HashMap<>();
        for (int i = 0; i < tasks.length(); i++) {
            JSONObject task = tasks.optJSONObject(i);
            if (task != null) byId.put(task.optString("id"), task);
        }
        boolean changed = false;
        for (int i = 0; i < answers.length(); i++) {
            JSONObject answer = answers.getJSONObject(i);
            JSONObject task = byId.get(answer.optString("id"));
            if (task == null || task.optBoolean("deleted") || task.optBoolean("done")) continue;
            String action = answer.optString("action");
            if (ReminderActionReceiver.DONE.equals(action)) {
                task.put("done", true).put("done_at", localStamp(answer.optLong("at")));
            } else if (ReminderActionReceiver.SNOOZE.equals(action)) {
                task.put("remind_at", localStamp(answer.optLong("until"))).put("reminded", false).put("checked_in", 0).put("answered", false);
            } else if (ReminderActionReceiver.STOP.equals(action) && !task.optBoolean("answered")) {
                task.put("answered", true);
            } else {
                continue;
            }
            task.put("updated_at", Math.max(System.currentTimeMillis(), task.optLong("updated_at") + 1));
            changed = true;
        }
        return changed;
    }

    // The synced copy decides for every task it knows about, unless this phone has a newer edit of it.
    // Reminders it doesn't know yet (set on this phone, not uploaded) stay as they are.
    static List<ReminderStore.Reminder> merge(JSONObject data, List<ReminderStore.Reminder> current) {
        JSONObject settings = data.optJSONObject("settings");
        if (settings == null) settings = new JSONObject();
        JSONArray tasks = data.optJSONArray("tasks");
        if (tasks == null) tasks = new JSONArray();

        Map<String, ReminderStore.Reminder> fromCloud = new HashMap<>();
        Map<String, Long> cloudUpdated = new HashMap<>();
        for (int i = 0; i < tasks.length(); i++) {
            JSONObject task = tasks.optJSONObject(i);
            if (task == null) continue;
            String id = task.optString("id");
            if (id.isEmpty()) continue;
            long updated = task.optLong("updated_at");
            cloudUpdated.put(id, updated);
            if (task.optBoolean("deleted") || task.optBoolean("done")) continue;
            long at = parseLocalTime(task.optString("remind_at"));
            if (at <= 0) continue;
            String title = task.optString("title");
            fromCloud.put(id, new ReminderStore.Reminder(id, title, reminderLine(task, title, settings), at, updated));
            if (!checksIn(task, settings)) continue;
            int said = task.optInt("checked_in", 0);
            for (int n = 1; n <= CHECK_IN_MINUTES.length; n++) {
                long checkAt = at + CHECK_IN_MINUTES[n - 1] * 60_000L;
                if (n <= said || isQuietTime(checkAt)) continue;
                String checkId = id + "-c" + n;
                fromCloud.put(checkId, new ReminderStore.Reminder(checkId, title, checkInLine(task, title, settings, n), checkAt, updated));
            }
        }

        List<ReminderStore.Reminder> result = new ArrayList<>();
        for (ReminderStore.Reminder mine : current) {
            Long theirs = cloudUpdated.get(ReminderStore.taskIdOf(mine.id));
            if (theirs == null || theirs < mine.updated) {
                result.add(mine);
                fromCloud.remove(mine.id);
            }
        }
        result.addAll(fromCloud.values());
        return result;
    }

    // Same words as reminderLine() in docs/js/announce.js.
    static String reminderLine(JSONObject task, String title, JSONObject settings) {
        String announce = task.isNull("announce") ? "" : task.optString("announce");
        if (!announce.isEmpty()) return announce;
        return spokenAddress(settings) + ", it's time: " + title + ".";
    }

    // Same rule as checksIn() in docs/js/announce.js (the reminder exists; this is called for unfinished tasks).
    static boolean checksIn(JSONObject task, JSONObject settings) {
        return !task.optBoolean("answered") && !Boolean.FALSE.equals(task.opt("check_in"))
            && !"off".equals(settings.optString("reminder_checks"));
    }

    static boolean isQuietTime(long at) {
        Calendar time = Calendar.getInstance();
        time.setTimeInMillis(at);
        int hour = time.get(Calendar.HOUR_OF_DAY);
        return hour >= QUIET_FROM_HOUR || hour < QUIET_UNTIL_HOUR;
    }

    // Same words as checkInLine() in docs/js/announce.js.
    static String checkInLine(JSONObject task, String title, JSONObject settings, int n) {
        Object asked = task.opt("check_in");
        String question = asked instanceof String && !((String) asked).isEmpty() ? (String) asked : "did you get to \"" + title + "\"?";
        String who = spokenAddress(settings);
        if (n >= CHECK_IN_MINUTES.length) return who + ", one last check: " + question + " I'll leave it with you after this.";
        if (n == 1) return who + ", just checking: " + question;
        return who + ", checking again: " + question + " Tell me when it's done, or say snooze.";
    }

    // How the user likes to be addressed, capitalised: "Sir", "Boss", or their name (addressWord() in announce.js).
    static String spokenAddress(JSONObject settings) {
        String address = settings.optString("address", "");
        if (address.isEmpty()) address = "sir";
        if (address.equals("name")) {
            address = settings.optString("user_name", "");
            if (address.isEmpty()) address = "friend";
        }
        return address.substring(0, 1).toUpperCase(Locale.ROOT) + address.substring(1);
    }

    // Reminder times are stored as the phone's local time, "YYYY-MM-DDTHH:MM" (docs/js/time.js).
    static long parseLocalTime(String stamp) {
        if (stamp == null || !stamp.matches("\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}.*")) return 0;
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm", Locale.ROOT);
        format.setLenient(false);
        try {
            return format.parse(stamp.substring(0, 16)).getTime();
        } catch (ParseException err) {
            return 0;
        }
    }

    static String localStamp(long at) {
        return new SimpleDateFormat("yyyy-MM-dd'T'HH:mm", Locale.ROOT).format(new Date(at));
    }

    static String fetch(String address) throws IOException {
        return download(address);
    }

    // Returns the response, or null when the cloud has no copy (404).
    private static String download(String address) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(address).openConnection();
        connection.setConnectTimeout(15_000);
        connection.setReadTimeout(15_000);
        try {
            int status = connection.getResponseCode();
            if (status == 404) return null;
            if (status != 200) throw new IOException("Cloud answered " + status);
            try (InputStream in = connection.getInputStream()) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buffer = new byte[8192];
                for (int read; (read = in.read(buffer)) != -1; ) out.write(buffer, 0, read);
                return out.toString(StandardCharsets.UTF_8.name());
            }
        } finally {
            connection.disconnect();
        }
    }

    // PUTs the new copy; returns the status (409: another device saved first).
    private static int upload(String address, String json) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(address).openConnection();
        connection.setConnectTimeout(15_000);
        connection.setReadTimeout(15_000);
        connection.setRequestMethod("PUT");
        connection.setDoOutput(true);
        connection.setRequestProperty("Content-Type", "application/json");
        try {
            try (OutputStream out = connection.getOutputStream()) {
                out.write(json.getBytes(StandardCharsets.UTF_8));
            }
            return connection.getResponseCode();
        } finally {
            connection.disconnect();
        }
    }
}
