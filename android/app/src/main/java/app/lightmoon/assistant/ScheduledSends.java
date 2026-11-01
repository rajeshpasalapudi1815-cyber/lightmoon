package app.lightmoon.assistant;

import android.app.AlarmManager;
import android.app.KeyguardManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.PowerManager;
import android.telephony.SmsManager;
import android.widget.Toast;
import androidx.core.app.NotificationCompat;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

// Messages to send later ("send a joke to my wife at 8:45 pm"), after the user said yes to them (phone.js reads each
// back, unless they asked for a joke or wish). At the time, an alarm sends it: a text straight away; on WhatsApp the
// chat opens with the message and the Send helper taps Send, while the phone is unlocked. Locked, or without the
// Send helper, a notification says it's ready and one tap opens it to send. Kept on this phone only.
public class ScheduledSends extends BroadcastReceiver {

    private static final String PREFS = "lightmoon.sends";
    private static final String ACTION = "app.lightmoon.assistant.SCHEDULED_SEND";
    private static final String OPEN = "app.lightmoon.assistant.SCHEDULED_SEND_OPEN";
    private static final String CHANNEL = "sends";
    private static final int MAX = 50;

    static final class Send {
        String id;
        long at;
        String via; // "whatsapp" or "sms"
        String number; // WhatsApp: with the country code, digits only
        String name;
        String text;

        JSONObject json() throws JSONException {
            return new JSONObject().put("id", id).put("at", at).put("via", via).put("number", number).put("name", name).put("text", text);
        }

        static Send of(JSONObject json) {
            Send send = new Send();
            send.id = json.optString("id");
            send.at = json.optLong("at");
            send.via = json.optString("via", "whatsapp");
            send.number = json.optString("number");
            send.name = json.optString("name");
            send.text = json.optString("text");
            return send;
        }
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static synchronized List<Send> all(Context context) {
        List<Send> sends = new ArrayList<>();
        try {
            JSONArray saved = new JSONArray(prefs(context).getString("sends", "[]"));
            for (int i = 0; i < saved.length(); i++) sends.add(Send.of(saved.getJSONObject(i)));
        } catch (JSONException ignored) {
            // Nothing readable: nothing waiting.
        }
        return sends;
    }

    private static synchronized void save(Context context, List<Send> sends) {
        JSONArray list = new JSONArray();
        for (Send send : sends) {
            try {
                list.put(send.json());
            } catch (JSONException ignored) {
                // Skipped.
            }
        }
        prefs(context).edit().putString("sends", list.toString()).apply();
    }

    static synchronized Send add(Context context, long at, String via, String number, String name, String text) {
        List<Send> sends = all(context);
        if (sends.size() >= MAX) return null;
        Send send = new Send();
        send.id = UUID.randomUUID().toString().substring(0, 8);
        send.at = at;
        send.via = "sms".equals(via) ? "sms" : "whatsapp";
        send.number = number;
        send.name = name;
        send.text = text;
        sends.add(send);
        save(context, sends);
        setAlarm(context, send);
        return send;
    }

    static synchronized boolean cancel(Context context, String id) {
        List<Send> sends = all(context);
        boolean removed = sends.removeIf(s -> s.id.equals(id));
        if (removed) {
            save(context, sends);
            context.getSystemService(AlarmManager.class).cancel(alarmIntent(context, id));
        }
        return removed;
    }

    private static synchronized Send take(Context context, String id) {
        List<Send> sends = all(context);
        for (Send send : sends) {
            if (send.id.equals(id)) {
                sends.remove(send);
                save(context, sends);
                return send;
            }
        }
        return null;
    }

    // After a restart or an update: every alarm again (one missed while the phone was off goes now).
    static void rescheduleAll(Context context) {
        for (Send send : all(context)) setAlarm(context, send);
    }

    private static void setAlarm(Context context, Send send) {
        AlarmManager alarms = context.getSystemService(AlarmManager.class);
        long at = Math.max(send.at, System.currentTimeMillis() + 1000);
        PendingIntent operation = alarmIntent(context, send.id);
        if (ReminderStore.canUseExactAlarms(context)) {
            PendingIntent show = PendingIntent.getActivity(context, 0, new Intent(context, MainActivity.class), PendingIntent.FLAG_IMMUTABLE);
            alarms.setAlarmClock(new AlarmManager.AlarmClockInfo(at, show), operation);
        } else {
            alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, operation);
        }
    }

    private static PendingIntent alarmIntent(Context context, String id) {
        Intent intent = new Intent(context, ScheduledSends.class).setAction(ACTION).setData(Uri.parse("lightmoon://send/" + Uri.encode(id))).putExtra("id", id);
        return PendingIntent.getBroadcast(context, 0, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        String id = intent.getStringExtra("id");
        if (id == null) return;
        if (OPEN.equals(intent.getAction())) {
            // Tapped on the "ready to send" notification: the phone is unlocked now.
            Send send = Send.of(new JSONObject());
            send.id = id;
            send.via = "whatsapp";
            send.number = intent.getStringExtra("number");
            send.name = intent.getStringExtra("name");
            send.text = intent.getStringExtra("text");
            context.getSystemService(NotificationManager.class).cancel(id.hashCode());
            openWhatsApp(context, send);
            return;
        }
        Send send = take(context, id);
        if (send == null) return;
        if ("sms".equals(send.via)) {
            sendText(context, send);
            return;
        }
        boolean unlocked = !context.getSystemService(KeyguardManager.class).isKeyguardLocked()
            && context.getSystemService(PowerManager.class).isInteractive();
        if (unlocked && SendHelper.isEnabled(context)) {
            openWhatsApp(context, send);
            return;
        }
        // Locked (or no Send helper): WhatsApp can't be opened behind the lock screen. Their chat's notification can
        // still be answered, if one is showing; else it goes as a text, so the moment isn't missed.
        String saved = Contacts.nameFor(context, "+" + send.number);
        if (MessageListener.replyToChat(context, saved != null ? saved : send.name, send.text)) {
            notify(context, send, "Sent to " + send.name + " on WhatsApp", send.text, null);
            return;
        }
        if (android.content.pm.PackageManager.PERMISSION_GRANTED == context.checkSelfPermission(android.Manifest.permission.SEND_SMS)) {
            send.number = "+" + send.number;
            sendText(context, send);
            return;
        }
        ready(context, send, unlocked ? "Tap to open it in WhatsApp, then tap Send." : "Unlock and tap to send it.");
    }

    private static void sendText(Context context, Send send) {
        try {
            SmsManager sms = context.getSystemService(SmsManager.class);
            ArrayList<String> parts = sms.divideMessage(send.text);
            sms.sendMultipartTextMessage(send.number, null, parts, null, null);
            notify(context, send, "whatsapp".equals(send.via) ? "Texted " + send.name + " (the phone was locked, so as an SMS)" : "Texted " + send.name, send.text, null);
        } catch (RuntimeException err) {
            notify(context, send, "Couldn't text " + send.name, "The text you scheduled didn't go: " + send.text, null);
        }
    }

    private static void openWhatsApp(Context context, Send send) {
        Uri chat = Uri.parse("https://wa.me/" + send.number + "?text=" + Uri.encode(send.text));
        Intent open = new Intent(Intent.ACTION_VIEW, chat).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        for (String app : new String[] { "com.whatsapp", "com.whatsapp.w4b" }) {
            if (context.getPackageManager().getLaunchIntentForPackage(app) != null) {
                open.setPackage(app);
                break;
            }
        }
        try {
            context.startActivity(open);
            if (SendHelper.isEnabled(context)) SendHelper.arm(Arrays.asList("com.whatsapp", "com.whatsapp.w4b"), send.text, "");
            else Toast.makeText(context, "LightMoon: your scheduled message is typed in. Tap Send.", Toast.LENGTH_LONG).show();
        } catch (RuntimeException err) {
            ready(context, send, "Tap to open it in WhatsApp.");
        }
    }

    // A notification for a message that couldn't go by itself: one tap opens it to send.
    private static void ready(Context context, Send send, String how) {
        Intent tap = new Intent(context, ScheduledSends.class).setAction(OPEN).setData(Uri.parse("lightmoon://send-open/" + Uri.encode(send.id)))
            .putExtra("id", send.id).putExtra("number", send.number).putExtra("name", send.name).putExtra("text", send.text);
        PendingIntent open = PendingIntent.getBroadcast(context, 1, tap, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        notify(context, send, "Message for " + send.name + " is ready", how + " \"" + send.text + "\"", open);
    }

    private static void notify(Context context, Send send, String title, String text, PendingIntent tap) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel(CHANNEL, "Scheduled messages", NotificationManager.IMPORTANCE_HIGH));
        NotificationCompat.Builder builder = new NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_moon)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
            .setAutoCancel(true)
            .setVisibility(Notification.VISIBILITY_PRIVATE);
        if (tap != null) builder.setContentIntent(tap);
        manager.notify(send.id.hashCode(), builder.build());
    }
}
