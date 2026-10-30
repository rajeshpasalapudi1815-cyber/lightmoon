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
public class SendHelper extends AccessibilityService {

    private static final long ARMED_FOR_MS = 15_000;
    private static final Pattern SEND = Pattern.compile("^(send|send message|send email|send now)$", Pattern.CASE_INSENSITIVE);
    private static final List<String> SEND_IDS = Arrays.asList("com.whatsapp:id/send", "com.whatsapp.w4b:id/send");

    static volatile SendHelper running;
    private static volatile List<String> armedApps = new ArrayList<>();
    private static volatile String armedWords = "";
    private static volatile long armedUntil = 0;

    private final Handler main = new Handler(Looper.getMainLooper());

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

    // Ready to tap Send in one of these apps, on a draft containing these words, for the next few seconds.
    static void arm(List<String> apps, String words) {
        armedApps = new ArrayList<>(apps);
        armedWords = clean(words);
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
