package app.lightmoon.assistant;

import android.app.KeyguardManager;
import android.content.Context;
import java.util.ArrayDeque;

// The phone's own last line of defence for what the page may do. The page asks the user before it calls or sends,
// but the page is loaded from the web: if it were ever tampered with, these checks still hold, on the phone itself.
//  - Service codes ("*21*...#", "##002#") change call forwarding or the SIM: never dialled.
//  - Nothing is dialled, sent or scheduled while the phone is locked.
//  - No more than MAX_PER_HOUR calls and messages go out in an hour.
final class Guard {

    private static final int MAX_PER_HOUR = 20;
    private static final long HOUR_MS = 3_600_000;
    private static final ArrayDeque<Long> sent = new ArrayDeque<>();

    private Guard() {}

    static boolean isServiceCode(String number) {
        return number != null && (number.contains("*") || number.contains("#"));
    }

    static boolean locked(Context context) {
        KeyguardManager keyguard = context.getSystemService(KeyguardManager.class);
        return keyguard != null && keyguard.isKeyguardLocked();
    }

    private static synchronized boolean allowAnother() {
        long now = System.currentTimeMillis();
        while (!sent.isEmpty() && now - sent.peekFirst() > HOUR_MS) sent.pollFirst();
        if (sent.size() >= MAX_PER_HOUR) return false;
        sent.addLast(now);
        return true;
    }

    // Why a call or a message can't go now, or null when it can (which also counts it).
    static String refusal(Context context) {
        if (locked(context)) return "The phone is locked. Unlock it first.";
        if (!allowAnother()) return "That is a lot of calls and messages in one hour, so I have stopped. Try again later.";
        return null;
    }
}
