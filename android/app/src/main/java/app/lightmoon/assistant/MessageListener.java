package app.lightmoon.assistant;

import android.app.Notification;
import android.app.PendingIntent;
import android.app.RemoteInput;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.provider.Telephony;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;
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

// New messages (SMS, WhatsApp, Telegram, Signal and other chat apps), seen through their notifications once
// the user gives LightMoon notification access. LightMoon keeps the last two days of them on this phone,
// says new ones out loud (as chosen in Settings), and can answer through the notification's own reply box.
public class MessageListener extends NotificationListenerService {

    private static final Set<String> CHAT_APPS = new HashSet<>(Arrays.asList(
        "com.whatsapp", "com.whatsapp.w4b", "org.telegram.messenger", "org.thoughtcrime.securesms",
        "com.google.android.apps.messaging", "com.samsung.android.messaging"));
    private static final String PREFS = "lightmoon.messages";
    private static final int KEEP = 80;
    private static final long KEEP_MS = 2 * 86_400_000L;
    // One-time codes and security messages are never read out loud (only who sent them). Same rule as
    // docs/js/phone.js; "pin code" alone is a postal code in India.
    private static final Pattern SECURITY_CODE = Pattern.compile(
        "\\b(otp|one[- ]?time|verification|security code|passcode|login code|auth\\w* code|pin(?!\\s*code))\\b", Pattern.CASE_INSENSITIVE);

    // Reply actions by conversation, while their notification is showing (they can't be saved).
    private static final Map<String, Notification.Action> replies = new ConcurrentHashMap<>();

    static boolean isEnabled(Context context) {
        return NotificationManagerCompat.getEnabledListenerPackages(context).contains(context.getPackageName());
    }

    @Override
    public void onListenerConnected() {
        // What's already on screen is old news: remember it without announcing it.
        try {
            for (StatusBarNotification sbn : getActiveNotifications()) record(sbn, false);
        } catch (RuntimeException ignored) {
            // Not ready yet; new messages still come through onNotificationPosted.
        }
    }

    @Override
    public void onNotificationPosted(StatusBarNotification sbn) {
        record(sbn, true);
    }

    private boolean isChat(StatusBarNotification sbn) {
        String app = sbn.getPackageName();
        if (app.equals(getPackageName()) || sbn.isOngoing()) return false;
        Notification n = sbn.getNotification();
        if ((n.flags & Notification.FLAG_GROUP_SUMMARY) != 0) return false;
        return CHAT_APPS.contains(app) || app.equals(Telephony.Sms.getDefaultSmsPackage(this)) || Notification.CATEGORY_MESSAGE.equals(n.category);
    }

    private void record(StatusBarNotification sbn, boolean announce) {
        if (!isChat(sbn)) return;
        Notification n = sbn.getNotification();
        String app = sbn.getPackageName();
        String appName = appLabel(app);
        Bundle extras = n.extras;
        String title = text(extras.getCharSequence(Notification.EXTRA_TITLE));

        List<JSONObject> found = new ArrayList<>();
        NotificationCompat.MessagingStyle style = NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(n);
        String chat = style != null && style.getConversationTitle() != null ? text(style.getConversationTitle()) : title;
        try {
            if (style != null && !style.getMessages().isEmpty()) {
                for (NotificationCompat.MessagingStyle.Message m : style.getMessages()) {
                    Person person = m.getPerson();
                    if (person == null) continue; // written by the user
                    String from = person.getName() == null ? chat : text(person.getName());
                    String body = text(m.getText());
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
        if (reply != null && !chat.isEmpty()) replies.put(app + "|" + chat, reply);

        List<JSONObject> fresh = remember(this, found);
        if (announce && !fresh.isEmpty()) announce(fresh);
    }

    private static JSONObject message(String app, String appName, String chat, String from, String body, long at) throws JSONException {
        return new JSONObject()
            .put("conversation", app + "|" + chat)
            .put("app", appName)
            .put("chat", chat)
            .put("from", from)
            .put("text", body)
            .put("at", at > 0 ? at : System.currentTimeMillis());
    }

    private void announce(List<JSONObject> fresh) {
        String mode = PhonePrefs.readMessages(this);
        if ("off".equals(mode) || !PhonePrefs.maySpeakNow(this)) return;
        JSONObject last = fresh.get(fresh.size() - 1);
        String from = last.optString("from");
        String app = last.optString("app");
        String say;
        if ("full".equals(mode) && fresh.size() == 1 && !SECURITY_CODE.matcher(last.optString("text")).find()) {
            say = PhonePrefs.address(this) + ", " + from + " on " + app + ": " + last.optString("text");
        } else if (fresh.size() > 1) {
            say = PhonePrefs.address(this) + ", " + fresh.size() + " new " + app + " messages from " + from + ".";
        } else {
            say = PhonePrefs.address(this) + ", " + app + " message from " + from + ".";
        }
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

    // Messages since a time (ms), oldest first, each with canReply while its notification is showing.
    static synchronized JSONArray recent(Context context, long since) throws JSONException {
        JSONArray all = load(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE));
        JSONArray result = new JSONArray();
        for (int i = 0; i < all.length(); i++) {
            JSONObject m = all.optJSONObject(i);
            if (m == null || m.optLong("at") < since) continue;
            result.put(new JSONObject(m.toString()).put("canReply", replies.containsKey(m.optString("conversation"))));
        }
        return result;
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

    private String appLabel(String app) {
        if (app.equals(Telephony.Sms.getDefaultSmsPackage(this)) || app.equals("com.google.android.apps.messaging")) return "text";
        try {
            PackageManager pm = getPackageManager();
            return String.valueOf(pm.getApplicationLabel(pm.getApplicationInfo(app, 0)));
        } catch (PackageManager.NameNotFoundException err) {
            return "chat";
        }
    }

    private static String keyOf(JSONObject m) {
        return m == null ? "" : m.optString("conversation") + "|" + m.optLong("at") + "|" + m.optString("text").hashCode();
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
