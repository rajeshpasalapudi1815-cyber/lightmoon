package app.lightmoon.assistant;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import androidx.core.content.ContextCompat;

// A meeting is coming up: say it (or, if LightMoon is on screen, let the app say it in the conversation).
public class MeetingReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        String id = intent.getStringExtra("id");
        String say = id == null ? null : Meetings.sayFor(context, id);
        if (say == null) return;
        if (MainActivity.visible && PhonePlugin.tellApp("meetingDue", say)) return;
        Intent speak = new Intent(context, SpeakService.class).putExtra("say", say).putExtra("title", "Meeting").putExtra("sayId", "meeting-" + id);
        try {
            ContextCompat.startForegroundService(context, speak);
        } catch (IllegalStateException err) {
            // Android refused the speaking service from the background: say it directly instead.
            PendingResult pending = goAsync();
            Voice.say(context, say, pending::finish);
        }
    }
}
