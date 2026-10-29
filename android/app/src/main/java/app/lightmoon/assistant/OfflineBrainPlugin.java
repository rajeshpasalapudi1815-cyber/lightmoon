package app.lightmoon.assistant;

import android.os.Handler;
import android.os.Looper;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONObject;

// The web app's way to the offline brain (docs/js/offline.js): download the model, and ask it things when there's
// no internet. Answers stream to the app as "offlineToken" events. Every method catches its own errors: one escaping
// a @PluginMethod would crash the app.
@CapacitorPlugin(name = "OfflineBrain")
public class OfflineBrainPlugin extends Plugin {

    private static final long UNLOAD_AFTER_MS = 5 * 60_000L; // the model takes about 1 GB of memory: let it go when idle

    private final ExecutorService thinking = Executors.newSingleThreadExecutor();
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Runnable unload = () -> thinking.execute(OfflineBrain::unload);
    private final AtomicBoolean stopping = new AtomicBoolean();

    // -> { supported, model, state, done, total, problem }
    @PluginMethod
    public void status(PluginCall call) {
        try {
            String[] state = OfflineBrain.state(getContext());
            JSObject result = new JSObject();
            result.put("supported", OfflineBrain.supported());
            result.put("model", OfflineBrain.MODEL_NAME);
            result.put("state", state[0]);
            result.put("done", Long.parseLong(state[1]));
            result.put("total", Long.parseLong(state[2]));
            result.put("problem", state[3]);
            call.resolve(result);
        } catch (RuntimeException err) {
            call.reject("Couldn't check the offline brain.");
        }
    }

    // { wifiOnly } (default true)
    @PluginMethod
    public void download(PluginCall call) {
        try {
            if (!OfflineBrain.supported()) {
                call.reject("This phone's processor can't run the offline brain.");
                return;
            }
            OfflineBrain.download(getContext(), !Boolean.FALSE.equals(call.getBoolean("wifiOnly", true)));
            call.resolve();
        } catch (RuntimeException err) {
            call.reject("Couldn't start the download.");
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        thinking.execute(() -> {
            try {
                OfflineBrain.remove(getContext());
                call.resolve();
            } catch (RuntimeException err) {
                call.reject("Couldn't remove the offline brain.");
            }
        });
    }

    // { messages: [{ role, content }], maxTokens } -> { reply }, streaming "offlineToken" { text } events meanwhile.
    @PluginMethod
    public void ask(PluginCall call) {
        JSArray messages = call.getArray("messages", new JSArray());
        Integer limit = call.getInt("maxTokens", 300);
        int maxTokens = Math.max(16, Math.min(limit == null ? 300 : limit, 1024));
        String[] roles = new String[messages.length()];
        String[] contents = new String[messages.length()];
        try {
            for (int i = 0; i < messages.length(); i++) {
                JSONObject message = messages.getJSONObject(i);
                roles[i] = message.optString("role", "user");
                contents[i] = message.optString("content", "");
            }
        } catch (Exception err) {
            call.reject("The conversation was in the wrong format.");
            return;
        }
        handler.removeCallbacks(unload);
        stopping.set(false);
        thinking.execute(() -> {
            try {
                String reply = OfflineBrain.answer(getContext(), roles, contents, maxTokens, piece -> {
                    JSObject event = new JSObject();
                    event.put("text", new String(piece, StandardCharsets.UTF_8));
                    notifyListeners("offlineToken", event);
                    return !stopping.get();
                });
                if (reply == null) {
                    call.reject("The offline brain isn't ready. Download it in Settings → AI brain.");
                } else {
                    JSObject result = new JSObject();
                    result.put("reply", reply);
                    call.resolve(result);
                }
            } catch (RuntimeException | OutOfMemoryError err) {
                call.reject("The offline brain had a problem with that.");
            } finally {
                handler.postDelayed(unload, UNLOAD_AFTER_MS);
            }
        });
    }

    // Stops the answer being written now (the user tapped stop or spoke over it).
    @PluginMethod
    public void stop(PluginCall call) {
        stopping.set(true);
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        handler.removeCallbacks(unload);
        thinking.execute(OfflineBrain::unload);
        thinking.shutdown();
    }
}
