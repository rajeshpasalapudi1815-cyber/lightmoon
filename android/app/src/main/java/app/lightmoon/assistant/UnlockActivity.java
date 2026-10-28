package app.lightmoon.assistant;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;

// "LightMoon" was heard on a locked phone: wake the screen and ask for the fingerprint (or PIN),
// then open LightMoon. Shows nothing of its own, so nothing is visible on the lock screen.
public class UnlockActivity extends Activity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        } else {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            open(); // older Android: LightMoon appears once the phone is unlocked
            return;
        }
        KeyguardManager keyguard = getSystemService(KeyguardManager.class);
        keyguard.requestDismissKeyguard(this, new KeyguardManager.KeyguardDismissCallback() {
            @Override
            public void onDismissSucceeded() {
                open();
            }

            @Override
            public void onDismissCancelled() {
                giveUp();
            }

            @Override
            public void onDismissError() {
                giveUp();
            }
        });
    }

    private void open() {
        startActivity(new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        finish();
    }

    private void giveUp() {
        WakeWordPlugin.pendingWake = false;
        finish();
    }
}
