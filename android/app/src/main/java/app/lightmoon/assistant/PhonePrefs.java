package app.lightmoon.assistant;

import android.content.Context;
import android.content.SharedPreferences;
import android.media.AudioManager;
import android.telephony.TelephonyManager;

// What the user chose in Settings → Phone (set from the web app through PhonePlugin.configure), and
// whether now is a moment LightMoon may speak up about calls and messages.
final class PhonePrefs {

    private static final String PREFS = "lightmoon.phone";

    private PhonePrefs() {}

    static SharedPreferences get(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    // Meetings: said out loud this many minutes before they start (0 = off).
    static int meetingLead(Context context) {
        return get(context).getInt("meetingLead", 10);
    }

    static boolean announceCalls(Context context) {
        return get(context).getBoolean("announceCalls", true);
    }

    // New messages: "off", "sender" (who it's from) or "full" (and what they wrote).
    static String readMessages(Context context) {
        return get(context).getString("readMessages", "sender");
    }

    // How LightMoon addresses the user out loud, e.g. "Sir".
    static String address(Context context) {
        return get(context).getString("address", "Sir");
    }

    // Calls and messages are only spoken when the phone is allowed to make sound and isn't in a call.
    static boolean maySpeakNow(Context context) {
        AudioManager audio = context.getSystemService(AudioManager.class);
        if (audio == null || audio.getRingerMode() != AudioManager.RINGER_MODE_NORMAL) return false;
        return audio.getMode() != AudioManager.MODE_IN_CALL && audio.getMode() != AudioManager.MODE_IN_COMMUNICATION;
    }

    static boolean inCall(Context context) {
        AudioManager audio = context.getSystemService(AudioManager.class);
        return audio != null && (audio.getMode() == AudioManager.MODE_IN_CALL || audio.getMode() == AudioManager.MODE_IN_COMMUNICATION);
    }

    static boolean hasTelephony(Context context) {
        TelephonyManager telephony = context.getSystemService(TelephonyManager.class);
        return telephony != null && telephony.getPhoneType() != TelephonyManager.PHONE_TYPE_NONE;
    }
}
