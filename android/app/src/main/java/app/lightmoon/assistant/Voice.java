package app.lightmoon.assistant;

import android.content.Context;
import android.media.AudioAttributes;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import java.util.Locale;
import java.util.concurrent.atomic.AtomicBoolean;

// Says one short line ("Call from Mom.") with Android's text-to-speech and lets go of it afterwards.
// For moments Android won't let LightMoon start its speaking service (a call coming in, a message
// arriving); the caller keeps itself alive until `done` runs.
final class Voice {

    private static final long GIVE_UP_AFTER_MS = 9_000;

    private Voice() {}

    static AudioAttributes assistantAudio() {
        int usage = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O ? AudioAttributes.USAGE_ASSISTANT : AudioAttributes.USAGE_NOTIFICATION;
        return new AudioAttributes.Builder().setUsage(usage).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build();
    }

    static void say(Context context, String text, Runnable done) {
        Handler main = new Handler(Looper.getMainLooper());
        AtomicBoolean finished = new AtomicBoolean(false);
        TextToSpeech[] engine = new TextToSpeech[1];
        Runnable finish = () -> {
            if (!finished.compareAndSet(false, true)) return;
            if (engine[0] != null) engine[0].shutdown();
            if (done != null) done.run();
        };
        main.postDelayed(finish, GIVE_UP_AFTER_MS);
        main.post(() -> engine[0] = new TextToSpeech(context.getApplicationContext(), status -> {
            TextToSpeech tts = engine[0];
            if (status != TextToSpeech.SUCCESS || tts == null || finished.get()) {
                main.post(finish);
                return;
            }
            if (tts.setLanguage(Locale.UK) < 0) tts.setLanguage(Locale.getDefault());
            tts.setAudioAttributes(assistantAudio());
            tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override
                public void onStart(String utteranceId) {}

                @Override
                public void onDone(String utteranceId) {
                    main.post(finish);
                }

                @Override
                public void onError(String utteranceId) {
                    main.post(finish);
                }
            });
            tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "lightmoon-say");
        }));
    }
}
