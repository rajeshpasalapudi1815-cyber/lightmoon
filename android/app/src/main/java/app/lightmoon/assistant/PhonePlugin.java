package app.lightmoon.assistant;

import android.Manifest;
import android.app.Activity;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.IntentFilter;
import android.os.Handler;
import android.os.Looper;
import java.util.concurrent.atomic.AtomicBoolean;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.database.Cursor;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraManager;
import android.content.ComponentName;
import android.media.AudioManager;
import android.media.session.MediaController;
import android.media.session.MediaSessionManager;
import android.media.session.PlaybackState;
import android.net.Uri;
import android.os.BatteryManager;
import android.os.Build;
import android.provider.AlarmClock;
import android.provider.CallLog;
import android.provider.Settings;
import android.telephony.PhoneNumberUtils;
import android.telephony.SmsManager;
import android.view.KeyEvent;
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
import java.util.Arrays;
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
        @Permission(strings = { Manifest.permission.ACTIVITY_RECOGNITION }, alias = "steps"),
    }
)
public class PhonePlugin extends Plugin {

    private static final int MAX_CALLS = 30;
    private static volatile PhonePlugin active;

    @Override
    public void load() {
        active = this;
        MessageListener.reconnectIfNeeded(getContext());
        Briefings.scheduleAll(getContext());
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

    // ---------- Numbers from the web app ----------
    // org.json reads a whole number above 2^31 (a time in milliseconds) as a Long, which Capacitor's getDouble
    // and getInt don't accept, and 66.00000000000001 as a Double, which getInt doesn't: read any number.

    private static Long longArg(PluginCall call, String name, Long fallback) {
        Object value = call.getData().opt(name);
        return value instanceof Number ? Long.valueOf(Math.round(((Number) value).doubleValue())) : fallback;
    }

    // Not a ternary: "value == null ? fallback : (int) ..." unboxes a null fallback and crashes the app.
    private static Integer intArg(PluginCall call, String name, Integer fallback) {
        Long value = longArg(call, name, null);
        if (value == null) return fallback;
        return (int) Math.max(Integer.MIN_VALUE, Math.min(Integer.MAX_VALUE, value));
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
        status.put("silence", Build.VERSION.SDK_INT < Build.VERSION_CODES.M
            || getContext().getSystemService(NotificationManager.class).isNotificationPolicyAccessGranted());
        status.put("telephony", PhonePrefs.hasTelephony(getContext()));
        status.put("meetingLead", PhonePrefs.meetingLead(getContext()));
        status.put("announceCalls", PhonePrefs.announceCalls(getContext()));
        status.put("readMessages", PhonePrefs.readMessages(getContext()));
        status.put("briefingMorning", Briefings.time(getContext(), Briefings.MORNING));
        status.put("briefingEvening", Briefings.time(getContext(), Briefings.EVENING));
        status.put("briefingCall", MorningCall.on(getContext()));
        status.put("callCoversScreen", MorningCall.canCoverScreen(getContext()));
        status.put("focusUntil", Focus.active(getContext()) ? Focus.until(getContext()) : 0);
        status.put("driving", Driving.why(getContext()));
        status.put("steps", Steps.available(getContext()) && Steps.allowed(getContext()));
        status.put("stepCounter", Steps.available(getContext()));
        status.put("streakGuard", Streaks.time(getContext()));
        return status;
    }

    // Whether they're on a phone or WhatsApp call now: the app keeps scheduled things quiet until it ends.
    @PluginMethod
    public void busy(PluginCall call) {
        JSObject result = new JSObject();
        result.put("inCall", PhonePrefs.inCall(getContext()));
        call.resolve(result);
    }

    // { on }: the app started or stopped speaking, so the volume-down button can stop it (VolumeStop).
    @PluginMethod
    public void speaking(PluginCall call) {
        VolumeStop.pageSpeaking = Boolean.TRUE.equals(call.getBoolean("on", false));
        VolumeStop.watch(getContext());
        call.resolve();
    }

    @PluginMethod
    public void status(PluginCall call) {
        try {
            call.resolve(currentStatus());
        } catch (RuntimeException err) {
            call.reject("Couldn't read the phone settings.");
        }
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

    @PluginMethod
    public void requestSteps(PluginCall call) {
        if (Steps.allowed(getContext())) call.resolve(currentStatus());
        else requestPermissionForAlias("steps", call, "answered");
    }

    // -> { steps } today, or -1 when the phone can't tell.
    @PluginMethod
    public void steps(PluginCall call) {
        new Thread(() -> {
            try {
                JSObject result = new JSObject();
                result.put("steps", Steps.today(getContext()));
                call.resolve(result);
            } catch (RuntimeException err) {
                call.reject("Couldn't read the step counter.");
            }
        }, "lightmoon-steps-read").start();
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
        } catch (RuntimeException err) {
            call.reject("Open Settings → Notifications → Device & app notifications and allow LightMoon.");
        }
    }

    // { meetingLead (minutes, 0 = off), announceCalls, readMessages ("off" | "sender" | "full"), address,
    //   briefingMorning, briefingEvening ("07:00" or "" = off), place: { name, latitude, longitude } for the weather }
    // The app calls this every time it opens, so nothing here may escape: Capacitor turns it into a crash.
    @PluginMethod
    public void configure(PluginCall call) {
        try {
            saveConfiguration(call);
            call.resolve(currentStatus());
        } catch (RuntimeException err) {
            call.reject("Couldn't save the phone settings.");
        }
    }

    private void saveConfiguration(PluginCall call) {
        android.content.SharedPreferences.Editor edit = PhonePrefs.get(getContext()).edit();
        Integer lead = intArg(call, "meetingLead", null);
        if (lead != null) edit.putInt("meetingLead", Math.max(0, Math.min(lead, 120)));
        Boolean calls = call.getBoolean("announceCalls");
        if (calls != null) edit.putBoolean("announceCalls", calls);
        String messages = call.getString("readMessages");
        if ("off".equals(messages) || "sender".equals(messages) || "full".equals(messages)) edit.putString("readMessages", messages);
        String streak = call.getString("streakGuard");
        if (streak != null && (streak.isEmpty() || streak.matches("\\d{2}:\\d{2}"))) edit.putString("streakGuard", streak);
        String address = call.getString("address");
        if (address != null && !address.trim().isEmpty()) edit.putString("address", address.trim());
        for (String kind : new String[] { Briefings.MORNING, Briefings.EVENING }) {
            String time = call.getString(kind.equals(Briefings.MORNING) ? "briefingMorning" : "briefingEvening");
            if (time != null && (time.isEmpty() || time.matches("\\d{2}:\\d{2}"))) edit.putString("briefing_" + kind, time);
        }
        Boolean briefingCall = call.getBoolean("briefingCall");
        if (briefingCall != null) edit.putBoolean("briefing_call", briefingCall);
        JSObject place = call.getObject("place");
        if (place != null && place.has("latitude") && place.has("longitude")) {
            edit.putString("placeName", place.optString("name", ""))
                .putString("placeLat", String.valueOf(place.optDouble("latitude")))
                .putString("placeLon", String.valueOf(place.optDouble("longitude")));
        }
        edit.commit();
        Briefings.scheduleAll(getContext());
        Meetings.reschedule(getContext());
        if (PhonePrefs.meetingLead(getContext()) > 0 && Meetings.canRead(getContext())) MeetingWorker.start(getContext());
        else MeetingWorker.stop(getContext());
    }

    // { kind: "morning" | "evening" }: says that briefing now, to hear what it sounds like.
    @PluginMethod
    public void briefingNow(PluginCall call) {
        String kind = Briefings.EVENING.equals(call.getString("kind")) ? Briefings.EVENING : Briefings.MORNING;
        try {
            ContextCompat.startForegroundService(getContext(), new Intent(getContext(), SpeakService.class).putExtra("briefing", kind));
            call.resolve();
        } catch (RuntimeException err) {
            call.reject("The phone wouldn't start the briefing right now.");
        }
    }

    // The calls at other times: -> { calls: [{ id, time, daily, date }] }; with { calls: [...] } replaces them first.
    @PluginMethod
    public void callTimes(PluginCall call) {
        com.getcapacitor.JSArray given = call.getArray("calls");
        org.json.JSONArray list = given == null ? MorningCall.calls(getContext()) : MorningCall.setCalls(getContext(), given);
        JSObject result = new JSObject();
        result.put("calls", list);
        call.resolve(result);
    }

    // Rings the morning call now, to try it.
    @PluginMethod
    public void callNow(PluginCall call) {
        MorningCall.ring(getContext());
        call.resolve();
    }

    // Android 14 and later: the page where the user lets LightMoon's call cover the screen (lock screen included).
    @PluginMethod
    public void openCallSettings(PluginCall call) {
        Intent open = Build.VERSION.SDK_INT >= 34
            ? new Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:" + getContext().getPackageName()))
            : new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, getContext().getPackageName());
        try {
            getActivity().startActivity(open);
            call.resolve();
        } catch (RuntimeException err) {
            call.reject("Couldn't open that settings page.");
        }
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
        long from = longArg(call, "from", now);
        long to = longArg(call, "to", now + 86_400_000L);
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
        Long start = longArg(call, "start", null);
        Long end = longArg(call, "end", null);
        if (title.isEmpty() || start == null || end == null || end <= start) {
            call.reject("An event needs a title, a start and an end after it.");
            return;
        }
        try {
            long id = Meetings.add(getContext(), title, start, end, call.getString("location"), call.getString("notes"));
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
        long since = longArg(call, "since", System.currentTimeMillis() - 86_400_000L);
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

    // { number } -> { name ("" when not a contact), calls: [{ type, at, seconds }] }: who a number is, as far as
    // this phone knows, and the calls with it over the last 90 days (newest first, at most 20).
    @PluginMethod
    public void numberInfo(PluginCall call) {
        String number = call.getString("number", "").trim();
        if (number.isEmpty()) {
            call.reject("Which number?");
            return;
        }
        try {
            String name = Contacts.nameFor(getContext(), number);
            JSArray calls = new JSArray();
            if (has(Manifest.permission.READ_CALL_LOG)) {
                String[] columns = { CallLog.Calls.NUMBER, CallLog.Calls.TYPE, CallLog.Calls.DATE, CallLog.Calls.DURATION };
                String since = String.valueOf(System.currentTimeMillis() - 90L * 86_400_000L);
                try (Cursor cursor = getContext().getContentResolver().query(
                    CallLog.Calls.CONTENT_URI, columns, CallLog.Calls.DATE + " >= ?", new String[] { since }, CallLog.Calls.DATE + " DESC")) {
                    while (cursor != null && cursor.moveToNext() && calls.length() < 20) {
                        if (!PhoneNumberUtils.compare(number, cursor.getString(0))) continue;
                        JSObject item = new JSObject();
                        item.put("type", callType(cursor.getInt(1)));
                        item.put("at", cursor.getLong(2));
                        item.put("seconds", cursor.getLong(3));
                        calls.put(item);
                    }
                }
            }
            JSObject result = new JSObject();
            result.put("name", name == null ? "" : name);
            result.put("calls", calls);
            result.put("callHistory", has(Manifest.permission.READ_CALL_LOG));
            call.resolve(result);
        } catch (RuntimeException err) {
            call.reject("Couldn't look up that number.");
        }
    }

    // { number, app?: "truecaller" }: shows the number in Truecaller's dialer (or the phone's own) without
    // calling it, so its caller ID appears on screen. Other apps never share what they know about a number.
    @PluginMethod
    public void showNumber(PluginCall call) {
        String number = call.getString("number", "").trim();
        if (number.isEmpty()) {
            call.reject("Which number?");
            return;
        }
        Intent dial = new Intent(Intent.ACTION_DIAL, Uri.fromParts("tel", number, null)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        boolean truecaller = "truecaller".equals(call.getString("app"));
        JSObject result = new JSObject();
        try {
            if (truecaller) {
                try {
                    getActivity().startActivity(new Intent(dial).setPackage("com.truecaller"));
                    result.put("shownIn", "truecaller");
                    call.resolve(result);
                    return;
                } catch (RuntimeException notInstalled) {
                    result.put("note", "Truecaller isn't installed, so it opened in the phone's dialer.");
                }
            }
            getActivity().startActivity(dial);
            result.put("shownIn", "dialer");
            call.resolve(result);
        } catch (RuntimeException err) {
            call.reject("Couldn't open the dialer.");
        }
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

    // { number, text }: sends an SMS (the app asked the user first), and answers once the phone says it went
    // (or didn't: no signal, no default SIM), so LightMoon never says "sent" for a text that wasn't.
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
        Context context = getContext();
        String action = "app.lightmoon.assistant.SMS_SENT." + System.nanoTime();
        Handler main = new Handler(Looper.getMainLooper());
        AtomicBoolean answered = new AtomicBoolean(false);
        int[] waiting = { 0 };
        boolean[] failed = { false };
        BroadcastReceiver[] receiver = { null };
        Runnable answer = () -> {
            if (!answered.compareAndSet(false, true)) return;
            try { context.unregisterReceiver(receiver[0]); } catch (RuntimeException ignored) { /* already gone */ }
            if (failed[0]) call.reject("The text didn't go: the phone may have no signal, or no SIM chosen for texts.");
            else if (waiting[0] > 0) call.reject("The phone hasn't confirmed the text was sent yet. It may go when there's signal.");
            else call.resolve();
        };
        receiver[0] = new BroadcastReceiver() {
            @Override
            public void onReceive(Context ctx, Intent intent) {
                if (getResultCode() != Activity.RESULT_OK) failed[0] = true;
                if (--waiting[0] <= 0 || failed[0]) main.post(answer);
            }
        };
        try {
            SmsManager sms = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S ? context.getSystemService(SmsManager.class) : SmsManager.getDefault();
            ArrayList<String> parts = sms.divideMessage(text);
            ArrayList<PendingIntent> sent = new ArrayList<>();
            for (int i = 0; i < parts.size(); i++) {
                Intent result = new Intent(action).setPackage(context.getPackageName());
                sent.add(PendingIntent.getBroadcast(context, i, result, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_ONE_SHOT));
            }
            waiting[0] = parts.size();
            ContextCompat.registerReceiver(context, receiver[0], new IntentFilter(action), ContextCompat.RECEIVER_NOT_EXPORTED);
            sms.sendMultipartTextMessage(number, null, parts, sent, null);
            main.postDelayed(answer, 30_000);
        } catch (RuntimeException err) {
            failed[0] = true;
            main.post(answer);
        }
    }

    // { since (ms) } -> { messages: [{ conversation, app, chat, from, text, at, canReply }] }, oldest first
    @PluginMethod
    public void messages(PluginCall call) {
        if (!MessageListener.isEnabled(getContext())) {
            call.reject("Reading messages is off. Turn it on in LightMoon's Settings → Phone.");
            return;
        }
        long since = longArg(call, "since", System.currentTimeMillis() - 86_400_000L);
        try {
            JSObject result = new JSObject();
            result.put("messages", MessageListener.recent(getContext(), since));
            call.resolve(result);
        } catch (JSONException err) {
            call.reject("Couldn't read the messages.");
        }
    }

    // What LightMoon may read (see ReadRules) -> { apps, accounts, chats }, each with allowed.
    @PluginMethod
    public void readingSources(PluginCall call) {
        MessageListener.reconnectIfNeeded(getContext());
        try {
            call.resolve(JSObject.fromJSONObject(ReadRules.sources(getContext())));
        } catch (JSONException | RuntimeException err) {
            call.reject("Couldn't read the reading settings.");
        }
    }

    // { app, allowed } for a whole app; { account, app, allowed } for an email account ("" = the app's unnamed one);
    // { app, chat, allowed } for a chat or person. -> the updated { apps, accounts, chats }
    @PluginMethod
    public void setReading(PluginCall call) {
        Boolean allowed = call.getBoolean("allowed");
        String app = call.getString("app", "");
        String account = call.getString("account");
        String chat = call.getString("chat");
        if (allowed == null || app.isEmpty()) {
            call.reject("Say which app, and on or off.");
            return;
        }
        try {
            if (account != null) ReadRules.allowAccount(getContext(), ReadRules.accountKey(app, account), allowed);
            else if (chat != null) ReadRules.allowChat(getContext(), app, chat, allowed);
            else ReadRules.allowApp(getContext(), app, allowed);
            MessageListener.rulesChanged(getContext());
            call.resolve(JSObject.fromJSONObject(ReadRules.sources(getContext())));
        } catch (JSONException | RuntimeException err) {
            call.reject("Couldn't change that.");
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
        try {
            if (MessageListener.reply(getContext(), conversation, text)) call.resolve();
            else call.reject("That chat's notification is gone, so it can't be answered from here. Open the app to reply.");
        } catch (RuntimeException err) {
            call.reject("That chat didn't take the reply. Open the app to reply.");
        }
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
        // In its own task: in LightMoon's, it would go to the back with LightMoon when the Send helper steps aside.
        Intent intent = new Intent(Intent.ACTION_VIEW, chat).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        for (String app : new String[] { "com.whatsapp", "com.whatsapp.w4b" }) {
            if (getContext().getPackageManager().getLaunchIntentForPackage(app) != null) {
                intent.setPackage(app);
                break;
            }
        }
        try {
            getActivity().startActivity(intent);
            call.resolve();
        } catch (RuntimeException err) {
            call.reject("WhatsApp isn't installed.");
        }
    }

    // ---------- Phone actions ----------

    // The installed app whose name matches best: { package, label }, or null.
    private String[] findApp(String name) {
        String wanted = simplify(name);
        if (wanted.isEmpty()) return null;
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
        return best == null ? null : new String[] { best.activityInfo.packageName, bestLabel };
    }

    // Puts text on the clipboard, for pasting where an app can't take it ready-made.
    private void copy(String text) {
        android.content.ClipboardManager clipboard = getContext().getSystemService(android.content.ClipboardManager.class);
        if (clipboard != null) clipboard.setPrimaryClip(android.content.ClipData.newPlainText("LightMoon", text));
    }

    // { url, app?, copy? } -> { label }: opens a link (a Teams chat, a mailto:...) in that app if it's installed,
    // else in whatever handles it; copy also puts that text on the clipboard. The user sends from there.
    @PluginMethod
    public void openLink(PluginCall call) {
        String url = call.getString("url", "");
        if (url.isEmpty()) {
            call.reject("Which link?");
            return;
        }
        Uri link = Uri.parse(url);
        String scheme = link.getScheme() == null ? "" : link.getScheme().toLowerCase(Locale.ROOT);
        if (!Arrays.asList("https", "mailto", "msteams").contains(scheme)) {
            call.reject("LightMoon only opens web, email and Teams links.");
            return;
        }
        String[] app = findApp(call.getString("app", ""));
        Intent view = new Intent(Intent.ACTION_VIEW, link).addCategory(Intent.CATEGORY_BROWSABLE).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        view.setSelector(null);
        String copy = call.getString("copy");
        if (copy != null && !copy.isEmpty()) copy(copy);
        try {
            if (app != null) {
                try {
                    getActivity().startActivity(new Intent(view).setPackage(app[0]));
                    JSObject result = new JSObject();
                    result.put("label", app[1]);
                    call.resolve(result);
                    return;
                } catch (RuntimeException notThere) {
                    // That app doesn't take this link: let Android choose.
                }
            }
            getActivity().startActivity(view);
            JSObject result = new JSObject();
            result.put("label", "");
            call.resolve(result);
        } catch (RuntimeException err) {
            call.reject("Nothing on this phone can open that link.");
        }
    }

    // { text, app } -> { label }: shares the text into that app (its own "share to" screen, where the user picks
    // the chat), or Android's share sheet when the app isn't found. The text is on the clipboard too.
    @PluginMethod
    public void shareText(PluginCall call) {
        String text = call.getString("text", "");
        if (text.isEmpty()) {
            call.reject("What should it say?");
            return;
        }
        copy(text);
        Intent send = new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text);
        String[] app = findApp(call.getString("app", ""));
        JSObject result = new JSObject();
        try {
            if (app != null) {
                try {
                    getActivity().startActivity(new Intent(send).setPackage(app[0]).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                    result.put("label", app[1]);
                    call.resolve(result);
                    return;
                } catch (RuntimeException notThere) {
                    // It doesn't take shared text: offer every app that does.
                }
            }
            getActivity().startActivity(Intent.createChooser(send, "Send with").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            result.put("label", "");
            call.resolve(result);
        } catch (RuntimeException err) {
            call.reject("Couldn't share the message.");
        }
    }

    // ---------- Messages to send later (ScheduledSends.java) ----------

    // { at, via: "whatsapp" | "sms", number, name, text } -> { id }. The app has read it back and had the user's yes.
    @PluginMethod
    public void scheduleSend(PluginCall call) {
        long at = longArg(call, "at", 0L);
        String via = call.getString("via", "whatsapp");
        String number = call.getString("number", "").trim();
        String text = call.getString("text", "").trim();
        if (at <= System.currentTimeMillis() || text.isEmpty() || number.replaceAll("[^0-9]", "").length() < 6) {
            call.reject("A scheduled message needs a time ahead, a number and the words.");
            return;
        }
        if ("sms".equals(via) && !has(Manifest.permission.SEND_SMS)) {
            call.reject("Texting is off. Turn it on in LightMoon's Settings → Phone, or send it on WhatsApp.");
            return;
        }
        String digits = "sms".equals(via) ? number : number.replaceAll("[^0-9]", "");
        ScheduledSends.Send send = ScheduledSends.add(getContext(), at, via, digits, call.getString("name", number), text);
        if (send == null) {
            call.reject("There are already 50 messages waiting to go.");
            return;
        }
        JSObject result = new JSObject();
        result.put("id", send.id);
        result.put("helper", SendHelper.isEnabled(getContext()));
        call.resolve(result);
    }

    // -> { sends: [{ id, at, via, name, text }] }, soonest first.
    @PluginMethod
    public void scheduledSends(PluginCall call) {
        JSArray list = new JSArray();
        List<ScheduledSends.Send> sends = ScheduledSends.all(getContext());
        sends.sort((a, b) -> Long.compare(a.at, b.at));
        for (ScheduledSends.Send send : sends) {
            JSObject item = new JSObject();
            item.put("id", send.id);
            item.put("at", send.at);
            item.put("via", send.via);
            item.put("name", send.name);
            item.put("text", send.text);
            list.put(item);
        }
        JSObject result = new JSObject();
        result.put("sends", list);
        call.resolve(result);
    }

    // { id } -> { cancelled }.
    @PluginMethod
    public void cancelScheduledSend(PluginCall call) {
        JSObject result = new JSObject();
        result.put("cancelled", ScheduledSends.cancel(getContext(), call.getString("id", "")));
        call.resolve(result);
    }

    // The Send helper (SendHelper.java): { enabled } now.
    @PluginMethod
    public void sendHelper(PluginCall call) {
        JSObject result = new JSObject();
        result.put("enabled", SendHelper.isEnabled(getContext()));
        call.resolve(result);
    }

    // Android's accessibility settings, where the user switches the Send helper on.
    @PluginMethod
    public void openSendHelperSettings(PluginCall call) {
        try {
            getActivity().startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            call.resolve();
        } catch (RuntimeException err) {
            call.reject("Couldn't open the accessibility settings.");
        }
    }

    // { apps: [package...], text } : the user said "send it": arms the Send helper for that draft and goes back to
    // the app it's in, where the helper taps Send if the words are on screen. -> { armed }.
    @PluginMethod
    public void tapSend(PluginCall call) {
        if (!SendHelper.isEnabled(getContext())) {
            call.reject("The Send helper is off. Switch it on in LightMoon's Settings → Phone → Send helper.");
            return;
        }
        List<String> apps = new ArrayList<>();
        try {
            JSArray given = call.getArray("apps");
            for (int i = 0; given != null && i < given.length(); i++) apps.add(given.getString(i));
        } catch (JSONException err) {
            call.reject("apps must be a list.");
            return;
        }
        String text = call.getString("text", "");
        if (apps.isEmpty() || text.trim().isEmpty()) {
            call.reject("Which draft?");
            return;
        }
        SendHelper.arm(apps, text, call.getString("chat", ""));
        // stay: the app was just opened in front of LightMoon (WhatsApp from phone_message); stepping LightMoon back
        // now would count as a background start and Android would close it again.
        if (Boolean.TRUE.equals(call.getBoolean("stay", false))) {
            JSObject armed = new JSObject();
            armed.put("armed", true);
            call.resolve(armed);
            return;
        }
        getActivity().runOnUiThread(() -> {
            if (getActivity() instanceof MainActivity) ((MainActivity) getActivity()).leavePanel();
            else getActivity().moveTaskToBack(true);
            JSObject result = new JSObject();
            result.put("armed", true);
            call.resolve(result);
        });
    }

    // { chat, text, send? }: the Send helper opens that Teams chat by name and types the text (and sends, if asked).
    @PluginMethod
    public void openTeamsChat(PluginCall call) {
        if (!SendHelper.isEnabled(getContext())) {
            call.reject("The Send helper is off. Switch it on in LightMoon's Settings → Phone → Send helper.");
            return;
        }
        String chat = call.getString("chat", "").trim();
        if (chat.isEmpty()) {
            call.reject("Which chat?");
            return;
        }
        boolean started = SendHelper.openChat(getContext(), chat, call.getString("text", ""), Boolean.TRUE.equals(call.getBoolean("send", false)));
        if (!started) {
            call.reject("Teams isn't installed, or the Send helper isn't running yet.");
            return;
        }
        getActivity().runOnUiThread(() -> {
            if (getActivity() instanceof MainActivity && MainActivity.panel) ((MainActivity) getActivity()).leavePanel();
            call.resolve();
        });
    }

    // { name } -> { label }: opens the installed app whose name matches best.
    @PluginMethod
    public void openApp(PluginCall call) {
        if (simplify(call.getString("name", "")).isEmpty()) {
            call.reject("Which app?");
            return;
        }
        PackageManager pm = getContext().getPackageManager();
        String[] found = findApp(call.getString("name", ""));
        String bestLabel = found == null ? "" : found[1];
        Intent launch = found == null ? null : pm.getLaunchIntentForPackage(found[0]);
        if (launch == null) {
            call.reject("There's no app called \"" + call.getString("name") + "\" on this phone.");
            return;
        }
        try {
            getActivity().startActivity(launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        } catch (RuntimeException err) {
            call.reject("Android wouldn't open " + bestLabel + ".");
            return;
        }
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
        Integer hour = intArg(call, "hour", null);
        Integer minute = intArg(call, "minute", null);
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
        Integer seconds = intArg(call, "seconds", null);
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
        } catch (RuntimeException err) {
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

    // { action: "play" | "pause" | "toggle" | "next" | "previous", query?, app? }: for whichever app is playing (Spotify,
    // YouTube Music...). "play" with nothing to resume, or with a song, artist or mood to play, opens a music app and
    // has it play that (Android's "play from search"). -> { musicActive, app }: whether music is heard now, so
    // LightMoon never says "playing" when nothing is.
    @PluginMethod
    public void media(PluginCall call) {
        String action = call.getString("action", "toggle");
        String query = call.getString("query", "").trim();
        AudioManager audio = getContext().getSystemService(AudioManager.class);
        boolean play = "play".equals(action) || ("toggle".equals(action) && !musicPlaying(audio));
        if (!play || query.isEmpty()) {
            int key;
            switch (action) {
                case "play": key = KeyEvent.KEYCODE_MEDIA_PLAY; break;
                case "pause": key = KeyEvent.KEYCODE_MEDIA_PAUSE; break;
                case "next": key = KeyEvent.KEYCODE_MEDIA_NEXT; break;
                case "previous": key = KeyEvent.KEYCODE_MEDIA_PREVIOUS; break;
                default: key = KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE;
            }
            // To the music app itself (a key press goes to whichever app last held the sound, a Teams call too); to the
            // one they named, if they did (no key press then, which could start another app).
            String named = call.getString("app", "").trim();
            String[] chosen = named.isEmpty() ? null : musicApp(named);
            if (!control(action, chosen == null ? null : chosen[0], "") && (chosen == null || !play)) {
                try {
                    pressMediaKey(audio, key);
                } catch (RuntimeException err) {
                    call.reject("The music app didn't take it.");
                    return;
                }
            }
        }
        Handler main = new Handler(Looper.getMainLooper());
        if (!play) {
            main.postDelayed(() -> resolveMedia(call, audio, ""), 600);
            return;
        }
        // Give a paused player a moment to start again before opening one.
        main.postDelayed(() -> {
            if (query.isEmpty() && musicPlaying(audio)) {
                resolveMedia(call, audio, "");
                return;
            }
            String[] player = musicApp(call.getString("app", ""));
            if (player == null) {
                resolveMedia(call, audio, "");
                return;
            }
            Intent search = new Intent(android.provider.MediaStore.INTENT_ACTION_MEDIA_PLAY_FROM_SEARCH)
                .setPackage(player[0])
                .putExtra(android.app.SearchManager.QUERY, query)
                .putExtra(android.provider.MediaStore.EXTRA_MEDIA_FOCUS, "vnd.android.cursor.item/*")
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            try {
                getActivity().startActivity(search);
            } catch (RuntimeException noSearch) {
                Intent launch = getContext().getPackageManager().getLaunchIntentForPackage(player[0]);
                try {
                    if (launch != null) getActivity().startActivity(launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                } catch (RuntimeException ignored) {
                    // Answered below: nothing playing.
                }
            }
            // Some apps open but wait for a play: press it once they're up, then see whether music is heard.
            main.postDelayed(() -> {
                if (!musicPlaying(audio) && !control("play", player[0], query)) {
                    try {
                        pressMediaKey(audio, KeyEvent.KEYCODE_MEDIA_PLAY);
                    } catch (RuntimeException ignored) {
                        // Reported as not playing.
                    }
                }
                main.postDelayed(() -> {
                    // Some accounts (Spotify Free) won't play a chosen song for another app: play their music instead, and say so.
                    if (query.isEmpty() || musicPlaying(audio) || !control("play", player[0], "")) {
                        resolveMedia(call, audio, player[1]);
                        return;
                    }
                    main.postDelayed(() -> {
                        JSObject result = new JSObject();
                        result.put("musicActive", musicPlaying(audio));
                        result.put("app", player[1]);
                        result.put("instead", true);
                        call.resolve(result);
                    }, 2000);
                }, 2500);
            }, 4000);
        }, query.isEmpty() ? 900 : 0);
    }

    // Apps whose sessions aren't music: a Teams meeting, a call, LightMoon's own voice.
    private static final List<String> NOT_PLAYERS = Arrays.asList("app.lightmoon.assistant", "com.microsoft.teams",
        "com.android.server.telecom", "com.google.android.dialer", "com.whatsapp", "com.whatsapp.w4b");

    // Whether a player is playing now, by the players' own state (seen with the notification access LightMoon has for
    // messages). Without that access, whether anything sounds on the music stream, which other audio also counts as.
    private boolean musicPlaying(AudioManager audio) {
        try {
            MediaSessionManager sessions = getContext().getSystemService(MediaSessionManager.class);
            for (MediaController player : sessions.getActiveSessions(new ComponentName(getContext(), MessageListener.class))) {
                PlaybackState state = player.getPlaybackState();
                if (!NOT_PLAYERS.contains(player.getPackageName()) && state != null && state.getState() == PlaybackState.STATE_PLAYING) return true;
            }
            return false;
        } catch (RuntimeException noAccess) {
            return audio.isMusicActive();
        }
    }

    // Plays, pauses or skips on a music app's own controls: that app's (pkg), else the one playing, else the first
    // paused one. For play with a query, it plays that. -> false when there is no such player to ask.
    private boolean control(String action, String pkg, String query) {
        MediaController chosen = null;
        try {
            MediaSessionManager sessions = getContext().getSystemService(MediaSessionManager.class);
            for (MediaController player : sessions.getActiveSessions(new ComponentName(getContext(), MessageListener.class))) {
                if (NOT_PLAYERS.contains(player.getPackageName()) || (pkg != null && !pkg.equals(player.getPackageName()))) continue;
                PlaybackState state = player.getPlaybackState();
                if (chosen == null || (state != null && state.getState() == PlaybackState.STATE_PLAYING)) chosen = player;
            }
        } catch (RuntimeException noAccess) {
            return false;
        }
        if (chosen == null) return false;
        MediaController.TransportControls controls = chosen.getTransportControls();
        switch (action) {
            case "play":
                if (query.isEmpty()) controls.play();
                else controls.playFromSearch(query, new android.os.Bundle());
                break;
            case "pause": controls.pause(); break;
            case "next": controls.skipToNext(); break;
            case "previous": controls.skipToPrevious(); break;
            default:
                PlaybackState state = chosen.getPlaybackState();
                if (state != null && state.getState() == PlaybackState.STATE_PLAYING) controls.pause();
                else controls.play();
        }
        return true;
    }

    private static void pressMediaKey(AudioManager audio, int key) {
        audio.dispatchMediaKeyEvent(new KeyEvent(KeyEvent.ACTION_DOWN, key));
        audio.dispatchMediaKeyEvent(new KeyEvent(KeyEvent.ACTION_UP, key));
    }

    private void resolveMedia(PluginCall call, AudioManager audio, String app) {
        JSObject result = new JSObject();
        result.put("musicActive", musicPlaying(audio));
        result.put("app", app);
        call.resolve(result);
    }

    // The music app to play with: the one asked for if it's installed, else the first installed of the usual ones.
    // -> { package, label } or null.
    private static final String[][] MUSIC_APPS = {
        { "com.spotify.music", "Spotify" },
        { "com.google.android.apps.youtube.music", "YouTube Music" },
        { "com.jio.media.jiobeats", "JioSaavn" },
        { "com.bsbportal.music", "Wynk Music" },
        { "com.gaana", "Gaana" },
        { "com.amazon.mp3", "Amazon Music" },
        { "com.apple.android.music", "Apple Music" },
        // The phone makers' own players.
        { "com.android.bbkmusic", "i Music" },
        { "com.miui.player", "Mi Music" },
        { "com.sec.android.app.music", "Samsung Music" },
        { "com.heytap.music", "Music" },
        { "com.oneplus.music", "Music" },
    };

    // The music apps on this phone, each { package, label } with the label the phone shows.
    private List<String[]> installedMusicApps() {
        PackageManager pm = getContext().getPackageManager();
        List<String[]> found = new ArrayList<>();
        for (String[] app : MUSIC_APPS) {
            if (pm.getLaunchIntentForPackage(app[0]) == null) continue;
            String label = app[1];
            try {
                label = String.valueOf(pm.getApplicationLabel(pm.getApplicationInfo(app[0], 0)));
            } catch (PackageManager.NameNotFoundException ignored) {
                // Keep the usual name.
            }
            found.add(new String[] { app[0], label });
        }
        return found;
    }

    // -> { apps: [label...] }: so LightMoon can ask which one when they didn't say.
    @PluginMethod
    public void musicApps(PluginCall call) {
        JSArray apps = new JSArray();
        for (String[] app : installedMusicApps()) apps.put(app[1]);
        JSObject result = new JSObject();
        result.put("apps", apps);
        call.resolve(result);
    }

    private String[] musicApp(String wanted) {
        String asked = simplify(wanted);
        List<String[]> installed = installedMusicApps();
        if (!asked.isEmpty()) {
            for (String[] app : installed) {
                if (simplify(app[1]).contains(asked) || asked.contains(simplify(app[1]))) return app;
            }
            String[] other = findApp(wanted);
            if (other != null) return other;
        }
        return installed.isEmpty() ? null : installed.get(0);
    }

    // { destination, mode?: "drive" | "walk" | "bike" | "transit" }: turn-by-turn directions in Google Maps.
    @PluginMethod
    public void navigate(PluginCall call) {
        String destination = call.getString("destination", "").trim();
        if (destination.isEmpty()) {
            call.reject("Where to?");
            return;
        }
        String mode = call.getString("mode", "drive");
        String code = "walk".equals(mode) ? "w" : "bike".equals(mode) ? "b" : "transit".equals(mode) ? "r" : "d";
        Intent maps = new Intent(Intent.ACTION_VIEW, Uri.parse("google.navigation:q=" + Uri.encode(destination) + "&mode=" + code))
            .setPackage("com.google.android.apps.maps");
        try {
            getActivity().startActivity(maps);
        } catch (RuntimeException err) {
            // No Google Maps: any maps app, as a search for the place.
            openView(call, Uri.parse("geo:0,0?q=" + Uri.encode(destination)), "There's no maps app on this phone.");
            return;
        }
        call.resolve();
    }

    // { query, where?: "web" | "youtube" | "maps" }: opens the search in the right app or the browser.
    @PluginMethod
    public void search(PluginCall call) {
        String query = call.getString("query", "").trim();
        if (query.isEmpty()) {
            call.reject("Search for what?");
            return;
        }
        String where = call.getString("where", "web");
        Uri uri = "youtube".equals(where) ? Uri.parse("https://www.youtube.com/results?search_query=" + Uri.encode(query))
            : "maps".equals(where) ? Uri.parse("geo:0,0?q=" + Uri.encode(query))
            : Uri.parse("https://www.google.com/search?q=" + Uri.encode(query));
        openView(call, uri, "Nothing on this phone can open that.");
    }

    private void openView(PluginCall call, Uri uri, String failure) {
        try {
            getActivity().startActivity(new Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            call.resolve();
        } catch (RuntimeException err) {
            call.reject(failure);
        }
    }

    // { mode: "normal" | "vibrate" | "silent" } -> { mode } as set. Full silence needs Do Not Disturb access,
    // which Android grants on its own screen; without it the phone goes to vibrate.
    @PluginMethod
    public void ringer(PluginCall call) {
        String mode = call.getString("mode", "normal");
        AudioManager audio = getContext().getSystemService(AudioManager.class);
        NotificationManager notifications = getContext().getSystemService(NotificationManager.class);
        boolean mayGoSilent = Build.VERSION.SDK_INT < Build.VERSION_CODES.M || notifications.isNotificationPolicyAccessGranted();
        String applied = mode;
        try {
            if ("silent".equals(mode) && mayGoSilent) audio.setRingerMode(AudioManager.RINGER_MODE_SILENT);
            else if ("silent".equals(mode) || "vibrate".equals(mode)) {
                audio.setRingerMode(AudioManager.RINGER_MODE_VIBRATE);
                applied = "vibrate";
            } else audio.setRingerMode(AudioManager.RINGER_MODE_NORMAL);
        } catch (RuntimeException err) {
            call.reject("Android won't let LightMoon change the ringer while Do Not Disturb is on.");
            return;
        }
        JSObject result = new JSObject();
        result.put("mode", applied);
        result.put("silentNeedsAccess", "silent".equals(mode) && !mayGoSilent);
        call.resolve(result);
    }

    // Focus mode (Focus.java). { minutes, allow: "Mom, Asha", quiet } -> { until, quiet, quietNeedsAccess }: quiet is
    // whether Do Not Disturb went on, which needs the user's permission (openSilenceAccess).
    @PluginMethod
    public void focus(PluginCall call) {
        try {
            int minutes = Math.max(5, Math.min(intArg(call, "minutes", 45), 480));
            boolean wantQuiet = !Boolean.FALSE.equals(call.getBoolean("quiet", true));
            long until = System.currentTimeMillis() + minutes * 60_000L;
            boolean quiet = Focus.start(getContext(), until, call.getString("allow", ""), wantQuiet);
            JSObject result = new JSObject();
            result.put("until", until);
            result.put("quiet", quiet);
            result.put("quietNeedsAccess", wantQuiet && !quiet);
            call.resolve(result);
        } catch (RuntimeException err) {
            call.reject("Couldn't start focus mode.");
        }
    }

    // { minutes } starts driving mode for a while, { end: true } stops it, { rememberCar: true } takes the Bluetooth
    // audio connected now as their car (or { carName }; "" forgets it) -> { driving, until, car, connected }.
    @PluginMethod
    public void driving(PluginCall call) {
        try {
            Context context = getContext();
            if (Boolean.TRUE.equals(call.getBoolean("end", false))) Driving.end(context);
            Integer minutes = intArg(call, "minutes", null);
            if (minutes != null && minutes > 0) Driving.start(context, System.currentTimeMillis() + Math.min(minutes, 720) * 60_000L);
            java.util.List<String> connected = Driving.connectedAudio(context);
            String carName = call.getString("carName");
            if (carName != null) Driving.rememberCar(context, carName);
            else if (Boolean.TRUE.equals(call.getBoolean("rememberCar", false))) {
                if (connected.isEmpty()) {
                    call.reject("No Bluetooth audio is connected right now. Connect the phone to the car first.");
                    return;
                }
                Driving.rememberCar(context, connected.get(0));
            }
            JSObject result = new JSObject();
            result.put("driving", Driving.why(context));
            result.put("until", Driving.until(context));
            result.put("car", Driving.car(context));
            result.put("connected", new com.getcapacitor.JSArray(connected));
            call.resolve(result);
        } catch (RuntimeException err) {
            call.reject("Couldn't change driving mode.");
        }
    }

    // Ends focus mode now -> { summary } (null when it wasn't on).
    @PluginMethod
    public void endFocus(PluginCall call) {
        try {
            JSObject result = new JSObject();
            result.put("summary", Focus.end(getContext()));
            call.resolve(result);
        } catch (RuntimeException err) {
            call.reject("Couldn't end focus mode.");
        }
    }

    // Opens Android's screen where the user can let LightMoon fully silence the phone.
    @PluginMethod
    public void openSilenceAccess(PluginCall call) {
        try {
            getActivity().startActivity(new Intent(Settings.ACTION_NOTIFICATION_POLICY_ACCESS_SETTINGS));
            call.resolve();
        } catch (RuntimeException err) {
            call.reject("Open Settings → Notifications → Do Not Disturb → app access and allow LightMoon.");
        }
    }

    // -> { percent, charging }
    @PluginMethod
    public void battery(PluginCall call) {
        try {
            BatteryManager battery = getContext().getSystemService(BatteryManager.class);
            JSObject result = new JSObject();
            result.put("percent", battery.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY));
            result.put("charging", Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && battery.isCharging());
            call.resolve(result);
        } catch (RuntimeException err) {
            call.reject("Couldn't read the battery.");
        }
    }

    // { stream: "media" | "ring" | "alarm", percent: 0-100 }
    @PluginMethod
    public void volume(PluginCall call) {
        String stream = call.getString("stream", "media");
        int type = "ring".equals(stream) ? AudioManager.STREAM_RING : "alarm".equals(stream) ? AudioManager.STREAM_ALARM : AudioManager.STREAM_MUSIC;
        int percent = Math.max(0, Math.min(100, intArg(call, "percent", 50)));
        AudioManager audio = getContext().getSystemService(AudioManager.class);
        try {
            int level = Math.round(audio.getStreamMaxVolume(type) * percent / 100f);
            audio.setStreamVolume(type, level, AudioManager.FLAG_SHOW_UI);
            call.resolve();
        } catch (RuntimeException err) {
            call.reject("Android won't let apps change that while Do Not Disturb is on.");
        }
    }
}
