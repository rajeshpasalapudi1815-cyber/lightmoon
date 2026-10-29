package app.lightmoon.assistant;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import androidx.core.content.ContextCompat;

// Focus time is up (Focus.start set this alarm): the phone goes back as it was and LightMoon says what came in.
public class FocusReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        String say = Focus.end(context);
        if (say == null) return;
        if (MainActivity.visible && PhonePlugin.tellApp("focusEnded", say)) return;
        Intent speak = new Intent(context, SpeakService.class)
            .putExtra("say", say)
            .putExtra("title", "Focus")
            .putExtra("sayId", "focus-" + System.currentTimeMillis());
        try {
            ContextCompat.startForegroundService(context, speak);
        } catch (IllegalStateException err) {
            // Android refused to start it from the background: the next conversation picks it up from the app.
        }
    }
}
