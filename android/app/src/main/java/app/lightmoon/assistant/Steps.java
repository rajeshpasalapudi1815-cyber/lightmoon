package app.lightmoon.assistant;

import android.Manifest;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import androidx.core.content.ContextCompat;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

// Steps today, from the phone's own step counter (the chip most phones have; no app or account needed). The
// counter only says "steps since the phone started", so the first reading of each day is kept as that day's
// starting point; SyncWorker takes a reading every 15 minutes, so the day's start is caught close to midnight.
final class Steps {

    private static final String PREFS = "lightmoon.steps";
    private static final long WAIT_MS = 3000;

    private Steps() {}

    static boolean allowed(Context context) {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.Q
            || ContextCompat.checkSelfPermission(context, Manifest.permission.ACTIVITY_RECOGNITION) == PackageManager.PERMISSION_GRANTED;
    }

    static boolean available(Context context) {
        SensorManager sensors = context.getSystemService(SensorManager.class);
        return sensors != null && sensors.getDefaultSensor(Sensor.TYPE_STEP_COUNTER) != null;
    }

    // Steps today, or -1 when it can't tell (no counter, no permission, no reading in time). Blocks up to 3 s:
    // not on the main thread.
    static int today(Context context) {
        if (!allowed(context) || !available(context)) return -1;
        float counter = readCounter(context);
        if (counter < 0) return -1;
        return update(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE), SyncWorker.localStamp(System.currentTimeMillis()).substring(0, 10), (long) counter);
    }

    // Keeps the day's starting point and returns today's steps. A new day starts from the last reading of the day
    // before; a restart of the phone (the counter went back) starts again from zero.
    static int update(SharedPreferences prefs, String day, long counter) {
        String savedDay = prefs.getString("day", "");
        long base = prefs.getLong("base", -1);
        long last = prefs.getLong("last", -1);
        long done = prefs.getLong("done", 0); // steps today before a restart of the phone
        if (!day.equals(savedDay)) {
            base = last >= 0 && last <= counter ? last : counter;
            done = 0;
        } else if (counter < last) {
            done += Math.max(0, last - base);
            base = 0;
        }
        prefs.edit().putString("day", day).putLong("base", base).putLong("last", counter).putLong("done", done).apply();
        return (int) Math.max(0, done + counter - base);
    }

    private static float readCounter(Context context) {
        SensorManager sensors = context.getSystemService(SensorManager.class);
        Sensor counter = sensors.getDefaultSensor(Sensor.TYPE_STEP_COUNTER);
        HandlerThread thread = new HandlerThread("lightmoon-steps");
        thread.start();
        float[] value = { -1 };
        CountDownLatch got = new CountDownLatch(1);
        SensorEventListener listener = new SensorEventListener() {
            @Override
            public void onSensorChanged(SensorEvent event) {
                value[0] = event.values[0];
                got.countDown();
            }

            @Override
            public void onAccuracyChanged(Sensor sensor, int accuracy) {}
        };
        try {
            sensors.registerListener(listener, counter, SensorManager.SENSOR_DELAY_NORMAL, new Handler(thread.getLooper()));
            got.await(WAIT_MS, TimeUnit.MILLISECONDS);
        } catch (InterruptedException err) {
            Thread.currentThread().interrupt();
        } finally {
            sensors.unregisterListener(listener);
            thread.quitSafely();
        }
        return value[0];
    }
}
