package app.lightmoon.assistant;

import android.accessibilityservice.AccessibilityService;
import android.content.ComponentName;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;
import android.text.TextUtils;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.widget.Toast;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;

// The Send helper: taps Send on a message LightMoon wrote into Teams, WhatsApp, Gmail or Outlook, after the user
// said "send it". Android only allows this through an accessibility service, which the user switches on in
// Settings. It is limited on purpose:
// - it only gets events from those four apps (res/xml/send_helper.xml), and ignores them all unless armed;
// - LightMoon arms it for 15 seconds, for the app it opened the draft in and the words it wrote, only when the
//   user just said to send it (docs/js/tools.js tap_send);
// - it taps only when those words are on screen, and only a button called Send; then it disarms.
// It reads nothing else and keeps nothing.
// It can also open a Teams chat by its name and type LightMoon's message there (openChat), when the user asks
// LightMoon to write to a chat it has no link for: it uses Teams' own search, the way the user would, step by step,
// and gives up after 25 seconds. It stops at the typed message unless they asked to send it.
public class SendHelper extends AccessibilityService {

    private static final long ARMED_FOR_MS = 15_000;
    private static final Pattern SEND = Pattern.compile("^(send|send message|send email|send now)$", Pattern.CASE_INSENSITIVE);
    private static final List<String> SEND_IDS = Arrays.asList("com.whatsapp:id/send", "com.whatsapp.w4b:id/send");

    static volatile SendHelper running;
    private static volatile List<String> armedApps = new ArrayList<>();
    private static volatile String armedWords = "";
    private static volatile long armedUntil = 0;

    private final Handler main = new Handler(Looper.getMainLooper());

    // ---------- Opening a Teams chat by name ----------
    static final String TEAMS = "com.microsoft.teams";
    private static final long CHAT_FOR_MS = 25_000;
    private static final long STEP_MS = 700;
    private static final Pattern SEARCH = Pattern.compile("^(search|search.*)$", Pattern.CASE_INSENSITIVE);
    private static final Pattern COMPOSE = Pattern.compile("(type|write) (a|your)? ?(new )?message|^message$|reply", Pattern.CASE_INSENSITIVE);
    private String chatName = "";
    private String chatText = "";
    private boolean chatSend = false;
    private String chatStep = "";
    private long chatUntil = 0;
    private int typeTries = 0;
    private static final Pattern NOT_A_CHAT = Pattern.compile("search|result|[\"“”'‘’]", Pattern.CASE_INSENSITIVE);

    // Opens Teams, finds the chat called chatName with Teams' search, and types the text. It never sends: that is
    // the user's own "send it" afterwards (tapSend), which checks this chat is the one on screen.
    static boolean openChat(Context context, String name, String text, boolean send) {
        SendHelper service = running;
        android.content.Intent launch = context.getPackageManager().getLaunchIntentForPackage(TEAMS);
        if (service == null || launch == null) return false;
        service.chatName = clean(name);
        service.chatText = text == null ? "" : text.trim();
        service.chatSend = false;
        service.chatStep = "search";
        service.chatUntil = SystemClock.elapsedRealtime() + CHAT_FOR_MS;
        context.startActivity(launch.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK));
        service.main.postDelayed(service::chatTick, 1500);
        return true;
    }

    private void chatTick() {
        if (chatStep.isEmpty()) return;
        if (SystemClock.elapsedRealtime() > chatUntil) {
            Toast.makeText(this, "LightMoon couldn't find \"" + chatName + "\" in Teams. Please open it yourself.", Toast.LENGTH_LONG).show();
            chatStep = "";
            return;
        }
        AccessibilityNodeInfo root = teamsWindow();
        if (root == null) android.util.Log.i("LightMoonSend", "no Teams window yet");
        if (root != null) {
            try {
                chatStep(root);
            } catch (RuntimeException err) {
                // The screen changed under us; try again next tick.
            }
        }
        if (!chatStep.isEmpty()) main.postDelayed(this::chatTick, STEP_MS);
    }

    private void chatStep(AccessibilityNodeInfo root) {
        android.util.Log.i("LightMoonSend", "chat step: " + chatStep); // the step only, never names or text
        switch (chatStep) {
            case "search": {
                AccessibilityNodeInfo box = findEditable(root, null);
                if (box != null && box.isFocused()) {
                    setText(box, chatName);
                    chatStep = "pick";
                    return;
                }
                AccessibilityNodeInfo search = findLabelled(root, SEARCH);
                if (search != null) click(search);
                return;
            }
            case "pick": {
                // A result row that is the chat itself, not "Search for 'NOC Team'" or "No results for ...".
                // Only a row whose name is the one asked for (or has it as a whole word: "Deeksha" in
                // "Kummari, Deeksha"); if rows with different names match, it stops rather than guess.
                String wanted = firstPart(chatName.toLowerCase(Locale.ROOT));
                List<AccessibilityNodeInfo> hits = findAll(root, node -> {
                    if (node.isEditable() || node.getText() == null) return false;
                    String shown = node.getText().toString();
                    if (NOT_A_CHAT.matcher(shown).find()) return false;
                    String name = firstPart(shown).toLowerCase(Locale.ROOT);
                    return name.equals(wanted) || (" " + name.replace(",", " ") + " ").contains(" " + wanted + " ");
                });
                java.util.Set<String> names = new java.util.HashSet<>();
                for (AccessibilityNodeInfo hit : hits) names.add(firstPart(hit.getText().toString()).toLowerCase(Locale.ROOT));
                if (names.size() > 1) {
                    Toast.makeText(this, "Several Teams chats match \"" + chatName + "\". Please open the right one yourself.", Toast.LENGTH_LONG).show();
                    chatStep = "";
                    return;
                }
                if (!hits.isEmpty() && click(hits.get(0))) {
                    chatStep = "type";
                    typeTries = 0;
                }
                return;
            }
            case "type": {
                AccessibilityNodeInfo box = findEditable(root, COMPOSE);
                if (box == null) {
                    // Still on the search screen (that wasn't the chat): look for it again.
                    if (++typeTries > 6) chatStep = "pick";
                    return;
                }
                click(box);
                setText(box, chatText);
                if (chatSend) {
                    arm(java.util.Collections.singletonList(TEAMS), chatText, chatName);
                } else {
                    Toast.makeText(this, "Message typed in Teams. Say \"send it\" to send.", Toast.LENGTH_SHORT).show();
                }
                chatStep = "";
                return;
            }
            default:
                chatStep = "";
        }
    }

    // Teams' window on screen: the active one, or else any window of Teams (the active window can briefly be the
    // keyboard or a system bar).
    private AccessibilityNodeInfo teamsWindow() {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root != null && root.getPackageName() != null && TEAMS.contentEquals(root.getPackageName())) return root;
        for (android.view.accessibility.AccessibilityWindowInfo window : getWindows()) {
            AccessibilityNodeInfo top = window.getRoot();
            if (top != null && top.getPackageName() != null && TEAMS.contentEquals(top.getPackageName())) return top;
        }
        return null;
    }

    // "Gunukonda, Akash | Saras America" -> "Gunukonda, Akash".
    private static String firstPart(String text) {
        int bar = text.indexOf('|');
        return (bar > 0 ? text.substring(0, bar) : text).trim();
    }

    private static boolean click(AccessibilityNodeInfo node) {
        AccessibilityNodeInfo target = node;
        while (target != null && !target.isClickable()) target = target.getParent();
        return target != null && target.performAction(AccessibilityNodeInfo.ACTION_CLICK);
    }

    private static void setText(AccessibilityNodeInfo box, String text) {
        android.os.Bundle args = new android.os.Bundle();
        args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
        box.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args);
    }

    private interface Match { boolean test(AccessibilityNodeInfo node); }

    private static List<AccessibilityNodeInfo> findAll(AccessibilityNodeInfo root, Match match) {
        List<AccessibilityNodeInfo> found = new ArrayList<>();
        List<AccessibilityNodeInfo> queue = new ArrayList<>();
        queue.add(root);
        for (int i = 0; i < queue.size() && i < 3000; i++) {
            AccessibilityNodeInfo node = queue.get(i);
            if (node == null) continue;
            if (node.isVisibleToUser() && match.test(node)) found.add(node);
            for (int c = 0; c < node.getChildCount(); c++) queue.add(node.getChild(c));
        }
        return found;
    }

    private static AccessibilityNodeInfo findText(AccessibilityNodeInfo root, Match match) {
        List<AccessibilityNodeInfo> queue = new ArrayList<>();
        queue.add(root);
        for (int i = 0; i < queue.size() && i < 3000; i++) {
            AccessibilityNodeInfo node = queue.get(i);
            if (node == null) continue;
            if (node.isVisibleToUser() && match.test(node)) return node;
            for (int c = 0; c < node.getChildCount(); c++) queue.add(node.getChild(c));
        }
        return null;
    }

    // An editable field; with hint, only one whose hint or description matches (the message box, not search).
    private static AccessibilityNodeInfo findEditable(AccessibilityNodeInfo root, Pattern hint) {
        return findText(root, node -> {
            if (!node.isEditable()) return false;
            if (hint == null) return true;
            CharSequence said = android.os.Build.VERSION.SDK_INT >= 26 && node.getHintText() != null ? node.getHintText()
                : node.getContentDescription() != null ? node.getContentDescription() : node.getText();
            return said != null && hint.matcher(said.toString()).find();
        });
    }

    private static AccessibilityNodeInfo findLabelled(AccessibilityNodeInfo root, Pattern label) {
        return findText(root, node -> {
            CharSequence said = node.getContentDescription() != null ? node.getContentDescription() : node.getText();
            return said != null && label.matcher(said.toString().trim()).matches();
        });
    }

    static boolean isEnabled(Context context) {
        String enabled = Settings.Secure.getString(context.getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
        if (enabled == null) return false;
        ComponentName me = new ComponentName(context, SendHelper.class);
        TextUtils.SimpleStringSplitter split = new TextUtils.SimpleStringSplitter(':');
        split.setString(enabled);
        for (String service : split) {
            ComponentName name = ComponentName.unflattenFromString(service);
            if (me.equals(name)) return true;
        }
        return false;
    }

    static final List<String> APPS = Arrays.asList(TEAMS, "com.whatsapp", "com.whatsapp.w4b", "com.google.android.gm", "com.microsoft.office.outlook");
    private static volatile String armedChat = "";

    // Ready to tap Send in one of these apps (only ever the four above), on a draft containing these words, in the
    // chat called chat when given, for the next few seconds.
    static void arm(List<String> apps, String words, String chat) {
        List<String> allowed = new ArrayList<>(apps);
        allowed.retainAll(APPS);
        if (allowed.isEmpty()) return;
        armedApps = allowed;
        armedWords = clean(words);
        armedChat = chat == null ? "" : firstPart(clean(chat));
        armedUntil = SystemClock.elapsedRealtime() + ARMED_FOR_MS;
        SendHelper service = running;
        if (service != null) {
            service.main.postDelayed(service::tryNow, 600);
            service.main.postDelayed(service::giveUpIfStillArmed, ARMED_FOR_MS + 200);
        }
    }

    private static void disarm() {
        armedUntil = 0;
        armedWords = "";
        armedChat = "";
        armedApps = new ArrayList<>();
    }

    private static boolean armed() {
        return armedUntil > SystemClock.elapsedRealtime() && !armedWords.isEmpty();
    }

    @Override
    protected void onServiceConnected() {
        running = this;
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        if (!armed() || event == null || event.getPackageName() == null) return;
        if (!armedApps.contains(event.getPackageName().toString())) return;
        tryNow();
    }

    private void tryNow() {
        if (!armed()) return;
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null || root.getPackageName() == null || !armedApps.contains(root.getPackageName().toString())) return;
        // Only the draft LightMoon wrote: its first words must be on screen.
        String start = armedWords.length() > 24 ? armedWords.substring(0, 24) : armedWords;
        if (!showsText(root, start)) return;
        // And in the chat the draft was meant for: its name shows at the top of that chat.
        if (!armedChat.isEmpty() && !showsName(root, armedChat)) return;
        AccessibilityNodeInfo send = findSend(root);
        if (send == null) return; // the screen may still be loading; the next event tries again
        AccessibilityNodeInfo target = send;
        while (target != null && !target.isClickable()) target = target.getParent();
        if (target != null && target.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
            disarm();
            Toast.makeText(this, "LightMoon tapped Send", Toast.LENGTH_SHORT).show();
        }
    }

    private void giveUpIfStillArmed() {
        if (armedUntil == 0 || armed()) return;
        disarm();
        Toast.makeText(this, "LightMoon couldn't find Send. Please tap it yourself.", Toast.LENGTH_LONG).show();
    }

    // The chat's name shown as a (non-editable) label, e.g. the header "Kummari, Deeksha".
    private static boolean showsName(AccessibilityNodeInfo root, String name) {
        String wanted = name.toLowerCase(Locale.ROOT);
        return findText(root, node -> !node.isEditable() && node.getText() != null
            && (" " + firstPart(node.getText().toString()).toLowerCase(Locale.ROOT).replace(",", " ") + " ").contains(" " + wanted + " ")) != null;
    }

    private static boolean showsText(AccessibilityNodeInfo root, String start) {
        String wanted = start.toLowerCase(Locale.ROOT);
        List<AccessibilityNodeInfo> stack = new ArrayList<>();
        stack.add(root);
        for (int seen = 0; !stack.isEmpty() && seen < 3000; seen++) {
            AccessibilityNodeInfo node = stack.remove(stack.size() - 1);
            if (node == null) continue;
            if (node.getText() != null && clean(node.getText().toString()).toLowerCase(Locale.ROOT).contains(wanted)) return true;
            for (int i = 0; i < node.getChildCount(); i++) stack.add(node.getChild(i));
        }
        return false;
    }

    private static AccessibilityNodeInfo findSend(AccessibilityNodeInfo root) {
        for (String id : SEND_IDS) {
            List<AccessibilityNodeInfo> found = root.findAccessibilityNodeInfosByViewId(id);
            for (AccessibilityNodeInfo node : found) if (node.isEnabled() && node.isVisibleToUser()) return node;
        }
        List<AccessibilityNodeInfo> stack = new ArrayList<>();
        stack.add(root);
        for (int seen = 0; !stack.isEmpty() && seen < 3000; seen++) {
            AccessibilityNodeInfo node = stack.remove(stack.size() - 1);
            if (node == null) continue;
            CharSequence label = node.getContentDescription() != null ? node.getContentDescription() : node.getText();
            if (label != null && SEND.matcher(label.toString().trim()).matches() && node.isEnabled() && node.isVisibleToUser()) return node;
            for (int i = 0; i < node.getChildCount(); i++) stack.add(node.getChild(i));
        }
        return null;
    }

    private static String clean(String text) {
        return text == null ? "" : text.replaceAll("\\s+", " ").trim();
    }

    @Override
    public void onInterrupt() {
        disarm();
    }

    @Override
    public void onDestroy() {
        running = null;
        disarm();
        super.onDestroy();
    }
}
