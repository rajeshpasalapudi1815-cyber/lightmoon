package app.lightmoon.assistant;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Base64;
import androidx.annotation.NonNull;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.ParseException;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;

// With sync on, checks the encrypted cloud copy every 15 minutes (Android's shortest interval) and sets
// alarms for reminders made on the user's other devices, so the phone speaks them even if LightMoon
// hasn't been opened. Reads the copy exactly as the web app writes it (docs/js/store.js, cloud.js).
public class SyncWorker extends Worker {

    private static final String PREFS = "lightmoon.sync";
    private static final String WORK_NAME = "lightmoon-sync";

    public SyncWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static void start(Context context, String url, String spaceId, String code) {
        prefs(context).edit().putString("url", url).putString("spaceId", spaceId).putString("code", code).apply();
        Constraints online = new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build();
        PeriodicWorkRequest request = new PeriodicWorkRequest.Builder(SyncWorker.class, 15, TimeUnit.MINUTES)
            .setConstraints(online)
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
            String body = download(url.replaceAll("/+$", "") + "/spaces/" + spaceId + "/data");
            if (body == null) return Result.success(); // nothing synced yet
            String blob = new JSONObject(body).getString("blob");
            JSONObject data = new JSONObject(CloudCrypto.decrypt(code, Base64.decode(blob, Base64.DEFAULT)));
            ReminderStore.replaceAll(context, merge(data, ReminderStore.all(context)), ReminderStore.hideText(context));
            return Result.success();
        } catch (IOException err) {
            return Result.retry();
        } catch (Exception err) {
            return Result.failure(); // unreadable copy (e.g. the code changed); the next run tries again
        }
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
        }

        List<ReminderStore.Reminder> result = new ArrayList<>();
        for (ReminderStore.Reminder mine : current) {
            Long theirs = cloudUpdated.get(mine.id);
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
        String address = settings.optString("address", "");
        if (address.isEmpty()) address = "sir";
        if (address.equals("name")) {
            address = settings.optString("user_name", "");
            if (address.isEmpty()) address = "friend";
        }
        String spoken = address.substring(0, 1).toUpperCase(Locale.ROOT) + address.substring(1);
        return spoken + ", it's time: " + title + ".";
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
}
