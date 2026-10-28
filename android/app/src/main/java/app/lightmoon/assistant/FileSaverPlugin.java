package app.lightmoon.assistant;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

// Saves a file the user can keep (the backup), through Android's own "Save to" screen. The in-app web
// view can't download files the way a browser does, so "Download backup" goes through here instead.
@CapacitorPlugin(name = "FileSaver")
public class FileSaverPlugin extends Plugin {

    // { name, mimeType, text } → { saved: true }, or { saved: false } if the user backs out.
    @PluginMethod
    public void save(PluginCall call) {
        if (call.getString("text") == null) {
            call.reject("Nothing to save.");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType(call.getString("mimeType", "application/json"))
            .putExtra(Intent.EXTRA_TITLE, call.getString("name", "lightmoon-backup.json"));
        startActivityForResult(call, intent, "placeChosen");
    }

    @ActivityCallback
    private void placeChosen(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Uri target = result.getData() == null ? null : result.getData().getData();
        JSObject outcome = new JSObject();
        if (result.getResultCode() != Activity.RESULT_OK || target == null) {
            outcome.put("saved", false);
            call.resolve(outcome);
            return;
        }
        try (OutputStream out = getContext().getContentResolver().openOutputStream(target)) {
            if (out == null) throw new IOException("No output stream");
            out.write(call.getString("text", "").getBytes(StandardCharsets.UTF_8));
            outcome.put("saved", true);
            call.resolve(outcome);
        } catch (IOException err) {
            call.reject("Couldn't save the file there. Try another folder.");
        }
    }
}
