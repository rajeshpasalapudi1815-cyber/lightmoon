package app.lightmoon.assistant;

import android.app.DownloadManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

// LightMoon's offline brain: a small AI model that runs on the phone itself (llama.cpp, see cpp/lightmoon_llm.cpp),
// for when there's no internet. The model (about 1 GB) is downloaded once, when the user asks, checked against its
// published SHA-256, kept in the app's own storage, loaded on first use and let go after a few idle minutes.
final class OfflineBrain {

    // Qwen2.5 1.5B Instruct (Apache 2.0), 4-bit. Our own model (trained from the big one) can replace it later.
    static final String MODEL_NAME = "Qwen2.5 1.5B Instruct";
    static final String MODEL_URL = "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf";
    static final long MODEL_BYTES = 1_117_320_736L;
    static final String MODEL_SHA256 = "6ca5463cf24c16cd56d7ad7461524d813b07b3f29889b2fbdbb8286a7e97a14a";
    static final int CONTEXT = 4096;

    private static final String PREFS = "lightmoon.offline";
    private static final String FILE = "offline-brain.gguf";

    interface TokenSink {
        boolean onToken(byte[] piece);
    }

    static native boolean nativeInit(String nativeLibDir);
    static native long nativeLoad(String modelPath, int nCtx);
    static native byte[] nativeComplete(long handle, String[] roles, String[] contents, int maxTokens, TokenSink sink);
    static native void nativeFree(long handle);

    private static boolean libraryLoaded;
    private static boolean started;
    private static long handle;

    private OfflineBrain() {}

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static File modelFile(Context context) {
        return new File(context.getExternalFilesDir("models"), FILE);
    }

    private static File partFile(Context context) {
        return new File(context.getExternalFilesDir("models"), FILE + ".part");
    }

    static boolean supported() {
        return Build.SUPPORTED_64_BIT_ABIS.length > 0 && "arm64-v8a".equals(Build.SUPPORTED_64_BIT_ABIS[0]);
    }

    static boolean ready(Context context) {
        return prefs(context).getBoolean("checked", false) && modelFile(context).length() == MODEL_BYTES;
    }

    // ---------- Downloading ----------

    // Starts the download with Android's download manager (it shows progress and survives the app closing).
    static void download(Context context, boolean wifiOnly) {
        DownloadManager downloads = context.getSystemService(DownloadManager.class);
        cancel(context);
        partFile(context).delete();
        DownloadManager.Request request = new DownloadManager.Request(Uri.parse(MODEL_URL))
            .setTitle("LightMoon offline brain")
            .setDescription(MODEL_NAME + ", about 1 GB")
            .setDestinationInExternalFilesDir(context, "models", FILE + ".part")
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE)
            .setAllowedOverMetered(!wifiOnly)
            .setAllowedOverRoaming(false);
        prefs(context).edit().putLong("downloadId", downloads.enqueue(request)).putBoolean("checked", false).apply();
    }

    static void cancel(Context context) {
        long id = prefs(context).getLong("downloadId", -1);
        if (id >= 0) context.getSystemService(DownloadManager.class).remove(id);
        prefs(context).edit().remove("downloadId").apply();
    }

    static void remove(Context context) {
        cancel(context);
        unload();
        modelFile(context).delete();
        partFile(context).delete();
        prefs(context).edit().putBoolean("checked", false).apply();
    }

    // { state: "none" | "downloading" | "checking" | "ready" | "failed", done, total, problem }. A finished download
    // is checked (size and SHA-256) here, the first time it's asked about, before it's ever loaded.
    static synchronized String[] state(Context context) {
        if (ready(context)) return new String[] { "ready", String.valueOf(MODEL_BYTES), String.valueOf(MODEL_BYTES), "" };
        long id = prefs(context).getLong("downloadId", -1);
        if (id < 0) return new String[] { "none", "0", String.valueOf(MODEL_BYTES), "" };
        DownloadManager downloads = context.getSystemService(DownloadManager.class);
        try (Cursor cursor = downloads.query(new DownloadManager.Query().setFilterById(id))) {
            if (cursor == null || !cursor.moveToFirst()) {
                prefs(context).edit().remove("downloadId").apply();
                return new String[] { "failed", "0", String.valueOf(MODEL_BYTES), "The download was cancelled." };
            }
            int status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
            long done = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR));
            if (status == DownloadManager.STATUS_FAILED) {
                prefs(context).edit().remove("downloadId").apply();
                return new String[] { "failed", String.valueOf(done), String.valueOf(MODEL_BYTES), "The download failed. Try again on Wi-Fi." };
            }
            if (status != DownloadManager.STATUS_SUCCESSFUL) {
                return new String[] { "downloading", String.valueOf(done), String.valueOf(MODEL_BYTES), "" };
            }
        }
        // Downloaded: check it's exactly the published file before it becomes the offline brain.
        File part = partFile(context);
        String problem = part.length() != MODEL_BYTES ? "The download was incomplete." : !MODEL_SHA256.equals(sha256(part)) ? "The download was damaged." : null;
        prefs(context).edit().remove("downloadId").apply();
        if (problem != null) {
            part.delete();
            return new String[] { "failed", "0", String.valueOf(MODEL_BYTES), problem + " Try again." };
        }
        File model = modelFile(context);
        model.delete();
        if (!part.renameTo(model)) return new String[] { "failed", "0", String.valueOf(MODEL_BYTES), "Couldn't store the model." };
        prefs(context).edit().putBoolean("checked", true).apply();
        return new String[] { "ready", String.valueOf(MODEL_BYTES), String.valueOf(MODEL_BYTES), "" };
    }

    private static String sha256(File file) {
        try (InputStream in = new FileInputStream(file)) {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] buffer = new byte[1 << 20];
            for (int read; (read = in.read(buffer)) != -1; ) digest.update(buffer, 0, read);
            StringBuilder hex = new StringBuilder();
            for (byte b : digest.digest()) hex.append(String.format("%02x", b));
            return hex.toString();
        } catch (IOException | NoSuchAlgorithmException err) {
            return "";
        }
    }

    // ---------- Thinking ----------

    // Loads the model if it isn't yet (a few seconds); false if it can't be.
    static synchronized boolean load(Context context) {
        if (handle != 0) return true;
        if (!supported() || !ready(context)) return false;
        try {
            if (!libraryLoaded) {
                System.loadLibrary("lightmoon-llm");
                libraryLoaded = true;
            }
            if (!started) started = nativeInit(context.getApplicationInfo().nativeLibraryDir);
            if (!started) return false;
            handle = nativeLoad(modelFile(context).getAbsolutePath(), CONTEXT);
        } catch (UnsatisfiedLinkError err) {
            return false;
        }
        return handle != 0;
    }

    static synchronized void unload() {
        if (handle == 0) return;
        nativeFree(handle);
        handle = 0;
    }

    // One answer to a conversation (oldest first, ending with the user's turn), streamed to `sink` as it's written.
    static synchronized String answer(Context context, String[] roles, String[] contents, int maxTokens, TokenSink sink) {
        if (!load(context)) return null;
        byte[] reply = nativeComplete(handle, roles, contents, maxTokens, sink);
        return reply == null ? null : new String(reply, StandardCharsets.UTF_8);
    }
}
