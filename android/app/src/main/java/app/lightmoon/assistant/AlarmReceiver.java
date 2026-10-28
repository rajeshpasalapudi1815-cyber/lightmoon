package app.lightmoon.assistant;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import androidx.core.content.ContextCompat;

// A reminder's alarm went off: have it spoken (or, if LightMoon is on screen, let the app announce it).
public class AlarmReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        String id = intent.getStringExtra("id");
        ReminderStore.Reminder reminder = id == null ? null : ReminderStore.get(context, id);
        if (reminder == null) return;
        if (MainActivity.visible && ReminderAlarmsPlugin.notifyDue(reminder)) return;
        try {
            ContextCompat.startForegroundService(context, new Intent(context, SpeakService.class).putExtra("id", id));
        } catch (IllegalStateException err) {
            // Android refused to start it from the background (only for late, inexact alarms): just notify.
            SpeakService.showReminder(context, reminder);
        }
    }
}
