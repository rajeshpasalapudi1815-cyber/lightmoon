package app.lightmoon.assistant;

import android.content.Context;
import android.content.SharedPreferences;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Set;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

// What LightMoon may read, chosen in Settings → Messages and email. An app switched off is ignored completely;
// an email account is read only once switched on (new ones start off); a chat or person switched off is never
// read. MessageListener checks these before a message is stored, said out loud or shown to the AI.
// For Settings to list them, it also notes which apps, accounts and chats have sent something: names only,
// never what they said, and no chat names from apps that are switched off.
final class ReadRules {

    private static final String PREFS = "lightmoon.reading";
    private static final int MAX_CHATS = 40; // the most recent chats offered in Settings

    private ReadRules() {}

    // ---------- The rules ----------

    static synchronized boolean appAllowed(Context context, String app) {
        return !names(context, "blockedApps").contains(app);
    }

    static synchronized boolean accountAllowed(Context context, String account) {
        return names(context, "allowedAccounts").contains(account);
    }

    static synchronized boolean chatAllowed(Context context, String app, String chat) {
        return !names(context, "blockedChats").contains(app + "|" + chat);
    }

    static synchronized void allowApp(Context context, String app, boolean allowed) {
        change(context, "blockedApps", app, !allowed);
    }

    static synchronized void allowAccount(Context context, String account, boolean allowed) {
        change(context, "allowedAccounts", account, allowed);
    }

    static synchronized void allowChat(Context context, String app, String chat, boolean allowed) {
        change(context, "blockedChats", app + "|" + chat, !allowed);
    }

    // ---------- What has sent something (for Settings) ----------

    // kind: "chat" or "email"
    static synchronized void sawApp(Context context, String app, String label, String kind) {
        JSONObject apps = object(context, "apps");
        JSONObject old = apps.optJSONObject(app);
        String kinds = old == null || old.optString("kind").equals(kind) ? kind : "chat,email";
        put(context, "apps", apps, app, entry(label, "kind", kinds));
    }

    // account: the address the mail came to, or "" when the app doesn't show it
    static synchronized void sawAccount(Context context, String account, String app, String label) {
        put(context, "accounts", object(context, "accounts"), accountKey(app, account), entry(label, "app", app));
    }

    static synchronized void sawChat(Context context, String app, String label, String chat) {
        if (chat.isEmpty()) return;
        JSONObject chats = object(context, "chats");
        put(context, "chats", chats, app + "|" + chat, entry(label, "app", app, "chat", chat));
        if (chats.length() > MAX_CHATS) dropOldest(context, chats);
    }

    // { apps: [{ app, label, kind, allowed, at }], accounts: [{ account, app, label, allowed, at }],
    //   chats: [{ app, label, chat, allowed, at }] }, most recent first
    static synchronized JSONObject sources(Context context) throws JSONException {
        JSONArray apps = new JSONArray();
        JSONObject seenApps = object(context, "apps");
        for (String app : newestFirst(seenApps)) {
            JSONObject e = seenApps.getJSONObject(app);
            apps.put(new JSONObject().put("app", app).put("label", e.optString("label")).put("kind", e.optString("kind"))
                .put("allowed", appAllowed(context, app)).put("at", e.optLong("at")));
        }
        JSONArray accounts = new JSONArray();
        JSONObject seenAccounts = object(context, "accounts");
        for (String key : newestFirst(seenAccounts)) {
            JSONObject e = seenAccounts.getJSONObject(key);
            String account = key.startsWith("app:") ? "" : key;
            accounts.put(new JSONObject().put("account", account).put("app", e.optString("app")).put("label", e.optString("label"))
                .put("allowed", accountAllowed(context, key)).put("at", e.optLong("at")));
        }
        JSONArray chats = new JSONArray();
        JSONObject seenChats = object(context, "chats");
        for (String key : newestFirst(seenChats)) {
            JSONObject e = seenChats.getJSONObject(key);
            String app = e.optString("app");
            if (!appAllowed(context, app)) continue; // an app switched off shows no chats
            chats.put(new JSONObject().put("app", app).put("label", e.optString("label")).put("chat", e.optString("chat"))
                .put("allowed", chatAllowed(context, app, e.optString("chat"))).put("at", e.optLong("at")));
        }
        return new JSONObject().put("apps", apps).put("accounts", accounts).put("chats", chats);
    }

    // The key MessageListener and sawAccount use for an account ("" means the app didn't say which).
    static String accountKey(String app, String account) {
        return account.isEmpty() ? "app:" + app : account;
    }

    // ---------- Storage ----------

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static Set<String> names(Context context, String key) {
        return new HashSet<>(prefs(context).getStringSet(key, new HashSet<>()));
    }

    private static void change(Context context, String key, String name, boolean present) {
        Set<String> set = names(context, key);
        if (present) set.add(name);
        else set.remove(name);
        prefs(context).edit().putStringSet(key, set).apply();
    }

    private static JSONObject object(Context context, String key) {
        try {
            return new JSONObject(prefs(context).getString(key, "{}"));
        } catch (JSONException err) {
            return new JSONObject();
        }
    }

    // { label, at: now, and the extra name/value pairs }
    private static JSONObject entry(String label, String... pairs) {
        JSONObject entry = new JSONObject();
        try {
            entry.put("label", label).put("at", System.currentTimeMillis());
            for (int i = 0; i + 1 < pairs.length; i += 2) entry.put(pairs[i], pairs[i + 1]);
        } catch (JSONException ignored) {
            // Only plain strings and numbers go in.
        }
        return entry;
    }

    private static void put(Context context, String key, JSONObject all, String name, JSONObject value) {
        try {
            all.put(name, value);
        } catch (JSONException err) {
            return;
        }
        prefs(context).edit().putString(key, all.toString()).apply();
    }

    private static void dropOldest(Context context, JSONObject chats) {
        List<String> order = newestFirst(chats);
        for (int i = MAX_CHATS; i < order.size(); i++) {
            String key = order.get(i);
            if (!names(context, "blockedChats").contains(key)) chats.remove(key); // switched-off chats stay listed
        }
        prefs(context).edit().putString("chats", chats.toString()).apply();
    }

    private static List<String> newestFirst(JSONObject all) {
        List<String> keys = new ArrayList<>();
        for (Iterator<String> it = all.keys(); it.hasNext(); ) keys.add(it.next());
        keys.sort((a, b) -> Long.compare(all.optJSONObject(b).optLong("at"), all.optJSONObject(a).optLong("at")));
        return keys;
    }
}
