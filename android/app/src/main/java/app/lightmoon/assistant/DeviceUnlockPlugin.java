package app.lightmoon.assistant;

import androidx.annotation.NonNull;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

// The phone's own fingerprint, face or screen-lock check, for LightMoon's app lock (see docs/js/lock.js).
// The web version uses the browser's WebAuthn for this, which Android's in-app web view doesn't offer.
@CapacitorPlugin(name = "DeviceUnlock")
public class DeviceUnlockPlugin extends Plugin {

    private static final int ALLOWED =
        BiometricManager.Authenticators.BIOMETRIC_WEAK | BiometricManager.Authenticators.DEVICE_CREDENTIAL;

    @PluginMethod
    public void available(PluginCall call) {
        int status = BiometricManager.from(getContext()).canAuthenticate(ALLOWED);
        JSObject result = new JSObject();
        result.put("available", status == BiometricManager.BIOMETRIC_SUCCESS);
        call.resolve(result);
    }

    // Resolves once the owner is verified; rejects if they cancel or it fails.
    @PluginMethod
    public void verify(PluginCall call) {
        String reason = call.getString("reason", "Unlock LightMoon");
        getActivity().runOnUiThread(() -> {
            BiometricPrompt prompt = new BiometricPrompt(
                getActivity(),
                ContextCompat.getMainExecutor(getContext()),
                new BiometricPrompt.AuthenticationCallback() {
                    @Override
                    public void onAuthenticationSucceeded(@NonNull BiometricPrompt.AuthenticationResult result) {
                        call.resolve();
                    }

                    @Override
                    public void onAuthenticationError(int code, @NonNull CharSequence message) {
                        call.reject(message.toString(), String.valueOf(code));
                    }
                    // A single unrecognised finger isn't final: the prompt stays open for another try.
                }
            );
            BiometricPrompt.PromptInfo info = new BiometricPrompt.PromptInfo.Builder()
                .setTitle("LightMoon")
                .setSubtitle(reason)
                .setAllowedAuthenticators(ALLOWED)
                .build();
            prompt.authenticate(info);
        });
    }
}
