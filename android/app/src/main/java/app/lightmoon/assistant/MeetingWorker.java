package app.lightmoon.assistant;

import android.content.Context;
import androidx.annotation.NonNull;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import java.util.concurrent.TimeUnit;

// Every 15 minutes (Android's shortest), sets the meeting announcements again, so meetings added or moved
// in the calendar are announced even if LightMoon isn't opened.
public class MeetingWorker extends Worker {

    private static final String WORK_NAME = "lightmoon-meetings";

    public MeetingWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    // Also watches the calendar for changes (CalendarWatcher), so new meetings don't wait for the next refresh.
    static void start(Context context) {
        PeriodicWorkRequest request = new PeriodicWorkRequest.Builder(MeetingWorker.class, 15, TimeUnit.MINUTES).build();
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(WORK_NAME, ExistingPeriodicWorkPolicy.KEEP, request);
        CalendarWatcher.start(context);
    }

    static void stop(Context context) {
        WorkManager.getInstance(context).cancelUniqueWork(WORK_NAME);
        CalendarWatcher.stop(context);
    }

    @NonNull
    @Override
    public Result doWork() {
        Meetings.reschedule(getApplicationContext());
        return Result.success();
    }
}
