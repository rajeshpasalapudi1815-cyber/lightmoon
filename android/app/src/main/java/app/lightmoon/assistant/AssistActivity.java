package app.lightmoon.assistant;

import android.app.Activity;
import android.os.Bundle;

// The phone's assistant button opens LightMoon ready to listen: a smartwatch's or Bluetooth headset's voice button,
// or a long press of the power or home button, once LightMoon is the phone's digital assistant (Settings → Apps →
// Default apps → Digital assistant app) or chosen for "voice commands". Works like hearing the wake phrase: a locked
// phone asks to be unlocked first.
public class AssistActivity extends Activity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        WakeWordPlugin.wakeUp(this, false);
        finish();
    }
}
