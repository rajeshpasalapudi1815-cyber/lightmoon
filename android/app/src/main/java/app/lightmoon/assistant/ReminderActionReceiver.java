package app.lightmoon.assistant;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import androidx.core.app.NotificationManagerCompat;

// "Done", "Snooze 10 min" or "Stop asking" tapped on a reminder's notification, with LightMoon open or not.
// The phone stops its alarms for the task at once (a snooze rings once more in ten minutes), keeps the answer
// for the app, and has SyncWorker write it into the synced copy so the user's other devices stop asking too.
public class ReminderActionReceiver extends BroadcastReceiver {

    static final String DONE = "done";
    static final String SNOOZE = "snooze";
    static final String STOP = "stop";
    private static final long SNOOZE_MS = 10 * 60_000L;
    private static final String ACTION = "app.lightmoon.assistant.ANSWER";

    static PendingIntent intent(Context context, ReminderStore.Reminder reminder, String answer) {
        Intent intent = new Intent(context, ReminderActionReceiver.class)
            .setAction(ACTION)
            .setData(Uri.parse("lightmoon://answer/" + answer + "/" + Uri.encode(reminder.id)))
            .putExtra("id", reminder.id)
            .putExtra("answer", answer)
            .putExtra("title", reminder.title)
            .putExtra("say", reminder.say);
        return PendingIntent.getBroadcast(context, 0, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        String id = intent.getStringExtra("id");
        String answer = intent.getStringExtra("answer");
        if (!ReminderStore.isTaskAlert(id) || answer == null) return;
        String taskId = ReminderStore.taskIdOf(id);
        NotificationManagerCompat.from(context).cancel(taskId.hashCode());

        long now = System.currentTimeMillis();
        long until = SNOOZE.equals(answer) ? now + SNOOZE_MS : 0;
        // The reminder's own words for the second ring, if the phone still has them (a check-in was tapped).
        ReminderStore.Reminder main = ReminderStore.get(context, taskId);
        String say = main != null ? main.say : intent.getStringExtra("say");
        ReminderStore.addAnswer(context, taskId, answer, now, until);
        ReminderStore.dropTask(context, taskId);
        if (until > 0 && say != null) ReminderStore.add(context, new ReminderStore.Reminder(taskId, intent.getStringExtra("title"), say, until, now));
        SyncWorker.runSoon(context);
    }
}
