package app.lightmoon.assistant;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

// LightMoon's incoming morning call (MorningCall): a full screen with Answer and Decline, shown over the lock screen.
// Answer asks for the fingerprint (or PIN) on a locked phone, so nothing personal is said on the lock screen, then
// opens LightMoon, which takes the call from there. Closes itself when the ringing stops.
public class CallActivity extends Activity {

    static final String EXTRA_ANSWER = "app.lightmoon.assistant.ANSWER";
    private final Handler main = new Handler(Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        } else {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (getIntent().getBooleanExtra(EXTRA_ANSWER, false)) {
            answer();
            return;
        }
        setContentView(screen());
        main.postDelayed(() -> { if (!MorningCall.ringing) finish(); }, MorningCall.RING_MS + 1500);
    }

    private View screen() {
        float dp = getResources().getDisplayMetrics().density;
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER_HORIZONTAL);
        root.setBackgroundColor(0xFF04070D);
        root.setPadding(0, (int) (120 * dp), 0, (int) (80 * dp));

        ImageView moon = new ImageView(this);
        moon.setImageResource(R.drawable.ic_stat_moon);
        moon.setColorFilter(0xFF3FD8FF);
        GradientDrawable halo = new GradientDrawable();
        halo.setShape(GradientDrawable.OVAL);
        halo.setColor(0x223FD8FF);
        moon.setBackground(halo);
        int pad = (int) (26 * dp);
        moon.setPadding(pad, pad, pad, pad);
        root.addView(moon, new LinearLayout.LayoutParams((int) (120 * dp), (int) (120 * dp)));

        TextView name = text("LightMoon", 34, Color.WHITE);
        name.setTypeface(Typeface.DEFAULT_BOLD);
        name.setPadding(0, (int) (28 * dp), 0, (int) (6 * dp));
        root.addView(name);
        root.addView(text(MorningCall.subtitle(), 17, 0xFF7896A8));

        View space = new View(this);
        root.addView(space, new LinearLayout.LayoutParams(1, 0, 1f));

        LinearLayout buttons = new LinearLayout(this);
        buttons.setGravity(Gravity.CENTER);
        buttons.addView(round("Decline", 0xFFE5484D, v -> decline()), roundSize(dp));
        View gap = new View(this);
        buttons.addView(gap, new LinearLayout.LayoutParams((int) (90 * dp), 1));
        buttons.addView(round("Answer", 0xFF2EBD6B, v -> answer()), roundSize(dp));
        root.addView(buttons);
        return root;
    }

    private TextView text(String value, int sp, int color) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(sp);
        view.setTextColor(color);
        view.setGravity(Gravity.CENTER);
        return view;
    }

    private Button round(String label, int color, View.OnClickListener tap) {
        Button button = new Button(this);
        button.setText(label);
        button.setAllCaps(false);
        button.setTextColor(Color.WHITE);
        button.setTextSize(15);
        GradientDrawable circle = new GradientDrawable();
        circle.setShape(GradientDrawable.OVAL);
        circle.setColor(color);
        button.setBackground(circle);
        button.setOnClickListener(tap);
        return button;
    }

    private static LinearLayout.LayoutParams roundSize(float dp) {
        return new LinearLayout.LayoutParams((int) (84 * dp), (int) (84 * dp));
    }

    private void decline() {
        MorningCall.stop(this);
        finish();
    }

    // Unlock first if needed, then LightMoon takes the call.
    private void answer() {
        MorningCall.answered(this);
        KeyguardManager keyguard = getSystemService(KeyguardManager.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && keyguard.isKeyguardLocked()) {
            keyguard.requestDismissKeyguard(this, new KeyguardManager.KeyguardDismissCallback() {
                @Override public void onDismissSucceeded() { open(); }
                @Override public void onDismissCancelled() { giveUp(); }
                @Override public void onDismissError() { giveUp(); }
            });
            return;
        }
        open();
    }

    private void open() {
        startActivity(new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        finish();
    }

    // Didn't unlock: the call is kept as missed, so the briefing is one tap away.
    private void giveUp() {
        WakeWordPlugin.pendingWake = false;
        WakeWordPlugin.pendingCall = false;
        finish();
    }

    @Override
    protected void onDestroy() {
        main.removeCallbacksAndMessages(null);
        super.onDestroy();
    }
}
