package app.lightmoon.assistant;

import android.content.Context;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

// The offline speech model that listens for "LightMoon" (Vosk's small English model, about 41 MB).
// It's downloaded the first time the wake word is turned on, so people who don't use it don't carry it.
// "Only my voice" adds Vosk's speaker model (about 13 MB), which turns a voice into numbers to compare (VoicePrint).
final class WakeModel {

    interface Progress {
        void percent(int value);
    }

    static final String NAME = "vosk-model-small-en-us-0.15";
    static final String SPEAKER = "vosk-model-spk-0.4";
    private static final String BASE_URL = "https://alphacephei.com/vosk/models/";
    private static final String COMPLETE_MARKER = ".complete";
    private static volatile java.util.Set<String> words;

    private WakeModel() {}

    static File dir(Context context) {
        return dir(context, NAME);
    }

    static File dir(Context context, String name) {
        return new File(new File(context.getFilesDir(), "vosk"), name);
    }

    static boolean ready(Context context) {
        return ready(context, NAME);
    }

    static boolean ready(Context context, String name) {
        return new File(dir(context, name), COMPLETE_MARKER).exists();
    }

    static void download(Context context, Progress progress) throws IOException {
        download(context, NAME, "am/final.mdl", progress);
    }

    static void downloadSpeaker(Context context, Progress progress) throws IOException {
        download(context, SPEAKER, "final.ext.raw", progress);
    }

    // Whether the recogniser knows every word of a phrase (its own wake word must be made of words it knows).
    static boolean knows(Context context, String phrase) {
        java.util.Set<String> known = words;
        if (known == null) {
            known = new java.util.HashSet<>();
            File list = new File(dir(context), "graph/words.txt");
            try (java.io.BufferedReader in = new java.io.BufferedReader(new java.io.FileReader(list))) {
                for (String line; (line = in.readLine()) != null; ) {
                    int space = line.indexOf(' ');
                    known.add(space > 0 ? line.substring(0, space) : line);
                }
            } catch (IOException err) {
                return true; // can't tell: let it try
            }
            words = known;
        }
        for (String word : phrase.split(" ")) if (!known.contains(word)) return false;
        return true;
    }

    // Downloads and unpacks one of Vosk's models; `check` is a file that only a complete model has.
    private static synchronized void download(Context context, String name, String check, Progress progress) throws IOException {
        if (ready(context, name)) return;
        File root = new File(context.getFilesDir(), "vosk");
        File unpacking = new File(root, "unpacking");
        deleteTree(unpacking);
        deleteTree(dir(context, name));
        if (!unpacking.mkdirs()) throw new IOException("Can't create " + unpacking);

        HttpURLConnection connection = (HttpURLConnection) new URL(BASE_URL + name + ".zip").openConnection();
        connection.setConnectTimeout(20_000);
        connection.setReadTimeout(30_000);
        try {
            if (connection.getResponseCode() != 200) throw new IOException("Download answered " + connection.getResponseCode());
            long total = connection.getContentLengthLong();
            try (InputStream raw = connection.getInputStream()) {
                CountingStream counted = new CountingStream(raw, total, progress);
                unzip(new ZipInputStream(counted), unpacking);
            }
        } finally {
            connection.disconnect();
        }
        File unpacked = new File(unpacking, name);
        if (!new File(unpacked, check).exists()) throw new IOException("The model download was incomplete");
        if (!unpacked.renameTo(dir(context, name))) throw new IOException("Can't move the model into place");
        deleteTree(unpacking);
        if (!new File(dir(context, name), COMPLETE_MARKER).createNewFile()) throw new IOException("Can't mark the model ready");
    }

    private static void unzip(ZipInputStream zip, File target) throws IOException {
        String base = target.getCanonicalPath() + File.separator;
        byte[] buffer = new byte[64 * 1024];
        for (ZipEntry entry; (entry = zip.getNextEntry()) != null; ) {
            File out = new File(target, entry.getName());
            // Never write outside the target folder, whatever the archive says.
            if (!out.getCanonicalPath().startsWith(base)) throw new IOException("Bad path in model archive");
            if (entry.isDirectory()) {
                if (!out.isDirectory() && !out.mkdirs()) throw new IOException("Can't create " + out);
                continue;
            }
            File parent = out.getParentFile();
            if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new IOException("Can't create " + parent);
            try (OutputStream file = new FileOutputStream(out)) {
                for (int read; (read = zip.read(buffer)) != -1; ) file.write(buffer, 0, read);
            }
        }
    }

    private static void deleteTree(File file) {
        File[] children = file.listFiles();
        if (children != null) for (File child : children) deleteTree(child);
        //noinspection ResultOfMethodCallIgnored
        file.delete();
    }

    // Reports download progress as the archive is read.
    private static final class CountingStream extends InputStream {
        private final InputStream in;
        private final long total;
        private final Progress progress;
        private long read;
        private int lastPercent = -1;

        CountingStream(InputStream in, long total, Progress progress) {
            this.in = in;
            this.total = total;
            this.progress = progress;
        }

        @Override
        public int read() throws IOException {
            int value = in.read();
            if (value >= 0) count(1);
            return value;
        }

        @Override
        public int read(byte[] buffer, int offset, int length) throws IOException {
            int count = in.read(buffer, offset, length);
            if (count > 0) count(count);
            return count;
        }

        private void count(long bytes) {
            read += bytes;
            if (total <= 0) return;
            int percent = (int) (read * 100 / total);
            if (percent != lastPercent) {
                lastPercent = percent;
                progress.percent(percent);
            }
        }

        @Override
        public void close() throws IOException {
            in.close();
        }
    }
}
