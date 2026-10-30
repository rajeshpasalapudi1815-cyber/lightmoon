package app.lightmoon.assistant;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.AudioManager;
import android.media.ToneGenerator;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONException;
import org.json.JSONObject;
import org.vosk.Model;
import org.vosk.Recognizer;
import org.vosk.android.RecognitionListener;
import org.vosk.android.SpeechService;

// Listens for the wake phrases ("hey LightMoon", "are you there, LightMoon": WakePhrases) while the app is closed or
// in the background, entirely on the phone (Vosk), and opens LightMoon ready to talk when it hears one. A small
// grammar makes everything else "unknown", and nothing is recorded or sent anywhere.
// While LightMoon is on screen it pauses, so the app's own listening has the microphone. Its notification and the
// quick-settings tile (WakeTile) always say which it is doing: listening, paused, or just heard you.
public class WakeWordService extends Service implements RecognitionListener {

    static final String ACTION_STOP = "app.lightmoon.assistant.WAKE_STOP";
    private static final String CHANNEL = "wake";
    private static final int NOTIFICATION = 2;
    private static final float SAMPLE_RATE = 16000f;
    private static final long REARM_AFTER_MS = 4000;
    private static final long RETRY_AFTER_ERROR_MS = 5000;

    static volatile WakeWordService running;
    // "starting", "listening", "paused" (LightMoon is open), "heard" (just woke); what the notification and tile show.
    static volatile String state = "off";

    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService loader = Executors.newSingleThreadExecutor();
    private final Runnable refresh = this::update;
    private Model model;
    private Recognizer recognizer;
    private SpeechService speech;
    private PowerManager.WakeLock awake;
    private long lastWake;
    private long resumeAt;
    private List<String> phrases;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            WakeWordPlugin.setEnabled(this, false);
            stopSelf();
            return START_NOT_STICKY;
        }
        createChannel(this);
        try {
            int type = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE : 0;
            ServiceCompat.startForeground(this, NOTIFICATION, notification(), type);
        } catch (RuntimeException err) {
            // Android only lets the microphone be used from the background if listening started while
            // LightMoon was open (e.g. not straight after a restart). Opening the app starts it again.
            stopSelf();
            return START_NOT_STICKY;
        }
        running = this;
        phrases = WakePhrases.chosen(this);
        if (model == null) loader.execute(this::loadModel);
        else update();
        return START_NOT_STICKY;
    }

    // LightMoon came to the front or went away: pause or resume listening to match.
    static void appVisibilityChanged() {
        WakeWordService service = running;
        if (service != null) service.main.post(service.refresh);
    }

    private void loadModel() {
        try {
            Model loaded = new Model(WakeModel.dir(this).getAbsolutePath());
            main.post(() -> {
                model = loaded;
                update();
            });
        } catch (IOException | RuntimeException err) {
            main.post(this::stopSelf);
        }
    }

    private void update() {
        boolean wanted = model != null && !MainActivity.visible && SystemClock.elapsedRealtime() >= resumeAt;
        if (wanted && speech == null) startListening();
        else if (!wanted && speech != null) stopListening();
        boolean justHeard = SystemClock.elapsedRealtime() < resumeAt && !MainActivity.visible;
        show(model == null ? "starting" : speech != null ? "listening" : justHeard ? "heard" : "paused");
    }

    // ---------- "Send it" just after a draft opened ----------
    // LightMoon opened a message it wrote in Teams, WhatsApp, Gmail or Outlook: for a short while "send it" is heard
    // too, without the wake phrase, and the Send helper taps Send on that draft (SendHelper checks it's on screen).
    private static volatile long sendUntil = 0;
    private static volatile java.util.List<String> sendApps = new ArrayList<>();
    private static volatile String sendText = "";
    private static volatile String sendChat = "";

    static void expectSend(java.util.List<String> apps, String text, String chat, int seconds) {
        sendApps = new ArrayList<>(apps);
        sendText = text == null ? "" : text;
        sendChat = chat == null ? "" : chat;
        sendUntil = SystemClock.elapsedRealtime() + Math.max(5, Math.min(seconds, 60)) * 1000L;
        WakeWordService service = running;
        if (service == null) return;
        service.main.post(service::restartListening);
        service.main.postDelayed(service::restartListening, Math.max(5, Math.min(seconds, 60)) * 1000L + 300);
    }

    private static boolean waitingToSend() {
        return sendUntil > SystemClock.elapsedRealtime() && !sendText.isEmpty();
    }

    private void restartListening() {
        stopListening();
        update();
    }

    private boolean heardSend(String hypothesis, String field) {
        if (!waitingToSend()) return false;
        try {
            return WakePhrases.saysSend(new JSONObject(hypothesis).optString(field));
        } catch (JSONException err) {
            return false;
        }
    }

    private void send() {
        java.util.List<String> apps = sendApps;
        String text = sendText;
        String chat = sendChat;
        sendUntil = 0;
        sendText = "";
        chime();
        if (SendHelper.isEnabled(this)) SendHelper.arm(apps, text, chat);
        main.post(this::restartListening);
    }

    // The wake phrases changed in Settings: listen for the new ones.
    static void phrasesChanged() {
        WakeWordService service = running;
        if (service == null) return;
        service.main.post(() -> {
            service.phrases = WakePhrases.chosen(service);
            service.stopListening();
            service.update();
        });
    }

    private void show(String now) {
        if (now.equals(state)) return;
        state = now;
        try {
            getSystemService(NotificationManager.class).notify(NOTIFICATION, notification());
        } catch (RuntimeException err) {
            // The notification stays as it was.
        }
        WakeTile.refresh(this);
    }

    private void startListening() {
        try {
            recognizer = new Recognizer(model, SAMPLE_RATE, waitingToSend() ? WakePhrases.grammar(phrases, WakePhrases.SEND) : WakePhrases.grammar(phrases));
            speech = new SpeechService(recognizer, SAMPLE_RATE);
            speech.startListening(this);
            holdAwake(true);
        } catch (IOException | RuntimeException err) {
            stopListening();
            main.postDelayed(refresh, RETRY_AFTER_ERROR_MS);
        }
    }

    private void stopListening() {
        if (speech != null) {
            speech.stop();
            speech.shutdown();
            speech = null;
        }
        if (recognizer != null) {
            recognizer.close();
            recognizer = null;
        }
        holdAwake(false);
    }

    // Keeps the processor running while the screen is off, so the microphone keeps being heard.
    private void holdAwake(boolean on) {
        if (on && awake == null) {
            awake = getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "LightMoon:wake-word");
            awake.acquire();
        } else if (!on && awake != null) {
            awake.release();
            awake = null;
        }
    }

    @Override
    public void onPartialResult(String hypothesis) {
        if (heard(hypothesis, "partial")) wake();
    }

    @Override
    public void onResult(String hypothesis) {
        if (heardSend(hypothesis, "text")) send();
        else if (heard(hypothesis, "text")) wake();
    }

    @Override
    public void onFinalResult(String hypothesis) {
        if (heardSend(hypothesis, "text")) send();
        else if (heard(hypothesis, "text")) wake();
    }

    @Override
    public void onError(Exception err) {
        stopListening();
        main.postDelayed(refresh, RETRY_AFTER_ERROR_MS);
    }

    @Override
    public void onTimeout() {
        stopListening();
        update();
    }

    private boolean heard(String hypothesis, String field) {
        try {
            return WakePhrases.matches(new JSONObject(hypothesis).optString(field), phrases);
        } catch (JSONException err) {
            return false;
        }
    }

    private void wake() {
        long now = SystemClock.elapsedRealtime();
        if (now - lastWake < REARM_AFTER_MS) return;
        lastWake = now;
        resumeAt = now + REARM_AFTER_MS; // if the app doesn't open (e.g. unlock cancelled), listen again soon
        stopListening();
        show("heard");
        chime();
        WakeWordPlugin.wakeUp(this);
        main.postDelayed(refresh, REARM_AFTER_MS);
    }

    private void chime() {
        try {
            ToneGenerator tone = new ToneGenerator(AudioManager.STREAM_NOTIFICATION, 80);
            tone.startTone(ToneGenerator.TONE_PROP_ACK, 150);
            main.postDelayed(tone::release, 400);
        } catch (RuntimeException err) {
            // No sound available; the app opening is the signal.
        }
    }

    private Notification notification() {
        Intent open = new Intent(this, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent tap = PendingIntent.getActivity(this, 1, open, PendingIntent.FLAG_IMMUTABLE);
        Intent stop = new Intent(this, WakeWordService.class).setAction(ACTION_STOP);
        PendingIntent turnOff = PendingIntent.getService(this, 2, stop, PendingIntent.FLAG_IMMUTABLE);
        List<String> said = new ArrayList<>();
        for (String phrase : WakePhrases.phrases(phrases == null ? WakePhrases.chosen(this) : phrases)) said.add("“" + WakePhrases.spoken(phrase) + "”");
        String title;
        String text;
        switch (state) {
            case "listening":
                title = "Listening for " + said.get(0);
                text = "Only for " + String.join(", ", said) + ", on this phone. Nothing is recorded or sent.";
                break;
            case "heard":
                title = "Heard you: opening LightMoon";
                text = "Listening again in a few seconds.";
                break;
            case "paused":
                title = "Paused: LightMoon is open";
                text = "The app is using the microphone itself. Listening resumes when you leave it.";
                break;
            default:
                title = "Getting ready to listen";
                text = "Loading the voice model on this phone.";
        }
        return new NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_moon)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setOngoing(true)
            .setContentIntent(tap)
            .addAction(0, "Turn off", turnOff)
            .build();
    }

    static void createChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL, "Wake word", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Shown while LightMoon listens for its name");
        context.getSystemService(NotificationManager.class).createNotificationChannel(channel);
    }

    @Override
    public void onDestroy() {
        running = null;
        state = "off";
        WakeTile.refresh(this);
        main.removeCallbacksAndMessages(null);
        stopListening();
        loader.shutdownNow();
        if (model != null) {
            model.close();
            model = null;
        }
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
