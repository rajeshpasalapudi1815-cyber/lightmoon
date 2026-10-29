package app.lightmoon.assistant;

import android.os.Bundle;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
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
        registerPlugin(OfflineBrainPlugin.class);
        super.onCreate(savedInstanceState);
        // The back button steps back inside the web app first (Settings adds a history step for each page),
        // and only leaves LightMoon when there's nothing to go back to.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView web = getBridge() == null ? null : getBridge().getWebView();
                if (web != null && web.canGoBack()) {
                    web.goBack();
                    return;
                }
                setEnabled(false);
                getOnBackPressedDispatcher().onBackPressed();
                setEnabled(true);
            }
        });
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
