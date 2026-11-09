package app.lightmoon.assistant;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.media.AudioManager;
import androidx.core.content.ContextCompat;

// The volume-down button silences LightMoon: whatever it is saying (a reminder, a briefing, a caller's name, the app's
// own reply) stops, and the volume goes back to where it was, so the button works as "be quiet" rather than turning
// the phone down. Only while LightMoon is speaking: any other time the button just turns the volume down.
// On screen, MainActivity catches the key itself; with the screen off or LightMoon in the background, Android
// says only that a volume went down (VOLUME_CHANGED_ACTION, sent by the system to whoever is listening).
final class VolumeStop {

    private static final String VOLUME_CHANGED = "android.media.VOLUME_CHANGED_ACTION";
    private static final String STREAM = "android.media.EXTRA_VOLUME_STREAM_TYPE";
    private static final String VALUE = "android.media.EXTRA_VOLUME_STREAM_VALUE";
    private static final String PREVIOUS = "android.media.EXTRA_PREV_VOLUME_STREAM_VALUE";

    // The page's speech (docs/app.js tells PhonePlugin.speaking when it starts and stops).
    static volatile boolean pageSpeaking = false;
    private static boolean watching;

    private VolumeStop() {}

    static boolean anythingSpeaking() {
        return pageSpeaking || SpeakService.speakingNow() || Voice.active();
    }

    // Starts listening for volume changes, once for as long as LightMoon's process lives.
    static synchronized void watch(Context context) {
        if (watching) return;
        Context app = context.getApplicationContext();
        BroadcastReceiver receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context c, Intent intent) {
                int now = intent.getIntExtra(VALUE, -1);
                int before = intent.getIntExtra(PREVIOUS, -1);
                if (now < 0 || before < 0 || now >= before || !anythingSpeaking()) return;
                stopAll(c);
                try {
                    AudioManager audio = c.getSystemService(AudioManager.class);
                    int stream = intent.getIntExtra(STREAM, -1);
                    if (audio != null && stream >= 0) audio.setStreamVolume(stream, before, 0); // as it was
                } catch (RuntimeException err) {
                    // Do Not Disturb may refuse it: the volume stays one step lower, LightMoon is still quiet.
                }
            }
        };
        try {
            ContextCompat.registerReceiver(app, receiver, new IntentFilter(VOLUME_CHANGED), ContextCompat.RECEIVER_EXPORTED);
            watching = true;
        } catch (RuntimeException err) {
            // Not allowed on this phone: the button works only while LightMoon is on screen.
        }
    }

    // Everything LightMoon is saying stops.
    static void stopAll(Context context) {
        Voice.stopAll();
        SpeakService.stopNow();
        if (pageSpeaking) PhonePlugin.tellApp("stopSpeaking", "");
        pageSpeaking = false;
    }
}
