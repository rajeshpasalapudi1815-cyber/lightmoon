package app.lightmoon.assistant;

import android.content.Context;
import android.provider.CalendarContract;
import androidx.annotation.NonNull;
import androidx.work.Constraints;
import androidx.work.ExistingWorkPolicy;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import java.util.concurrent.TimeUnit;

// Runs when the calendar changes (a meeting added, moved or cancelled, in any calendar app or synced from
// Google), so its announcement is set straight away instead of at the next 15-minute refresh. Android's
// change triggers fire once, so each run asks to be woken for the next change.
public class CalendarWatcher extends Worker {

    private static final String WORK_NAME = "lightmoon-calendar-changes";

    public CalendarWatcher(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    static void start(Context context) {
        Constraints onChange = new Constraints.Builder()
            .addContentUriTrigger(CalendarContract.Events.CONTENT_URI, true)
            .setTriggerContentUpdateDelay(5, TimeUnit.SECONDS) // a sync often changes several events at once
            .setTriggerContentMaxDelay(60, TimeUnit.SECONDS)
            .build();
        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(CalendarWatcher.class).setConstraints(onChange).build();
        WorkManager.getInstance(context).enqueueUniqueWork(WORK_NAME, ExistingWorkPolicy.REPLACE, request);
    }

    static void stop(Context context) {
        WorkManager.getInstance(context).cancelUniqueWork(WORK_NAME);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context context = getApplicationContext();
        Meetings.reschedule(context);
        if (PhonePrefs.meetingLead(context) > 0 && Meetings.canRead(context)) start(context);
        return Result.success();
    }
}
