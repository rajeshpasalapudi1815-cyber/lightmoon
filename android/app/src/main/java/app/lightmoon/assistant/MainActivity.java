package app.lightmoon.assistant;

import android.content.Intent;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.os.Build;
import android.os.Bundle;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    // Opened as the quick panel: LightMoon answers in a small panel at the bottom while the app the user was in
    // stays visible behind it (the web app shows only the panel; see docs/app.js "quick panel"). The window is
    // see-through only then: the activity's theme is translucent, and every other opening makes it opaque.
    static final String EXTRA_PANEL = "app.lightmoon.assistant.PANEL";
    private static final String OWN_HOST = "rajeshpasalapudi1815-cyber.github.io";
    private static final String OWN_PATH = "/lightmoon/";
    static final String EXTRA_LISTEN = "app.lightmoon.assistant.LISTEN"; // start listening, as after the wake phrase
    private static final int DARK = 0xFF04070D; // the launcher icon's night sky, behind the page as it loads

    // True while LightMoon is on screen: the app then announces reminders itself instead of the alarm
    // service, and the wake word pauses so the app's own listening has the microphone.
    static volatile boolean visible = false;
    static volatile boolean panel = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ReminderAlarmsPlugin.class);
        registerPlugin(DeviceUnlockPlugin.class);
        registerPlugin(WakeWordPlugin.class);
        registerPlugin(FileSaverPlugin.class);
        registerPlugin(PhonePlugin.class);
        registerPlugin(OfflineBrainPlugin.class);
        registerPlugin(WorkAccountPlugin.class);
        super.onCreate(savedInstanceState);
        WebView web = getBridge() == null ? null : getBridge().getWebView();
        if (web != null) web.setBackgroundColor(Color.TRANSPARENT); // the page paints its own background
        if (getBridge() != null) {
            getBridge().setWebViewClient(new com.getcapacitor.BridgeWebViewClient(getBridge()) {
                @Override
                public boolean shouldOverrideUrlLoading(WebView view, android.webkit.WebResourceRequest request) {
                    android.net.Uri url = request.getUrl();
                    if ("https".equals(url.getScheme()) && OWN_HOST.equals(url.getHost()) && !String.valueOf(url.getPath()).startsWith(OWN_PATH)) {
                        try {
                            startActivity(new Intent(Intent.ACTION_VIEW, url).addCategory(Intent.CATEGORY_BROWSABLE));
                        } catch (RuntimeException err) {
                            // No browser: just don't go there.
                        }
                        return true;
                    }
                    return super.shouldOverrideUrlLoading(view, request);
                }
            });
        }
        setPanel(wantsPanel(getIntent()));
        takeListen(getIntent());
        // The back button steps back inside the web app first (Settings adds a history step for each page),
        // and only leaves LightMoon when there's nothing to go back to.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (panel) {
                    leavePanel();
                    return;
                }
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
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (intent != null && intent.getData() != null && "lightmoon".equals(intent.getData().getScheme())) {
            WorkAccountPlugin.handleRedirect(intent.getData()); // back from the Microsoft sign-in page
            return;
        }
        setPanel(wantsPanel(intent));
        takeListen(intent);
    }

    private static void takeListen(Intent intent) {
        if (intent != null && intent.getBooleanExtra(EXTRA_LISTEN, false)) WakeWordPlugin.pendingWake = true;
    }

    // The quick panel needs Android 11 (an activity can only turn see-through again from then on).
    static boolean panelPossible() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.R;
    }

    private static boolean wantsPanel(Intent intent) {
        return panelPossible() && intent != null && intent.getBooleanExtra(EXTRA_PANEL, false);
    }

    void setPanel(boolean on) {
        panel = on && panelPossible();
        if (panelPossible()) setTranslucent(panel);
        getWindow().setBackgroundDrawable(new ColorDrawable(panel ? Color.TRANSPARENT : DARK));
    }

    // Done with the panel: back to the app the user was in, and the next opening is the full app again.
    void leavePanel() {
        moveTaskToBack(true);
        setPanel(false);
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
