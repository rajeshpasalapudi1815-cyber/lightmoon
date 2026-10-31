package app.lightmoon.assistant;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

// "Only my voice": the owner says their wake word a few times (Settings → Voice → Teach my voice), and Vosk's speaker
// model turns each into a voice print, a list of numbers. Later a wake word only counts when the voice that said it
// is close enough to one of those. Kept on this phone only, never synced or backed up (allowBackup is off).
final class VoicePrint {

    private static final String PREFS = "lightmoon.voice";
    static final int SAMPLES_WANTED = 3;
    private static final int MAX_SAMPLES = 8;
    // How alike two voice prints must be (cosine similarity), by strictness. Vosk's prints of one person's short
    // phrases usually land well above 0.5 and other people's well below; "relaxed" for noisy places.
    private static final double[] THRESHOLDS = { 0.35, 0.45, 0.55 }; // relaxed, normal, strict

    private VoicePrint() {}

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    // The print in a Vosk result ({"spk": [...], "text": ...}), or null.
    static double[] from(JSONObject result) {
        JSONArray spk = result.optJSONArray("spk");
        if (spk == null || spk.length() == 0) return null;
        double[] print = new double[spk.length()];
        for (int i = 0; i < print.length; i++) print[i] = spk.optDouble(i);
        return print;
    }

    static int samples(Context context) {
        return saved(context).length();
    }

    static boolean on(Context context) {
        return prefs(context).getBoolean("on", false) && samples(context) > 0;
    }

    static void setOn(Context context, boolean on) {
        prefs(context).edit().putBoolean("on", on).apply();
    }

    // 0 relaxed, 1 normal, 2 strict.
    static int strictness(Context context) {
        return Math.max(0, Math.min(2, prefs(context).getInt("strictness", 1)));
    }

    static void setStrictness(Context context, int level) {
        prefs(context).edit().putInt("strictness", Math.max(0, Math.min(2, level))).apply();
    }

    static void add(Context context, double[] print) {
        JSONArray all = saved(context);
        JSONArray kept = new JSONArray();
        for (int i = Math.max(0, all.length() - MAX_SAMPLES + 1); i < all.length(); i++) kept.put(all.opt(i));
        JSONArray values = new JSONArray();
        for (double value : print) {
            try {
                values.put(value);
            } catch (JSONException err) {
                return; // not a number: not kept
            }
        }
        kept.put(values);
        prefs(context).edit().putString("samples", kept.toString()).apply();
    }

    static void forget(Context context) {
        prefs(context).edit().remove("samples").putBoolean("on", false).remove("last").apply();
    }

    // How alike this voice is to the owner's (the best of their samples), 0 to 1, or -1 with nothing to compare.
    static double likeness(Context context, double[] print) {
        if (print == null) return -1;
        JSONArray all = saved(context);
        double best = -1;
        for (int i = 0; i < all.length(); i++) {
            JSONArray sample = all.optJSONArray(i);
            if (sample == null || sample.length() != print.length) continue;
            double dot = 0, a = 0, b = 0;
            for (int j = 0; j < print.length; j++) {
                double x = sample.optDouble(j);
                dot += x * print[j];
                a += x * x;
                b += print[j] * print[j];
            }
            if (a > 0 && b > 0) best = Math.max(best, dot / Math.sqrt(a * b));
        }
        return best;
    }

    // Whether the voice is the owner's. Without a voice print to check, it can't be: refused while "only my voice" is on.
    static boolean isOwner(Context context, double[] print) {
        double score = likeness(context, print);
        prefs(context).edit().putFloat("last", (float) score).apply();
        return score >= THRESHOLDS[strictness(context)];
    }

    // The last wake's likeness (for Settings, to see how close it was), or -1.
    static double lastScore(Context context) {
        return prefs(context).getFloat("last", -1f);
    }

    private static JSONArray saved(Context context) {
        try {
            return new JSONArray(prefs(context).getString("samples", "[]"));
        } catch (JSONException err) {
            return new JSONArray();
        }
    }
}
