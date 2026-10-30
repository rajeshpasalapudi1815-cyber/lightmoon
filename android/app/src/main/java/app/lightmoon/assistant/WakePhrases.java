package app.lightmoon.assistant;

import android.content.Context;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.json.JSONArray;

// The phrases that wake LightMoon ("hey LightMoon", "are you there, LightMoon"...), chosen in Settings → Voice.
// The offline recogniser only knows the words in these phrases, so a phrase is heard only as a whole: "LightMoon"
// said in the middle of a sentence to someone else doesn't open the app unless "LightMoon" alone is switched on.
final class WakePhrases {

    // id -> what the recogniser listens for (its own spelling: "lightmoon" is two words to it).
    static final Map<String, String> CHOICES = new LinkedHashMap<>();
    static {
        CHOICES.put("hey", "hey light moon");
        CHOICES.put("there", "are you there light moon");
        CHOICES.put("okay", "okay light moon");
        CHOICES.put("hi", "hi light moon");
        CHOICES.put("hello", "hello light moon");
        CHOICES.put("wake", "wake up light moon");
        CHOICES.put("listen", "light moon listen");
        CHOICES.put("name", "light moon");
    }
    static final List<String> DEFAULT = Arrays.asList("hey", "there", "okay", "hi");

    private static final String PREFS = "lightmoon.wake";
    private static final String KEY = "phrases";

    private WakePhrases() {}

    static List<String> chosen(Context context) {
        String saved = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null);
        return saved == null ? new ArrayList<>(DEFAULT) : known(Arrays.asList(saved.split(",")));
    }

    // Keeps the known ids, in the usual order; an empty choice falls back to the defaults, so it always wakes somehow.
    static List<String> known(List<String> ids) {
        List<String> result = new ArrayList<>();
        for (String id : CHOICES.keySet()) if (ids.contains(id)) result.add(id);
        return result.isEmpty() ? new ArrayList<>(DEFAULT) : result;
    }

    static void choose(Context context, List<String> ids) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, String.join(",", known(ids))).apply();
    }

    static List<String> phrases(List<String> ids) {
        List<String> result = new ArrayList<>();
        for (String id : known(ids)) result.add(CHOICES.get(id));
        return result;
    }

    // Said just after LightMoon opened a draft in another app: send it (WakeWordService.expectSend).
    static final List<String> SEND = Arrays.asList("send it", "send", "send it now", "okay send it", "ok send it", "yes send it", "yes send");

    // The recogniser's grammar: the chosen phrases, and "[unk]" for everything else.
    static String grammar(List<String> ids) {
        return grammar(ids, new ArrayList<>());
    }

    // ... plus extra phrases (SEND while a draft waits).
    static String grammar(List<String> ids, List<String> extra) {
        JSONArray words = new JSONArray();
        for (String phrase : phrases(ids)) words.put(phrase);
        for (String phrase : extra) words.put(phrase);
        words.put("[unk]");
        return words.toString();
    }

    // Whether what it heard is one of the chosen phrases. Only whole phrases count, at word boundaries,
    // so "light moon" heard alone doesn't count when only "hey light moon" is chosen.
    static boolean matches(String heard, List<String> ids) {
        String text = " " + String.valueOf(heard).toLowerCase().replace("lightmoon", "light moon").replaceAll("[^a-z ]", " ")
            .replaceAll("\\s+", " ").trim() + " ";
        for (String phrase : phrases(ids)) {
            if (text.contains(" " + phrase + " ")) return true;
        }
        return false;
    }

    // Whether what it heard is only "send it" (or one of SEND), nothing else.
    static boolean saysSend(String heard) {
        String text = String.valueOf(heard).toLowerCase().replaceAll("[^a-z ]", " ").replaceAll("\\s+", " ").trim();
        return SEND.contains(text);
    }

    // "Hey LightMoon", for the notification and Settings.
    static String spoken(String phrase) {
        String said = phrase.replace("light moon", "LightMoon");
        return Character.toUpperCase(said.charAt(0)) + said.substring(1);
    }
}
