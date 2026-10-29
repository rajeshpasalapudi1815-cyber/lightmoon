package app.lightmoon.assistant;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import androidx.core.content.ContextCompat;

// Briefing time: set tomorrow's alarm, and have SpeakService put the briefing together and say it.
public class BriefingReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        String kind = intent.getStringExtra("kind");
        if (kind == null) return;
        Briefings.schedule(context, kind);
        try {
            ContextCompat.startForegroundService(context, new Intent(context, SpeakService.class).putExtra("briefing", kind));
        } catch (IllegalStateException err) {
            // Android refused the speaking service from the background (late, inexact alarm): skip this one.
        }
    }
}
