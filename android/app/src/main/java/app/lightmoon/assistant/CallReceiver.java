package app.lightmoon.assistant;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.telephony.TelephonyManager;

// A call is coming in: say who it is ("Call from Mom."), if the user turned that on and the phone may ring.
// Android sends the ringing state twice, the second time with the number (that needs the call log permission).
public class CallReceiver extends BroadcastReceiver {

    private static final long SAME_CALL_MS = 30_000;
    private static String lastNumber;
    private static long lastAt;

    @Override
    @SuppressWarnings("deprecation") // EXTRA_INCOMING_NUMBER is still how a non-dialer app learns the number
    public void onReceive(Context context, Intent intent) {
        if (!TelephonyManager.ACTION_PHONE_STATE_CHANGED.equals(intent.getAction())) return;
        String state = intent.getStringExtra(TelephonyManager.EXTRA_STATE);
        if (!TelephonyManager.EXTRA_STATE_RINGING.equals(state)) {
            Voice.stopAll(); // answered or hung up: stop talking (and drop waiting message announcements)
            return;
        }
        String number = intent.getStringExtra(TelephonyManager.EXTRA_INCOMING_NUMBER);
        if (number == null || !PhonePrefs.announceCalls(context)) return;
        long now = System.currentTimeMillis();
        synchronized (CallReceiver.class) {
            if (number.equals(lastNumber) && now - lastAt < SAME_CALL_MS) return;
            lastNumber = number;
            lastAt = now;
        }
        if (!PhonePrefs.maySpeakNow(context)) return; // silent or vibrate: the user doesn't want sound
        String name = Contacts.nameFor(context, number);
        if (!Focus.letsThrough(context, name != null ? name : number)) return; // focus mode: summed up when it ends
        String say = name != null ? "Call from " + name + "." : "Call from a number not in your contacts.";
        PendingResult pending = goAsync();
        Voice.say(context, say, pending::finish);
    }
}
