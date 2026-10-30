package app.lightmoon.assistant;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import org.json.JSONObject;

// The user's Microsoft work account, for sending Teams messages and work email straight from LightMoon
// (docs/js/graph.js). Sign-in happens on Microsoft's own page in the browser, with PKCE: LightMoon never sees the
// password. Microsoft hands back a one-time code at lightmoon://auth (MainActivity), which is exchanged here for
// a sign-in key (refresh token), kept only in this app's private storage. The web app asks for a short-lived
// access token when it sends something.
@CapacitorPlugin(name = "WorkAccount")
public class WorkAccountPlugin extends Plugin {

    static final String REDIRECT = "lightmoon://auth";
    private static final String PREFS = "lightmoon.work";
    private static final String SCOPES = "openid profile offline_access User.Read User.ReadBasic.All Chat.ReadWrite ChatMessage.Send "
        + "ChannelMessage.Send Team.ReadBasic.All Channel.ReadBasic.All Mail.Send";

    private static volatile WorkAccountPlugin active;
    private PluginCall waiting;
    private String verifier;
    private String state;

    @Override
    public void load() {
        active = this;
    }

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    // { clientId, tenant? } from the app registration (Settings → Microsoft work account).
    @PluginMethod
    public void configure(PluginCall call) {
        String clientId = call.getString("clientId", "").trim();
        String tenant = call.getString("tenant", "").trim();
        if (!clientId.matches("[0-9a-fA-F-]{36}")) {
            call.reject("That doesn't look like an Application (client) ID: it's 36 letters, numbers and dashes.");
            return;
        }
        prefs().edit().putString("clientId", clientId).putString("tenant", tenant.isEmpty() ? "organizations" : tenant).apply();
        call.resolve(status());
    }

    @PluginMethod
    public void status(PluginCall call) {
        call.resolve(status());
    }

    private JSObject status() {
        JSObject result = new JSObject();
        result.put("configured", prefs().contains("clientId"));
        result.put("signedIn", prefs().contains("refresh"));
        result.put("account", prefs().getString("account", ""));
        result.put("clientId", prefs().getString("clientId", ""));
        result.put("tenant", prefs().getString("tenant", ""));
        return result;
    }

    // Opens Microsoft's sign-in page; resolves once they've signed in (or rejects if it fails).
    @PluginMethod
    public void signIn(PluginCall call) {
        String clientId = prefs().getString("clientId", "");
        if (clientId.isEmpty()) {
            call.reject("Add the Application (client) ID first.");
            return;
        }
        try {
            byte[] random = new byte[48];
            new SecureRandom().nextBytes(random);
            verifier = base64Url(random);
            byte[] stateBytes = new byte[16];
            new SecureRandom().nextBytes(stateBytes);
            state = base64Url(stateBytes);
            String challenge = base64Url(MessageDigest.getInstance("SHA-256").digest(verifier.getBytes(StandardCharsets.US_ASCII)));
            String url = authority() + "/authorize?client_id=" + enc(clientId) + "&response_type=code&redirect_uri=" + enc(REDIRECT)
                + "&response_mode=query&scope=" + enc(SCOPES) + "&state=" + enc(state)
                + "&code_challenge=" + enc(challenge) + "&code_challenge_method=S256&prompt=select_account";
            if (waiting != null) waiting.reject("A newer sign-in started.");
            waiting = call;
            call.setKeepAlive(true);
            getActivity().startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (Exception err) {
            call.reject("Couldn't open the Microsoft sign-in page.");
        }
    }

    // Microsoft sent the browser back to lightmoon://auth?code=...&state=... (MainActivity passes it on).
    static void handleRedirect(Uri uri) {
        WorkAccountPlugin plugin = active;
        if (plugin != null) plugin.finishSignIn(uri);
    }

    private void finishSignIn(Uri uri) {
        PluginCall call = waiting;
        waiting = null;
        if (call == null) return;
        String error = uri.getQueryParameter("error_description");
        if (error != null) {
            call.reject(error.split("\\r?\\n")[0]);
            call.setKeepAlive(false);
            return;
        }
        String code = uri.getQueryParameter("code");
        if (code == null || state == null || !state.equals(uri.getQueryParameter("state"))) {
            call.reject("The sign-in didn't come back as expected. Try again.");
            call.setKeepAlive(false);
            return;
        }
        String clientId = prefs().getString("clientId", "");
        String form = "client_id=" + enc(clientId) + "&grant_type=authorization_code&code=" + enc(code) + "&redirect_uri=" + enc(REDIRECT)
            + "&code_verifier=" + enc(verifier) + "&scope=" + enc(SCOPES);
        new Thread(() -> {
            try {
                JSONObject tokens = postForm(authority() + "/token", form);
                keep(tokens);
                call.resolve(status());
            } catch (Exception err) {
                call.reject(err.getMessage() == null ? "Sign-in failed." : err.getMessage());
            } finally {
                call.setKeepAlive(false);
            }
        }, "lightmoon-work-signin").start();
    }

    // -> { accessToken, expiresAt, account }: a fresh access token for Microsoft Graph (renewed with the sign-in key).
    @PluginMethod
    public void token(PluginCall call) {
        new Thread(() -> {
            try {
                long expires = prefs().getLong("expiresAt", 0);
                if (System.currentTimeMillis() > expires - 120_000) refresh();
                JSObject result = new JSObject();
                result.put("accessToken", prefs().getString("access", ""));
                result.put("expiresAt", prefs().getLong("expiresAt", 0));
                result.put("account", prefs().getString("account", ""));
                call.resolve(result);
            } catch (Exception err) {
                call.reject(err.getMessage() == null ? "Couldn't reach Microsoft." : err.getMessage());
            }
        }, "lightmoon-work-token").start();
    }

    @PluginMethod
    public void signOut(PluginCall call) {
        prefs().edit().remove("refresh").remove("access").remove("expiresAt").remove("account").apply();
        call.resolve(status());
    }

    private synchronized void refresh() throws Exception {
        String refreshToken = prefs().getString("refresh", "");
        if (refreshToken.isEmpty()) throw new Exception("Not signed in to the Microsoft work account. Sign in in Settings → Phone → Microsoft work account.");
        String form = "client_id=" + enc(prefs().getString("clientId", "")) + "&grant_type=refresh_token&refresh_token=" + enc(refreshToken)
            + "&scope=" + enc(SCOPES);
        keep(postForm(authority() + "/token", form));
    }

    private void keep(JSONObject tokens) {
        SharedPreferences.Editor edit = prefs().edit()
            .putString("access", tokens.optString("access_token"))
            .putLong("expiresAt", System.currentTimeMillis() + tokens.optLong("expires_in", 3600) * 1000L);
        if (tokens.has("refresh_token")) edit.putString("refresh", tokens.optString("refresh_token"));
        String account = accountOf(tokens.optString("id_token", ""));
        if (!account.isEmpty()) edit.putString("account", account);
        edit.apply();
    }

    // The signed-in address, from the id_token's middle part (it came straight from Microsoft over HTTPS).
    private static String accountOf(String idToken) {
        try {
            String[] parts = idToken.split("\\.");
            if (parts.length < 2) return "";
            JSONObject claims = new JSONObject(new String(Base64.decode(parts[1], Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING), StandardCharsets.UTF_8));
            return claims.optString("preferred_username", claims.optString("email", ""));
        } catch (Exception err) {
            return "";
        }
    }

    private String authority() {
        return "https://login.microsoftonline.com/" + enc(prefs().getString("tenant", "organizations")) + "/oauth2/v2.0";
    }

    private static JSONObject postForm(String address, String form) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(address).openConnection();
        connection.setConnectTimeout(15_000);
        connection.setReadTimeout(20_000);
        connection.setRequestMethod("POST");
        connection.setDoOutput(true);
        connection.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
        try {
            try (OutputStream out = connection.getOutputStream()) {
                out.write(form.getBytes(StandardCharsets.UTF_8));
            }
            int status = connection.getResponseCode();
            InputStream in = status < 400 ? connection.getInputStream() : connection.getErrorStream();
            ByteArrayOutputStream body = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            for (int read; in != null && (read = in.read(buffer)) != -1; ) body.write(buffer, 0, read);
            JSONObject json = new JSONObject(body.toString(StandardCharsets.UTF_8.name()));
            if (status >= 400) {
                String message = json.optString("error_description", json.optString("error", "Microsoft said no (" + status + ")."));
                throw new Exception(message.split("\\r?\\n")[0]);
            }
            return json;
        } finally {
            connection.disconnect();
        }
    }

    private static String base64Url(byte[] bytes) {
        return Base64.encodeToString(bytes, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
    }

    private static String enc(String text) {
        try {
            return URLEncoder.encode(text, "UTF-8");
        } catch (Exception err) {
            return text;
        }
    }
}
