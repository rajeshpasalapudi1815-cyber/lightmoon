package app.lightmoon.assistant;

import android.app.Notification;
import android.app.PendingIntent;
import android.app.RemoteInput;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Telephony;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
import android.util.Log;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.Person;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

// New messages (SMS, WhatsApp, Telegram, Signal, Teams and other chat apps) and new emails, seen through their
// notifications once the user gives LightMoon notification access. Only what ReadRules allows is kept: apps
// switched off, email accounts not switched on and chats switched off are dropped here, before anything is
// stored or said. LightMoon keeps the last two days on this phone, says new chat messages out loud (as chosen
// in Settings), and can answer chats through the notification's own reply box. Emails are never said out loud.
public class MessageListener extends NotificationListenerService {

    private static final Set<String> CHAT_APPS = new HashSet<>(Arrays.asList(
        "com.whatsapp", "com.whatsapp.w4b", "org.telegram.messenger", "org.thoughtcrime.securesms",
        "com.google.android.apps.messaging", "com.samsung.android.messaging"));
    private static final String PREFS = "lightmoon.messages";
    private static final int KEEP = 120;
    private static final long KEEP_MS = 2 * 86_400_000L;
    // One-time codes and security messages are never read out loud (only who sent them): a security word and
    // a code-like number. Same rule as docs/js/phone.js; "pin code" alone is a postal code in India.
    private static final Pattern SECURITY_WORDS = Pattern.compile(
        "\\b(otp|one[- ]?time|verification|security code|passcode|login code|auth\\w* code|(?<!pin )code|pin(?!\\s*code)|sign[- ]?in|log[- ]?in)\\b",
        Pattern.CASE_INSENSITIVE);
    private static final Pattern CODE_NUMBER = Pattern.compile("\\d{4,8}|\\d{3}[- ]\\d{3}");
    private static final long GATHER_MS = 2_500; // a burst of messages is announced once
    private static final String TAG = "LightMoonReader"; // in the phone's log (adb logcat), never with message text

    // Reply actions by conversation, while their notification is showing (they can't be saved), and which
    // conversation each notification answers, to forget the action when the notification goes.
    private static final Map<String, Notification.Action> replies = new ConcurrentHashMap<>();
    private static final Map<String, String> conversationOf = new ConcurrentHashMap<>();
    private static volatile MessageListener running; // while Android has the listener connected
    private final Handler main = new Handler(Looper.getMainLooper());
    private final List<JSONObject> toAnnounce = new ArrayList<>(); // main thread only

    static boolean looksLikeCode(String text) {
        return SECURITY_WORDS.matcher(text).find() && CODE_NUMBER.matcher(text).find();
    }

    static boolean isEnabled(Context context) {
        return NotificationManagerCompat.getEnabledListenerPackages(context).contains(context.getPackageName());
    }

    // After an app update some phones don't reconnect the listener until a restart: LightMoon would quietly stop
    // noticing messages. Ask Android to reconnect it whenever it should be running and isn't.
    static void reconnectIfNeeded(Context context) {
        if (running != null || !isEnabled(context) || Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return;
        try {
            requestRebind(new ComponentName(context, MessageListener.class));
            Log.i(TAG, "asked Android to reconnect");
        } catch (RuntimeException err) {
            Log.w(TAG, "couldn't ask Android to reconnect", err);
        }
    }

    @Override
    public void onListenerConnected() {
        running = this;
        Log.i(TAG, "connected");
        readShowing();
    }

    @Override
    public void onListenerDisconnected() {
        if (running == this) running = null;
    }

    // What's already on screen is old news: remember it without announcing it.
    private void readShowing() {
        try {
            StatusBarNotification[] showing = getActiveNotifications();
            int skipped = 0;
            for (StatusBarNotification sbn : showing) {
                try {
                    record(sbn, false);
                } catch (RuntimeException err) {
                    skipped++; // one odd notification doesn't stop the rest
                    Log.w(TAG, "skipped a notification from " + sbn.getPackageName(), err);
                }
            }
            Log.i(TAG, "read " + showing.length + " showing notifications, " + skipped + " skipped");
        } catch (RuntimeException err) {
            // Not ready yet; new messages still come through onNotificationPosted.
            Log.w(TAG, "couldn't read the notifications showing", err);
        }
    }

    // The reading rules changed: drop what's no longer allowed, and pick up what now is from the notifications showing.
    static void rulesChanged(Context context) {
        purge(context);
        MessageListener listener = running;
        if (listener != null) listener.readShowing();
    }

    @Override
    public void onNotificationPosted(StatusBarNotification sbn) {
        try {
            record(sbn, true);
        } catch (RuntimeException err) {
            // Another app's odd notification must never take LightMoon down; skip it.
            Log.w(TAG, "skipped a notification from " + sbn.getPackageName(), err);
        }
    }

    @Override
    public void onNotificationRemoved(StatusBarNotification sbn) {
        String conversation = conversationOf.remove(sbn.getKey());
        if (conversation != null) replies.remove(conversation);
    }

    // "chat", "email", or null for anything else.
    private String kindOf(StatusBarNotification sbn) {
        String app = sbn.getPackageName();
        if (app.equals(getPackageName()) || sbn.isOngoing()) return null;
        Notification n = sbn.getNotification();
        if ((n.flags & Notification.FLAG_GROUP_SUMMARY) != 0) return null;
        if (Notification.CATEGORY_EMAIL.equals(n.category)) return "email";
        boolean chat = CHAT_APPS.contains(app) || app.equals(Telephony.Sms.getDefaultSmsPackage(this)) || Notification.CATEGORY_MESSAGE.equals(n.category);
        return chat ? "chat" : null;
    }

    private void record(StatusBarNotification sbn, boolean announce) {
        String kind = kindOf(sbn);
        if (kind == null) return;
        Notification n = sbn.getNotification();
        String app = sbn.getPackageName();
        String appName = appLabel(sbn);
        ReadRules.sawApp(this, app, appName, kind);
        if (!ReadRules.appAllowed(this, app)) return;
        if ("email".equals(kind)) {
            recordEmail(n, app, appName);
            return;
        }
        Bundle extras = n.extras;
        String title = text(extras.getCharSequence(Notification.EXTRA_TITLE));

        List<JSONObject> found = new ArrayList<>();
        NotificationCompat.MessagingStyle style = NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(n);
        String chat = style != null && style.getConversationTitle() != null ? text(style.getConversationTitle()) : title;
        ReadRules.sawChat(this, app, appName, chat);
        if (!ReadRules.chatAllowed(this, app, chat)) return;
        try {
            if (style != null && !style.getMessages().isEmpty()) {
                for (NotificationCompat.MessagingStyle.Message m : style.getMessages()) {
                    Person person = m.getPerson();
                    if (person == null) continue; // written by the user
                    String from = person.getName() == null ? chat : text(person.getName());
                    String body = text(m.getText());
                    if (!ReadRules.chatAllowed(this, app, from)) continue; // a person switched off, even in a group
                    found.add(message(app, appName, chat, from, body.isEmpty() ? "(a photo, voice note or file)" : body, m.getTimestamp()));
                }
            } else {
                String body = text(extras.getCharSequence(Notification.EXTRA_TEXT));
                // The app talking about itself ("WhatsApp: checking for new messages") isn't a message.
                if (title.isEmpty() || body.isEmpty() || title.equalsIgnoreCase(appName)) return;
                found.add(message(app, appName, title, title, body, n.when));
            }
        } catch (JSONException err) {
            return;
        }
        Notification.Action reply = replyAction(n);
        if (reply != null && !chat.isEmpty()) {
            replies.put(app + "|" + chat, reply);
            conversationOf.put(sbn.getKey(), app + "|" + chat);
        }

        List<JSONObject> fresh = remember(this, found);
        if (announce && !fresh.isEmpty()) {
            main.post(() -> {
                boolean first = toAnnounce.isEmpty();
                toAnnounce.addAll(fresh);
                if (first) main.postDelayed(this::announceGathered, GATHER_MS);
            });
        }
    }

    // An email: who from, the subject and the first lines, kept only for an account switched on. Never said out loud.
    private void recordEmail(Notification n, String app, String appName) {
        Bundle extras = n.extras;
        String account = text(extras.getCharSequence(Notification.EXTRA_SUB_TEXT));
        if (!account.contains("@")) account = text(extras.getCharSequence(Notification.EXTRA_SUMMARY_TEXT));
        if (!account.contains("@")) account = "";
        ReadRules.sawAccount(this, account, app, appName);
        if (!ReadRules.accountAllowed(this, ReadRules.accountKey(app, account))) return;
        String from = text(extras.getCharSequence(Notification.EXTRA_TITLE));
        String body = text(extras.getCharSequence(Notification.EXTRA_BIG_TEXT));
        if (body.isEmpty()) body = text(extras.getCharSequence(Notification.EXTRA_TEXT));
        if (from.isEmpty() || body.isEmpty()) return;
        body = body.replaceFirst("\\s*\\n\\s*", " — ").replaceAll("\\s+", " ");
        if (body.length() > 300) body = body.substring(0, 300) + "...";
        try {
            JSONObject mail = message(app, appName, account, from, body, n.when)
                .put("kind", "email")
                .put("account", account)
                .put("conversation", app + "|" + ReadRules.accountKey(app, account) + "|" + from);
            remember(this, java.util.Collections.singletonList(mail));
        } catch (JSONException ignored) {
            // Skip it.
        }
    }

    private void announceGathered() {
        List<JSONObject> batch = new ArrayList<>(toAnnounce);
        toAnnounce.clear();
        if (!batch.isEmpty()) announce(batch);
    }

    private static JSONObject message(String app, String appName, String chat, String from, String body, long at) throws JSONException {
        return new JSONObject()
            .put("pkg", app)
            .put("conversation", app + "|" + chat)
            .put("app", appName)
            .put("chat", chat)
            .put("from", from)
            .put("text", body)
            .put("at", at > 0 ? at : System.currentTimeMillis());
    }

    private void announce(List<JSONObject> fresh) {
        // Driving: every message is read out in full, so there's no reason to look at the phone.
        boolean driving = Driving.active(this);
        String mode = driving ? "full" : PhonePrefs.readMessages(this);
        if ("off".equals(mode) || !PhonePrefs.maySpeakNow(this)) return;
        if (Focus.active(this)) {
            // Focus mode: only the people let through are announced; the rest is summed up when it ends.
            List<JSONObject> through = new ArrayList<>();
            for (JSONObject m : fresh) if (Focus.letsThrough(this, m.optString("from"))) through.add(m);
            if (through.isEmpty()) return;
            fresh = through;
        }
        JSONObject last = fresh.get(fresh.size() - 1);
        String from = last.optString("from");
        String app = last.optString("app");
        Set<String> senders = new java.util.LinkedHashSet<>();
        for (JSONObject m : fresh) senders.add(m.optString("from") + (m.optString("app").equals(app) ? "" : " on " + m.optString("app")));
        String say;
        if ("full".equals(mode) && fresh.size() == 1 && !looksLikeCode(last.optString("text"))) {
            say = PhonePrefs.address(this) + ", " + from + " on " + app + ": " + last.optString("text");
        } else if (senders.size() > 1) {
            List<String> names = new ArrayList<>(senders);
            say = PhonePrefs.address(this) + ", " + fresh.size() + " new messages, from "
                + String.join(", ", names.subList(0, names.size() - 1)) + " and " + names.get(names.size() - 1) + ".";
        } else if (fresh.size() > 1) {
            say = PhonePrefs.address(this) + ", " + fresh.size() + " new " + app + " messages from " + from + ".";
        } else {
            say = PhonePrefs.address(this) + ", " + app + " message from " + from + ".";
        }
        if (driving) say += fresh.size() == 1 ? " Say hey LightMoon to reply." : " Say hey LightMoon to hear them.";
        if (MainActivity.visible && PhonePlugin.tellApp("messageArrived", say)) return;
        Voice.say(this, say, null);
    }

    // Adds the messages not seen before; returns those.
    private static synchronized List<JSONObject> remember(Context context, List<JSONObject> found) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        JSONArray all = load(prefs);
        Set<String> known = new HashSet<>();
        for (int i = 0; i < all.length(); i++) known.add(keyOf(all.optJSONObject(i)));
        List<JSONObject> fresh = new ArrayList<>();
        for (JSONObject m : found) {
            if (known.add(keyOf(m))) {
                all.put(m);
                fresh.add(m);
            }
        }
        if (fresh.isEmpty()) return fresh;
        long cutoff = System.currentTimeMillis() - KEEP_MS;
        JSONArray kept = new JSONArray();
        for (int i = Math.max(0, all.length() - KEEP); i < all.length(); i++) {
            JSONObject m = all.optJSONObject(i);
            if (m != null && m.optLong("at") >= cutoff) kept.put(m);
        }
        prefs.edit().putString("list", kept.toString()).apply();
        return fresh;
    }

    // Messages since a time (ms), oldest first, each with canReply while its notification is showing (chats only).
    static synchronized JSONArray recent(Context context, long since) throws JSONException {
        JSONArray all = load(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE));
        JSONArray result = new JSONArray();
        for (int i = 0; i < all.length(); i++) {
            JSONObject m = all.optJSONObject(i);
            if (m == null || m.optLong("at") < since || !allowed(context, m)) continue;
            boolean email = "email".equals(m.optString("kind"));
            result.put(new JSONObject(m.toString()).put("canReply", !email && replies.containsKey(m.optString("conversation"))));
        }
        return result;
    }

    // Whether a kept message is still allowed by the reading rules (they may have changed since).
    private static boolean allowed(Context context, JSONObject m) {
        String conversation = m.optString("conversation");
        String app = m.optString("pkg", conversation.contains("|") ? conversation.substring(0, conversation.indexOf('|')) : "");
        if (!ReadRules.appAllowed(context, app)) return false;
        if ("email".equals(m.optString("kind"))) return ReadRules.accountAllowed(context, ReadRules.accountKey(app, m.optString("account")));
        return ReadRules.chatAllowed(context, app, m.optString("chat")) && ReadRules.chatAllowed(context, app, m.optString("from"));
    }

    // Forgets kept messages the rules no longer allow.
    static synchronized void purge(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        JSONArray all = load(prefs);
        JSONArray kept = new JSONArray();
        for (int i = 0; i < all.length(); i++) {
            JSONObject m = all.optJSONObject(i);
            if (m != null && allowed(context, m)) kept.put(m);
        }
        if (kept.length() != all.length()) prefs.edit().putString("list", kept.toString()).apply();
    }

    // Answers a conversation through its notification's reply box. False if that notification is gone.
    static boolean reply(Context context, String conversation, String text) {
        Notification.Action action = replies.get(conversation);
        if (action == null || action.getRemoteInputs() == null) return false;
        Intent filled = new Intent();
        Bundle results = new Bundle();
        for (RemoteInput input : action.getRemoteInputs()) results.putCharSequence(input.getResultKey(), text);
        RemoteInput.addResultsToIntent(action.getRemoteInputs(), filled, results);
        try {
            action.actionIntent.send(context, 0, filled);
            return true;
        } catch (PendingIntent.CanceledException err) {
            replies.remove(conversation);
            return false;
        }
    }

    private static Notification.Action replyAction(Notification n) {
        List<Notification.Action> actions = new ArrayList<>();
        if (n.actions != null) actions.addAll(Arrays.asList(n.actions));
        actions.addAll(new Notification.WearableExtender(n).getActions());
        Notification.Action any = null;
        for (Notification.Action action : actions) {
            RemoteInput[] inputs = action.getRemoteInputs();
            if (inputs == null || inputs.length == 0) continue;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && action.getSemanticAction() == Notification.Action.SEMANTIC_ACTION_REPLY) return action;
            if (any == null) any = action;
        }
        return any;
    }

    // The app's name, from the notification itself (Android 11+ hides other apps' details unless they're listed).
    @SuppressWarnings("deprecation")
    private String appLabel(StatusBarNotification sbn) {
        String app = sbn.getPackageName();
        if (app.equals(Telephony.Sms.getDefaultSmsPackage(this)) || app.equals("com.google.android.apps.messaging")) return "text";
        PackageManager pm = getPackageManager();
        Object info = sbn.getNotification().extras.get("android.appInfo");
        if (info instanceof ApplicationInfo) return String.valueOf(pm.getApplicationLabel((ApplicationInfo) info));
        try {
            return String.valueOf(pm.getApplicationLabel(pm.getApplicationInfo(app, 0)));
        } catch (PackageManager.NameNotFoundException err) {
            return app.substring(app.lastIndexOf('.') + 1);
        }
    }

    private static String keyOf(JSONObject m) {
        return m == null ? "" : m.optString("conversation") + "|" + m.optLong("at") + "|" + m.optString("text").hashCode();
    }

    // Who wrote since `since`, oldest first, one entry per message (for the focus summary, Focus.end).
    static synchronized List<String> sendersSince(Context context, long since) {
        JSONArray all = load(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE));
        List<String> senders = new ArrayList<>();
        for (int i = 0; i < all.length(); i++) {
            JSONObject m = all.optJSONObject(i);
            if (m != null && m.optLong("at") >= since && !m.optString("from").isEmpty()) senders.add(m.optString("from"));
        }
        return senders;
    }

    private static JSONArray load(SharedPreferences prefs) {
        try {
            return new JSONArray(prefs.getString("list", "[]"));
        } catch (JSONException err) {
            return new JSONArray();
        }
    }

    private static String text(CharSequence value) {
        return value == null ? "" : value.toString().trim();
    }
}
