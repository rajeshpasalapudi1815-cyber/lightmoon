package app.lightmoon.assistant;

import android.annotation.SuppressLint;
import android.app.PendingIntent;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.service.quicksettings.Tile;
import android.service.quicksettings.TileService;

// A quick-settings tile (pull down from the top of the screen) that shows at a glance whether LightMoon is
// listening for its wake phrases, like the microphone and camera toggles, and switches it on or off with a tap.
// Turning it on opens LightMoon, since Android lets the microphone start listening only from an open app.
public class WakeTile extends TileService {

    @Override
    public void onStartListening() {
        paint();
    }

    @Override
    public void onClick() {
        if (WakeWordPlugin.isEnabled(this)) {
            WakeWordPlugin.setEnabled(this, false);
            stopService(new Intent(this, WakeWordService.class));
            paint();
            return;
        }
        WakeWordPlugin.setEnabled(this, true);
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        openAndCollapse(open);
    }

    @SuppressLint("StartActivityAndCollapseDeprecated")
    @SuppressWarnings("deprecation")
    private void openAndCollapse(Intent open) {
        if (Build.VERSION.SDK_INT >= 34) {
            startActivityAndCollapse(PendingIntent.getActivity(this, 4, open, PendingIntent.FLAG_IMMUTABLE));
        } else {
            startActivityAndCollapse(open);
        }
    }

    private void paint() {
        Tile tile = getQsTile();
        if (tile == null) return;
        boolean on = WakeWordPlugin.isEnabled(this);
        String state = WakeWordService.running != null ? WakeWordService.state : "off";
        tile.setLabel("LightMoon ears");
        tile.setState(on && WakeModel.ready(this) ? Tile.STATE_ACTIVE : Tile.STATE_INACTIVE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            tile.setSubtitle(!on ? "Off" : "listening".equals(state) ? "Listening" : "paused".equals(state) ? "Paused, app open"
                : "heard".equals(state) ? "Heard you" : WakeWordService.running == null ? "On, open app to start" : "Starting");
        }
        tile.updateTile();
    }

    // Asks Android to repaint the tile (the state changed).
    static void refresh(Context context) {
        try {
            TileService.requestListeningState(context, new ComponentName(context, WakeTile.class));
        } catch (RuntimeException err) {
            // No tile added; nothing to repaint.
        }
    }
}
