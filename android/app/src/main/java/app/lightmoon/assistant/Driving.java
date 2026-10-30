package app.lightmoon.assistant;

import android.content.Context;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;
import java.util.ArrayList;
import java.util.List;

// Driving mode: messages are read out in full (not just who they're from), so the user never has to look at the
// phone, and LightMoon keeps its answers short. On for a while when they say "I'm driving", and on by itself
// whenever the phone is connected to the car they told LightMoon about ("this is my car"), by the name of its
// Bluetooth audio. Reading what is connected needs no extra permission.
final class Driving {

    private static final String UNTIL = "drivingUntil";
    private static final String CAR = "carName";

    private Driving() {}

    static void start(Context context, long until) {
        PhonePrefs.get(context).edit().putLong(UNTIL, until).apply();
    }

    static void end(Context context) {
        PhonePrefs.get(context).edit().putLong(UNTIL, 0).apply();
    }

    static long until(Context context) {
        return PhonePrefs.get(context).getLong(UNTIL, 0);
    }

    static String car(Context context) {
        return PhonePrefs.get(context).getString(CAR, "");
    }

    static void rememberCar(Context context, String name) {
        PhonePrefs.get(context).edit().putString(CAR, name == null ? "" : name.trim()).apply();
    }

    // "manual" (they said so), "car" (connected to their car), or null.
    static String why(Context context) {
        if (until(context) > System.currentTimeMillis()) return "manual";
        String car = car(context);
        if (!car.isEmpty() && connectedAudio(context).contains(car)) return "car";
        return null;
    }

    static boolean active(Context context) {
        return why(context) != null;
    }

    // Names of the Bluetooth audio devices connected now (car stereos, earbuds).
    static List<String> connectedAudio(Context context) {
        List<String> names = new ArrayList<>();
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return names;
        AudioManager audio = context.getSystemService(AudioManager.class);
        if (audio == null) return names;
        for (AudioDeviceInfo device : audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
            int type = device.getType();
            boolean bluetooth = type == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP || type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO
                || Build.VERSION.SDK_INT >= 31 && (type == AudioDeviceInfo.TYPE_BLE_HEADSET || type == AudioDeviceInfo.TYPE_BLE_SPEAKER);
            String name = String.valueOf(device.getProductName()).trim();
            if (bluetooth && !name.isEmpty() && !names.contains(name)) names.add(name);
        }
        return names;
    }
}
