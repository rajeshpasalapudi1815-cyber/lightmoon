package app.lightmoon.assistant;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    // True while LightMoon is on screen: the app then announces reminders itself instead of the alarm
    // service, and the wake word pauses so the app's own listening has the microphone.
    static volatile boolean visible = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ReminderAlarmsPlugin.class);
        registerPlugin(DeviceUnlockPlugin.class);
        registerPlugin(WakeWordPlugin.class);
        registerPlugin(FileSaverPlugin.class);
        registerPlugin(PhonePlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    public void onResume() {
        super.onResume();
        visible = true;
        WakeWordPlugin.clearHeard(this);
        WakeWordPlugin.resumeIfEnabled(this);
        WakeWordService.appVisibilityChanged();
    }

    @Override
    public void onPause() {
        visible = false;
        WakeWordService.appVisibilityChanged();
        super.onPause();
    }
}
