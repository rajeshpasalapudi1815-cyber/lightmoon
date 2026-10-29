# LightMoon: your personal AI assistant

**LightMoon: your light in every phase.** Like the moon lighting the way at night, LightMoon is a personal
assistant that helps you see the next step. It installs on your phone like an app, talks and listens, remembers you,
coaches you towards your goals, and keeps your tasks and reminders.

Everything runs on the device itself. The only thing sent over the internet is the conversation, which goes
to the AI service (Groq's free tier by default).

## Install the Android app (recommended)

The Android app speaks your reminders out loud at the right time, even when LightMoon is closed, the screen is off
or the phone has restarted. It is the same LightMoon (it loads the live app, so updates arrive by themselves), plus
the phone's own alarms and voice.

1. On the phone, open https://github.com/rajeshpasalapudi1815-cyber/lightmoon/releases/latest and tap **LightMoon.apk**.
2. When Chrome asks, allow it to install apps (**Settings → Allow from this source**), then tap **Install**.
   Android may warn that the app is from an unknown developer: that's because it isn't from the Play Store.
3. Open LightMoon, enter your name and Groq API key, and allow notifications and the microphone.
4. In **Settings → Spoken reminders**, tap **Let it run in the background** (some phones otherwise stop it to save
   battery), then **Test in 1 minute** and lock the phone: you should hear it.

The app keeps its own data, separate from the Chrome version. To bring your memories and tasks across, use
**Settings → Sync between devices** with the same code.

Only in the Android app:
- **Wake word:** Settings → *Wake word* → *Turn on* (downloads a 41 MB offline voice model once), then
  *Allow LightMoon to open itself*. With the app closed, say "LightMoon", wait for the chime, and speak. It listens
  only for its name, on the phone. On a locked phone it asks for your fingerprint first. After a restart, open
  LightMoon once to switch it back on (Android doesn't let it start listening by itself).
- **Fingerprint unlock:** Settings → *App lock* → *Add fingerprint* uses Android's own fingerprint or face prompt.
- **Your phone:** Settings → *Phone*, allow what you want: *calendar* (it says each meeting out loud a few minutes
  before, even when closed, and can add meetings), *calls* (says who's calling, calls people, knows missed calls),
  *texts* (sends SMS) and *reading messages* (Android's notification access: it notices new WhatsApp, SMS, Telegram
  and Signal messages, says who they're from or reads them out, and replies in the chat). It also opens apps, sets
  alarms and timers, and works the flashlight and volume. Before calling or sending anything it reads back who and
  what and waits for your yes. Calls and messages are spoken only when the phone isn't on silent; one-time codes are
  never read out or sent to the AI.

## Life Levelling

LightMoon can connect to [Life Levelling](https://github.com/rajeshpasalapudi1815-cyber/life-levelling), the
game-style growth app. In LightMoon turn on **Sync between devices** and copy the code; in Life Levelling open
**Settings → LightMoon assistant** and paste it. From then on LightMoon knows your level, quests, today's plan,
readiness, health, money and the Mirror's patterns, coaches from them, and can log water, sleep, mood, exercise,
spending, tasks and your morning intention there ("I drank two glasses", "I finished the report"). It can also
change your Life Levelling tasks: rename, reschedule, re-prioritise, start, pause, reopen or delete them.
Life Levelling sends its summary through LightMoon's cloud every few minutes, encrypted with the sync code,
and applies LightMoon's requests within a minute (its phone app: when it's open).

It works the other way too: Life Levelling shows LightMoon's to-dos and reminders on its Tasks page and can add,
tick off or delete them, and any task there can get a LightMoon reminder ("Ring with LightMoon" in its details).
It changes LightMoon's synced copy the way another LightMoon device would, so the Android app rings those
reminders even when it's closed (it checks the copy every 15 minutes).

## Or install it from Chrome

1. Open the LightMoon link in **Chrome** on your phone.
2. Tap the **⋮** menu, then **Add to Home screen** (or **Install app**), then **Install**. LightMoon now has its own icon and opens full-screen.
3. Open LightMoon, enter your name, and paste a free Groq API key. To get one on the phone, open
   https://console.groq.com/keys, sign in, tap **Create API Key**, and copy it.
4. Tap **Initialize**, and allow the microphone and notifications when asked.

## Talking to LightMoon

| Action | How |
|---|---|
| Talk | Tap the glowing core or the mic button (on a computer, Space also works). It sends once you pause for 2.5 seconds, or tap the core again to send right away. Change the pause in Settings |
| Open by voice | Say **"Hey Google, open LightMoon"**. With *Start listening when the app opens* on (the default), it greets you and starts listening |
| Hands-free | Turn on **Wake word**, then say "LightMoon, what's on my list today?" Best on a computer; on phones it uses more battery |
| Stop it talking | Tap the core (or press Esc) |
| Type | Use the box at the bottom |

LightMoon starts speaking as soon as the first sentence of its reply arrives, so answers feel quick.

**Shortcuts:** long-press the LightMoon icon for **Talk now**, **Add task** or **Briefing**.

**Share to LightMoon:** in any app (Chrome, WhatsApp, Gmail…) tap **Share → LightMoon**, then choose
**Remember this**, **Make it a task**, **Summarize** or **Ask about it**. (If the shortcuts or the Share option
don't appear, remove LightMoon from your home screen and install it again.)

Things to try:
- "Remind me to call Mom at 6 pm."
- "Will it rain today?" or "Set my weather city to Hyderabad."
- "I want to run 5 km by December, because I want more energy."
- "I ran 2 km this morning." (logs progress on your goal)
- "Remember that I work best in the mornings."
- "I finished the slides." (ticks off the task)
- "What should I focus on today?"

## Good to know

- **Reminders:** turn on **Settings → Reminder notifications** and reminders pop up on that device at the right
  time, even when LightMoon is closed. The LightMoon cloud only learns *when* each reminder is due; the text stays
  on your devices. (Without notifications, reminders go off while the app is open, and missed ones are announced
  the next time you open it.)
- **Spoken reminders:** when you set one ("remind me at 4:55 that I have a meeting at 5"), LightMoon writes what it
  will say: "Boss, you have a meeting at 5 o'clock." The Android app says it at that moment whether it's open or
  not, at alarm volume. In the browser version it's said if the app is open; if it's closed, the notification shows
  it and tapping it (or **Hear it**) opens LightMoon to say it, because phones don't let a closed web app speak by
  itself. With the app lock on, notifications just say "You have a reminder".
- **Sync between devices:** **Settings → Start syncing** on one device shows a sync code. On the other, choose
  **I have a code** and type it in. Memories, tasks, goals and chats are then combined and kept in step.
  Everything is encrypted on the device with that code before upload, so keep the code private. Your API key, PIN
  and voice settings stay on each device.
- **Backups:** **Settings → Download backup** saves everything to a file; **Restore backup** brings it back.
  Backups never include your API key.
- **Switching the AI:** Settings → *AI brain (advanced)*. Any OpenAI-compatible service works.
  Leave the defaults to use Groq's free tier, with an automatic backup model when the free limit is hit.
- **Renaming:** Settings → *Assistant name*. The new name also becomes the wake word.
- **Weather:** Settings → *Weather in briefings*: type your city or tap *Use my location*. Forecasts come from
  Open-Meteo (free, no key); only the city's rough location is sent.
- **App lock:** Settings → *App lock* → *Turn on* sets a PIN; on phones you can then *Add fingerprint*.
  LightMoon asks again after 3 minutes in the background. It keeps other people out of the app, but it doesn't
  encrypt the data. If you forget the PIN, the only way back in is to erase LightMoon on that device (then restore a backup).

## What it's made of

```
docs/                 the app (GitHub Pages publishes this folder)
  index.html          the HUD interface
  app.js              voice in/out, chat, panels, reminders, settings
  js/brain.js         talks to the AI model and runs its tools
  js/prompt.js        LightMoon's personality + what it knows about you
  js/tools.js         remember, tasks, reminders, goals, progress
  js/store.js         on-device storage, backup and restore
  js/weather.js       today's weather from Open-Meteo
  js/lock.js          PIN and fingerprint app lock
  js/cloud.js         reminder notifications and encrypted sync
  js/vault.js         sync codes and encryption
  js/notifier.js      what the service worker shows when a reminder is due
  js/native.js        in the Android app: the phone's voice, listening and alarms
  js/lifelevelling.js the Life Levelling link: its summary for the AI, and requests back to it
  js/phone.js         in the Android app: what the AI knows of the phone and its phone tools (asks before calls and sends)
  sw.js               lets it install, work offline and show notifications
cloud/                the small cloud service (Cloudflare Worker + D1 database, free plan)
  src/worker.js       stores encrypted sync data and reminder times; sends the reminder pushes
  wrangler.toml       its settings; deploy with `npx wrangler deploy` from this folder
android/              the Android app (Capacitor), which opens the live web app
  app/src/main/java/app/lightmoon/assistant/
    ReminderAlarmsPlugin.java   what the web app calls to set the phone's alarms
    ReminderStore.java          the upcoming reminders and their alarms
    SpeakService.java           says a reminder out loud when its alarm goes off
    SyncWorker.java             every 15 minutes, picks up reminders set on other devices
    CloudCrypto.java            reads the encrypted sync copy, exactly as js/vault.js writes it
    WakeWordService.java        listens for "LightMoon" on the phone (Vosk) and opens the app
    WakeWordPlugin.java         turns the wake word on and off, downloads its voice model
    UnlockActivity.java         on a locked phone, asks for the fingerprint before opening
    DeviceUnlockPlugin.java     Android's fingerprint / face prompt for the app lock
    PhonePlugin.java            the phone for the web app: calendar, calls, texts, chat replies, apps, alarms, flashlight
    Meetings.java               reads and adds calendar events; alarms that say meetings before they start
    MeetingReceiver.java        says a meeting when its alarm goes off; MeetingWorker.java refreshes them every 15 min
    CallReceiver.java           says who's calling
    MessageListener.java        notices new chat messages (notification access), says them, replies through them
    Contacts.java, Voice.java   contact lookup; a short spoken line; PhonePrefs.java holds the Phone settings
scripts/android.mjs   `node scripts/android.mjs setup` once, then `node scripts/android.mjs build` for dist/LightMoon.apk
serve.js              optional: run it on this computer at http://localhost:3000
Start LightMoon.cmd   double-click to run serve.js and open the browser
```

The web app has no build step: plain HTML, CSS and JavaScript. Only the Android app needs building
(Java 21 and the Android SDK; the setup script installs the SDK).
