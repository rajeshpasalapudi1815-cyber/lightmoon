package app.lightmoon.assistant;

import android.content.Context;
import android.media.AudioAttributes;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.json.JSONObject;

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

    // The voice and speed chosen in the app, so the phone sounds the same when it speaks by itself; else British.
    static void useChosenVoice(Context context, TextToSpeech tts) {
        if (tts.setLanguage(Locale.UK) < 0) tts.setLanguage(Locale.getDefault());
        String name = ReminderStore.voiceName(context);
        Set<android.speech.tts.Voice> voices = name.isEmpty() ? null : tts.getVoices();
        if (voices != null) {
            for (android.speech.tts.Voice voice : voices) {
                if (voice.getName().equals(name)) {
                    tts.setVoice(voice);
                    break;
                }
            }
        }
        tts.setSpeechRate(ReminderStore.voiceRate(context));
    }

    // Words the user taught LightMoon to say their way ("Rajesh" as "Raa-jesh"), whole words in any case, as the
    // app does (docs/js/speech.js), so a caller's name or a reminder sounds the same as in the app.
    static String sayTheirWay(Context context, String text) {
        if (text == null || text.isEmpty()) return text;
        try {
            JSONObject sayAs = new JSONObject(ReminderStore.sayAs(context));
            Map<String, String> byLower = new HashMap<>();
            List<String> words = new ArrayList<>();
            Iterator<String> keys = sayAs.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                String word = key.trim();
                String sound = sayAs.optString(key, "").trim();
                if (word.isEmpty() || sound.isEmpty()) continue;
                byLower.put(word.toLowerCase(Locale.ROOT), sound);
                words.add(word);
            }
            if (words.isEmpty()) return text;
            words.sort((a, b) -> b.length() - a.length()); // "Arogya 360" before "Arogya"
            StringBuilder anyOf = new StringBuilder();
            for (String word : words) {
                if (anyOf.length() > 0) anyOf.append('|');
                anyOf.append(Pattern.quote(word));
            }
            Pattern pattern = Pattern.compile(
                "(?<![\\p{L}\\p{N}])(?:" + anyOf + ")(?![\\p{L}\\p{N}])", Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE);
            Matcher matcher = pattern.matcher(text);
            StringBuffer out = new StringBuffer();
            while (matcher.find()) {
                String sound = byLower.get(matcher.group().toLowerCase(Locale.ROOT));
                matcher.appendReplacement(out, Matcher.quoteReplacement(sound != null ? sound : matcher.group()));
            }
            matcher.appendTail(out);
            return out.toString();
        } catch (Exception err) {
            return text; // a broken list never stops a reminder being said
        }
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
            useChosenVoice(app, tts);
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
            tts.speak(sayTheirWay(app, text), TextToSpeech.QUEUE_FLUSH, null, "lightmoon-say");
        });
    }
}
