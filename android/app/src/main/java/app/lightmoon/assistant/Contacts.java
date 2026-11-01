package app.lightmoon.assistant;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.provider.ContactsContract;
import androidx.core.content.ContextCompat;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

// The phone's contacts: who a number belongs to, and the numbers for a name.
final class Contacts {

    private static final int MAX_MATCHES = 8;

    private Contacts() {}

    static boolean canRead(Context context) {
        return ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CONTACTS) == PackageManager.PERMISSION_GRANTED;
    }

    // The contact's name for a phone number, or null.
    static String nameFor(Context context, String number) {
        if (number == null || number.isEmpty() || !canRead(context)) return null;
        Uri uri = Uri.withAppendedPath(ContactsContract.PhoneLookup.CONTENT_FILTER_URI, Uri.encode(number));
        try (Cursor cursor = context.getContentResolver().query(uri, new String[] { ContactsContract.PhoneLookup.DISPLAY_NAME }, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) return cursor.getString(0);
        } catch (RuntimeException ignored) {
            // Contacts provider unavailable: treat as unknown.
        }
        return null;
    }

    // [{ name, numbers: [{ number, label }] }] for contacts whose name matches the query.
    static JSONArray search(Context context, String query) throws JSONException {
        JSONArray result = new JSONArray();
        if (query == null || query.trim().isEmpty() || !canRead(context)) return result;
        Uri uri = Uri.withAppendedPath(ContactsContract.CommonDataKinds.Phone.CONTENT_FILTER_URI, Uri.encode(query.trim()));
        String[] columns = {
            ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
            ContactsContract.CommonDataKinds.Phone.NUMBER,
            ContactsContract.CommonDataKinds.Phone.TYPE,
            ContactsContract.CommonDataKinds.Phone.LABEL,
        };
        Map<String, Set<String>> numbers = new LinkedHashMap<>();
        Map<String, JSONArray> details = new LinkedHashMap<>();
        try (Cursor cursor = context.getContentResolver().query(uri, columns, null, null, null)) {
            while (cursor != null && cursor.moveToNext() && numbers.size() <= MAX_MATCHES) {
                String name = cursor.getString(0);
                String number = cursor.getString(1);
                if (name == null || number == null) continue;
                String digits = number.replaceAll("[^0-9+]", "");
                if (!numbers.computeIfAbsent(name, k -> new LinkedHashSet<>()).add(digits)) continue;
                CharSequence label = ContactsContract.CommonDataKinds.Phone.getTypeLabel(context.getResources(), cursor.getInt(2), cursor.getString(3));
                details.computeIfAbsent(name, k -> new JSONArray()).put(new JSONObject().put("number", number).put("label", String.valueOf(label)));
            }
        }
        for (Map.Entry<String, JSONArray> entry : details.entrySet()) {
            if (result.length() >= MAX_MATCHES) break;
            result.put(new JSONObject().put("name", entry.getKey()).put("numbers", entry.getValue()));
        }
        return result.length() > 0 ? result : soundsLike(context, query);
    }

    // No contact starts with the name as heard: those whose name (or a word of it) sounds the same, the way speech
    // recognition spells names: "Diksha" for Deeksha, "superhero" for Super Hero, "Sireesha" for Shirisha.
    private static JSONArray soundsLike(Context context, String query) throws JSONException {
        JSONArray result = new JSONArray();
        String wanted = soundKey(query);
        if (wanted.length() < 3) return result;
        String[] columns = {
            ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
            ContactsContract.CommonDataKinds.Phone.NUMBER,
            ContactsContract.CommonDataKinds.Phone.TYPE,
            ContactsContract.CommonDataKinds.Phone.LABEL,
        };
        Map<String, JSONArray> details = new LinkedHashMap<>();
        Map<String, Set<String>> numbers = new LinkedHashMap<>();
        try (Cursor cursor = context.getContentResolver().query(ContactsContract.CommonDataKinds.Phone.CONTENT_URI, columns, null, null, null)) {
            while (cursor != null && cursor.moveToNext()) {
                String name = cursor.getString(0);
                String number = cursor.getString(1);
                if (name == null || number == null || !soundsAlike(name, wanted)) continue;
                if (!numbers.computeIfAbsent(name, k -> new LinkedHashSet<>()).add(number.replaceAll("[^0-9+]", ""))) continue;
                CharSequence label = ContactsContract.CommonDataKinds.Phone.getTypeLabel(context.getResources(), cursor.getInt(2), cursor.getString(3));
                details.computeIfAbsent(name, k -> new JSONArray()).put(new JSONObject().put("number", number).put("label", String.valueOf(label)));
                if (details.size() > MAX_MATCHES) break;
            }
        }
        for (Map.Entry<String, JSONArray> entry : details.entrySet()) {
            if (result.length() >= MAX_MATCHES) break;
            result.put(new JSONObject().put("name", entry.getKey()).put("numbers", entry.getValue()).put("soundsLike", true));
        }
        return result;
    }

    // The whole name, or any one word of it, or two words run together ("Super Hero"), sounds like the wanted key.
    private static boolean soundsAlike(String name, String wanted) {
        String[] words = name.trim().split("[\\s._-]+");
        if (soundKey(name).equals(wanted)) return true;
        for (int i = 0; i < words.length; i++) {
            if (soundKey(words[i]).equals(wanted)) return true;
            if (i + 1 < words.length && soundKey(words[i] + words[i + 1]).equals(wanted)) return true;
        }
        return false;
    }

    // Letters only, with the spellings Indian names are written and heard in brought together: ee/i, oo/u, aa/a,
    // sh/s, th/t, dh/d, bh/b, kh/k, gh/g, ph/f, v/w, z/j, ck/k, q/k, a final h, and doubled letters.
    static String soundKey(String text) {
        String key = text.toLowerCase(Locale.ROOT).replaceAll("[^a-z]", "");
        key = key.replace("ee", "i").replace("oo", "u").replace("aa", "a").replace("ck", "k").replace("q", "k")
            .replace("sh", "s").replace("th", "t").replace("dh", "d").replace("bh", "b").replace("kh", "k")
            .replace("gh", "g").replace("ph", "f").replace("v", "w").replace("z", "j").replace("y", "i");
        key = key.replaceAll("(.)\\1+", "$1");
        if (key.length() > 3 && key.endsWith("h")) key = key.substring(0, key.length() - 1);
        return key;
    }
}
