package app.lightmoon.assistant;

import android.Manifest;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.database.Cursor;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraManager;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.provider.AlarmClock;
import android.provider.CallLog;
import android.provider.Settings;
import android.telephony.SmsManager;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import org.json.JSONArray;
import org.json.JSONException;

// The web app's hands on the phone (see docs/js/phone.js): the calendar, calls, texts and chat replies,
// opening apps, alarms and timers, the flashlight and the volume. Sending and calling only ever happen
// after the user said yes in the conversation; that check is in the web app.
@CapacitorPlugin(
    name = "Phone",
    permissions = {
        @Permission(strings = { Manifest.permission.READ_CALENDAR, Manifest.permission.WRITE_CALENDAR }, alias = "calendar"),
        @Permission(
            strings = { Manifest.permission.READ_PHONE_STATE, Manifest.permission.READ_CALL_LOG, Manifest.permission.CALL_PHONE, Manifest.permission.READ_CONTACTS },
            alias = "calls"
        ),
        @Permission(strings = { Manifest.permission.SEND_SMS, Manifest.permission.READ_CONTACTS }, alias = "texts"),
    }
)
public class PhonePlugin extends Plugin {

    private static final int MAX_CALLS = 30;
    private static volatile PhonePlugin active;

    @Override
    public void load() {
        active = this;
        if (Meetings.canRead(getContext())) {
            Meetings.reschedule(getContext());
            if (PhonePrefs.meetingLead(getContext()) > 0) MeetingWorker.start(getContext());
        }
    }

    @Override
    protected void handleOnDestroy() {
        if (active == this) active = null;
    }

    // Something to say while LightMoon is on screen: the app says it in the conversation instead.
    static boolean tellApp(String event, String say) {
        PhonePlugin plugin = active;
        if (plugin == null || !plugin.hasListeners(event)) return false;
        JSObject data = new JSObject();
        data.put("say", say);
        plugin.notifyListeners(event, data);
        return true;
    }

    // ---------- Permissions and settings ----------

    private boolean granted(String alias) {
        return getPermissionState(alias) == PermissionState.GRANTED;
    }

    private boolean has(String permission) {
        return ContextCompat.checkSelfPermission(getContext(), permission) == PackageManager.PERMISSION_GRANTED;
    }

    private JSObject currentStatus() {
        JSObject status = new JSObject();
        status.put("calendar", granted("calendar"));
        status.put("calls", granted("calls"));
        status.put("texts", granted("texts"));
        status.put("messages", MessageListener.isEnabled(getContext()));
        status.put("telephony", PhonePrefs.hasTelephony(getContext()));
        status.put("meetingLead", PhonePrefs.meetingLead(getContext()));
        status.put("announceCalls", PhonePrefs.announceCalls(getContext()));
        status.put("readMessages", PhonePrefs.readMessages(getContext()));
        return status;
    }

    @PluginMethod
    public void status(PluginCall call) {
        call.resolve(currentStatus());
    }

    @PluginMethod
    public void requestCalendar(PluginCall call) {
        if (granted("calendar")) calendarAnswered(call);
        else requestPermissionForAlias("calendar", call, "calendarAnswered");
    }

    @PermissionCallback
    private void calendarAnswered(PluginCall call) {
        if (granted("calendar")) {
            Meetings.reschedule(getContext());
            if (PhonePrefs.meetingLead(getContext()) > 0) MeetingWorker.start(getContext());
        }
        call.resolve(currentStatus());
    }

    @PluginMethod
    public void requestCalls(PluginCall call) {
        if (granted("calls")) call.resolve(currentStatus());
        else requestPermissionForAlias("calls", call, "answered");
    }

    @PluginMethod
    public void requestTexts(PluginCall call) {
        if (granted("texts")) call.resolve(currentStatus());
        else requestPermissionForAlias("texts", call, "answered");
    }

    @PermissionCallback
    private void answered(PluginCall call) {
        call.resolve(currentStatus());
    }

    // Reading messages needs "notification access", which Android only grants on its own settings screen.
    @PluginMethod
    public void openMessageAccess(PluginCall call) {
        try {
            getActivity().startActivity(new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS));
            call.resolve();
        } catch (ActivityNotFoundException err) {
            call.reject("Open Settings → Notifications → Device & app notifications and allow LightMoon.");
        }
    }

    // { meetingLead (minutes, 0 = off), announceCalls, readMessages ("off" | "sender" | "full"), address }
    @PluginMethod
    public void configure(PluginCall call) {
        android.content.SharedPreferences.Editor edit = PhonePrefs.get(getContext()).edit();
        Integer lead = call.getInt("meetingLead");
        if (lead != null) edit.putInt("meetingLead", Math.max(0, Math.min(lead, 120)));
        Boolean calls = call.getBoolean("announceCalls");
        if (calls != null) edit.putBoolean("announceCalls", calls);
        String messages = call.getString("readMessages");
        if ("off".equals(messages) || "sender".equals(messages) || "full".equals(messages)) edit.putString("readMessages", messages);
        String address = call.getString("address");
        if (address != null && !address.trim().isEmpty()) edit.putString("address", address.trim());
        edit.commit();
        Meetings.reschedule(getContext());
        if (PhonePrefs.meetingLead(getContext()) > 0 && Meetings.canRead(getContext())) MeetingWorker.start(getContext());
        else MeetingWorker.stop(getContext());
        call.resolve(currentStatus());
    }

    // ---------- Calendar ----------

    // { from, to } in ms -> { events: [{ id, title, start, end, allDay, location, calendar }] }
    @PluginMethod
    public void events(PluginCall call) {
        if (!Meetings.canRead(getContext())) {
            call.reject("Calendar access is off. Turn it on in LightMoon's Settings → Phone.");
            return;
        }
        long now = System.currentTimeMillis();
        long from = call.getDouble("from", (double) now).longValue();
        long to = call.getDouble("to", (double) (now + 86_400_000L)).longValue();
        try {
            JSObject result = new JSObject();
            result.put("events", Meetings.events(getContext(), from, to));
            call.resolve(result);
        } catch (JSONException | RuntimeException err) {
            call.reject("Couldn't read the calendar.");
        }
    }

    // { title, start, end (ms), location?, notes? } -> { id }
    @PluginMethod
    public void addEvent(PluginCall call) {
        if (!Meetings.canWrite(getContext())) {
            call.reject("Calendar access is off. Turn it on in LightMoon's Settings → Phone.");
            return;
        }
        String title = call.getString("title", "").trim();
        Double start = call.getDouble("start");
        Double end = call.getDouble("end");
        if (title.isEmpty() || start == null || end == null || end <= start) {
            call.reject("An event needs a title, a start and an end after it.");
            return;
        }
        try {
            long id = Meetings.add(getContext(), title, start.longValue(), end.longValue(), call.getString("location"), call.getString("notes"));
            JSObject result = new JSObject();
            result.put("id", id);
            call.resolve(result);
        } catch (RuntimeException err) {
            call.reject(err.getMessage() == null ? "The calendar didn't take the event." : err.getMessage());
        }
    }

    // ---------- Calls and contacts ----------

    // { since (ms) } -> { calls: [{ name, number, type, at, seconds }] }, newest first
    @PluginMethod
    public void calls(PluginCall call) {
        if (!has(Manifest.permission.READ_CALL_LOG)) {
            call.reject("Call access is off. Turn it on in LightMoon's Settings → Phone.");
            return;
        }
        long since = call.getDouble("since", (double) (System.currentTimeMillis() - 86_400_000L)).longValue();
        String[] columns = { CallLog.Calls.NUMBER, CallLog.Calls.CACHED_NAME, CallLog.Calls.TYPE, CallLog.Calls.DATE, CallLog.Calls.DURATION };
        JSArray list = new JSArray();
        try (Cursor cursor = getContext().getContentResolver().query(
            CallLog.Calls.CONTENT_URI, columns, CallLog.Calls.DATE + " >= ?", new String[] { String.valueOf(since) }, CallLog.Calls.DATE + " DESC")) {
            while (cursor != null && cursor.moveToNext() && list.length() < MAX_CALLS) {
                String number = cursor.getString(0);
                String name = cursor.isNull(1) || cursor.getString(1).isEmpty() ? Contacts.nameFor(getContext(), number) : cursor.getString(1);
                JSObject item = new JSObject();
                item.put("name", name == null ? "" : name);
                item.put("number", number == null ? "" : number);
                item.put("type", callType(cursor.getInt(2)));
                item.put("at", cursor.getLong(3));
                item.put("seconds", cursor.getLong(4));
                list.put(item);
            }
        } catch (RuntimeException err) {
            call.reject("Couldn't read the call history.");
            return;
        }
        JSObject result = new JSObject();
        result.put("calls", list);
        call.resolve(result);
    }

    private static String callType(int type) {
        switch (type) {
            case CallLog.Calls.INCOMING_TYPE: return "incoming";
            case CallLog.Calls.OUTGOING_TYPE: return "outgoing";
            case CallLog.Calls.MISSED_TYPE: return "missed";
            case CallLog.Calls.REJECTED_TYPE: return "rejected";
            case CallLog.Calls.BLOCKED_TYPE: return "blocked";
            default: return "other";
        }
    }

    // { query } -> { contacts: [{ name, numbers: [{ number, label }] }] }
    @PluginMethod
    public void contacts(PluginCall call) {
        if (!Contacts.canRead(getContext())) {
            call.reject("Contacts access is off. Turn on Calls or Texts in LightMoon's Settings → Phone.");
            return;
        }
        try {
            JSObject result = new JSObject();
            result.put("contacts", Contacts.search(getContext(), call.getString("query", "")));
            call.resolve(result);
        } catch (JSONException | RuntimeException err) {
            call.reject("Couldn't search the contacts.");
        }
    }

    // { number }: rings them straight away (the app asked the user first).
    @PluginMethod
    public void placeCall(PluginCall call) {
        String number = call.getString("number", "").trim();
        if (!has(Manifest.permission.CALL_PHONE)) {
            call.reject("Call access is off. Turn it on in LightMoon's Settings → Phone.");
            return;
        }
        if (number.replaceAll("[^0-9]", "").length() < 3) {
            call.reject("That isn't a phone number.");
            return;
        }
        try {
            getActivity().startActivity(new Intent(Intent.ACTION_CALL, Uri.parse("tel:" + Uri.encode(number))));
            call.resolve();
        } catch (RuntimeException err) {
            call.reject("The phone couldn't start the call.");
        }
    }

    // ---------- Texts and chat replies ----------

    // { number, text }: sends an SMS (the app asked the user first).
    @PluginMethod
    @SuppressWarnings("deprecation") // SmsManager.getDefault() is the only way before Android 12
    public void sendText(PluginCall call) {
        String number = call.getString("number", "").trim();
        String text = call.getString("text", "").trim();
        if (!has(Manifest.permission.SEND_SMS)) {
            call.reject("Texting is off. Turn it on in LightMoon's Settings → Phone.");
            return;
        }
        if (number.replaceAll("[^0-9]", "").length() < 3 || text.isEmpty()) {
            call.reject("A text needs a number and something to say.");
            return;
        }
        try {
            SmsManager sms = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? getContext().getSystemService(SmsManager.class) : SmsManager.getDefault();
            ArrayList<String> parts = sms.divideMessage(text);
            sms.sendMultipartTextMessage(number, null, parts, null, null);
            call.resolve();
        } catch (RuntimeException err) {
            call.reject("The phone couldn't send the text.");
        }
    }

    // { since (ms) } -> { messages: [{ conversation, app, chat, from, text, at, canReply }] }, oldest first
    @PluginMethod
    public void messages(PluginCall call) {
        if (!MessageListener.isEnabled(getContext())) {
            call.reject("Reading messages is off. Turn it on in LightMoon's Settings → Phone.");
            return;
        }
        long since = call.getDouble("since", (double) (System.currentTimeMillis() - 86_400_000L)).longValue();
        try {
            JSObject result = new JSObject();
            result.put("messages", MessageListener.recent(getContext(), since));
            call.resolve(result);
        } catch (JSONException err) {
            call.reject("Couldn't read the messages.");
        }
    }

    // { conversation, text }: answers through that chat's notification (the app asked the user first).
    @PluginMethod
    public void reply(PluginCall call) {
        String conversation = call.getString("conversation", "");
        String text = call.getString("text", "").trim();
        if (text.isEmpty()) {
            call.reject("Say what to reply.");
            return;
        }
        if (MessageListener.reply(getContext(), conversation, text)) call.resolve();
        else call.reject("That chat's notification is gone, so it can't be answered from here. Open the app to reply.");
    }

    // { number, text }: opens the WhatsApp chat with the message written in; the user taps send.
    @PluginMethod
    public void whatsapp(PluginCall call) {
        String digits = call.getString("number", "").replaceAll("[^0-9]", "");
        if (digits.length() < 6) {
            call.reject("WhatsApp needs the full number, with the country code.");
            return;
        }
        Uri chat = Uri.parse("https://wa.me/" + digits + "?text=" + Uri.encode(call.getString("text", "")));
        Intent intent = new Intent(Intent.ACTION_VIEW, chat);
        for (String app : new String[] { "com.whatsapp", "com.whatsapp.w4b" }) {
            if (getContext().getPackageManager().getLaunchIntentForPackage(app) != null) {
                intent.setPackage(app);
                break;
            }
        }
        try {
            getActivity().startActivity(intent);
            call.resolve();
        } catch (ActivityNotFoundException err) {
            call.reject("WhatsApp isn't installed.");
        }
    }

    // ---------- Phone actions ----------

    // { name } -> { label }: opens the installed app whose name matches best.
    @PluginMethod
    public void openApp(PluginCall call) {
        String wanted = simplify(call.getString("name", ""));
        if (wanted.isEmpty()) {
            call.reject("Which app?");
            return;
        }
        PackageManager pm = getContext().getPackageManager();
        List<ResolveInfo> apps = pm.queryIntentActivities(new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER), 0);
        ResolveInfo best = null;
        int bestScore = 0;
        String bestLabel = "";
        for (ResolveInfo app : apps) {
            String label = String.valueOf(app.loadLabel(pm));
            String simple = simplify(label);
            int score = simple.equals(wanted) ? 3 : simple.startsWith(wanted) ? 2 : simple.contains(wanted) ? 1 : 0;
            if (score > bestScore || (score == bestScore && score > 0 && label.length() < bestLabel.length())) {
                best = app;
                bestScore = score;
                bestLabel = label;
            }
        }
        Intent launch = best == null ? null : pm.getLaunchIntentForPackage(best.activityInfo.packageName);
        if (launch == null) {
            call.reject("There's no app called \"" + call.getString("name") + "\" on this phone.");
            return;
        }
        getActivity().startActivity(launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        JSObject result = new JSObject();
        result.put("label", bestLabel);
        call.resolve(result);
    }

    private static String simplify(String text) {
        return text == null ? "" : text.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9]", "");
    }

    // { hour, minute, label?, days?: [1..7, Sunday = 1] }: sets an alarm in the phone's clock app.
    @PluginMethod
    public void setAlarm(PluginCall call) {
        Integer hour = call.getInt("hour");
        Integer minute = call.getInt("minute");
        if (hour == null || minute == null || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
            call.reject("An alarm needs a time.");
            return;
        }
        Intent intent = new Intent(AlarmClock.ACTION_SET_ALARM)
            .putExtra(AlarmClock.EXTRA_HOUR, hour)
            .putExtra(AlarmClock.EXTRA_MINUTES, minute)
            .putExtra(AlarmClock.EXTRA_SKIP_UI, true);
        String label = call.getString("label");
        if (label != null && !label.isEmpty()) intent.putExtra(AlarmClock.EXTRA_MESSAGE, label);
        JSArray days = call.getArray("days");
        if (days != null && days.length() > 0) {
            ArrayList<Integer> list = new ArrayList<>();
            for (int i = 0; i < days.length(); i++) {
                int day = days.optInt(i);
                if (day >= 1 && day <= 7) list.add(day);
            }
            if (!list.isEmpty()) intent.putExtra(AlarmClock.EXTRA_DAYS, list);
        }
        startClock(call, intent);
    }

    // { seconds, label? }: starts a timer in the phone's clock app.
    @PluginMethod
    public void setTimer(PluginCall call) {
        Integer seconds = call.getInt("seconds");
        if (seconds == null || seconds < 1 || seconds > 86_400) {
            call.reject("A timer needs a length up to 24 hours.");
            return;
        }
        Intent intent = new Intent(AlarmClock.ACTION_SET_TIMER)
            .putExtra(AlarmClock.EXTRA_LENGTH, seconds)
            .putExtra(AlarmClock.EXTRA_SKIP_UI, true);
        String label = call.getString("label");
        if (label != null && !label.isEmpty()) intent.putExtra(AlarmClock.EXTRA_MESSAGE, label);
        startClock(call, intent);
    }

    private void startClock(PluginCall call, Intent intent) {
        try {
            getActivity().startActivity(intent);
            call.resolve();
        } catch (ActivityNotFoundException err) {
            call.reject("This phone's clock app doesn't take alarms from other apps.");
        }
    }

    // { on }
    @PluginMethod
    public void flashlight(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", true));
        CameraManager cameras = getContext().getSystemService(CameraManager.class);
        try {
            for (String id : cameras.getCameraIdList()) {
                if (Boolean.TRUE.equals(cameras.getCameraCharacteristics(id).get(CameraCharacteristics.FLASH_INFO_AVAILABLE))) {
                    cameras.setTorchMode(id, on);
                    call.resolve();
                    return;
                }
            }
            call.reject("This phone has no flashlight.");
        } catch (CameraAccessException | RuntimeException err) {
            call.reject("The flashlight is busy (the camera may be in use).");
        }
    }

    // { stream: "media" | "ring" | "alarm", percent: 0-100 }
    @PluginMethod
    public void volume(PluginCall call) {
        String stream = call.getString("stream", "media");
        int type = "ring".equals(stream) ? AudioManager.STREAM_RING : "alarm".equals(stream) ? AudioManager.STREAM_ALARM : AudioManager.STREAM_MUSIC;
        int percent = Math.max(0, Math.min(100, call.getInt("percent", 50)));
        AudioManager audio = getContext().getSystemService(AudioManager.class);
        try {
            int level = Math.round(audio.getStreamMaxVolume(type) * percent / 100f);
            audio.setStreamVolume(type, level, AudioManager.FLAG_SHOW_UI);
            call.resolve();
        } catch (SecurityException err) {
            call.reject("Android won't let apps change that while Do Not Disturb is on.");
        }
    }
}
