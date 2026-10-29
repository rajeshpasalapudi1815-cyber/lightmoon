package app.lightmoon.assistant;

import android.content.Context;
import android.media.AudioAttributes;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import java.util.ArrayDeque;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;

// Says a short line ("Call from Mom.") with Android's text-to-speech and lets go of it afterwards.
// For moments Android won't let LightMoon start its speaking service (a call coming in, a message
// arriving). Lines without a `done` (messages) wait their turn, so they never talk over each other;
// a caller's name is said at once. stopAll() silences everything (the call was answered).
final class Voice {

    private static final long QUICK_GIVE_UP_MS = 9_000; // a receiver's goAsync() allows about 10 seconds
    private static final long MAX_GIVE_UP_MS = 45_000;
    private static final Handler main = new Handler(Looper.getMainLooper());
    private static final Set<Runnable> stoppers = ConcurrentHashMap.newKeySet();
    private static final ArrayDeque<String> waiting = new ArrayDeque<>(); // main thread only
    private static boolean queueBusy; // main thread only

    private Voice() {}

    static AudioAttributes assistantAudio() {
        int usage = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O ? AudioAttributes.USAGE_ASSISTANT : AudioAttributes.USAGE_NOTIFICATION;
        return new AudioAttributes.Builder().setUsage(usage).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build();
    }

    // With `done` (a receiver waiting): right away, within its time limit. Without: queued behind other lines.
    static void say(Context context, String text, Runnable done) {
        Context app = context.getApplicationContext();
        if (done != null) {
            main.post(() -> speak(app, text, QUICK_GIVE_UP_MS, done));
            return;
        }
        main.post(() -> {
            waiting.add(text);
            if (!queueBusy) next(app);
        });
    }

    private static void next(Context app) {
        String text = waiting.poll();
        queueBusy = text != null;
        if (text == null) return;
        // Enough time to start the engine and say the whole line, however long.
        long giveUp = Math.min(MAX_GIVE_UP_MS, QUICK_GIVE_UP_MS + text.length() * 90L);
        speak(app, text, giveUp, () -> main.post(() -> next(app)));
    }

    static void stopAll() {
        for (Runnable stop : stoppers) main.post(stop);
        main.post(waiting::clear);
    }

    private static void speak(Context app, String text, long giveUpMs, Runnable done) {
        AtomicBoolean finished = new AtomicBoolean(false);
        TextToSpeech[] engine = new TextToSpeech[1];
        Runnable[] self = new Runnable[1];
        Runnable finish = () -> {
            if (!finished.compareAndSet(false, true)) return;
            stoppers.remove(self[0]);
            if (engine[0] != null) {
                engine[0].stop();
                engine[0].shutdown();
            }
            done.run();
        };
        self[0] = finish;
        stoppers.add(finish);
        main.postDelayed(finish, giveUpMs);
        engine[0] = new TextToSpeech(app, status -> {
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
        });
    }
}
