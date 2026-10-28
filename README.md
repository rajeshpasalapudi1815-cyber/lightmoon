# LightMoon: your personal AI assistant

**LightMoon: your light in every phase.** Like the moon lighting the way at night, LightMoon is a personal
assistant that helps you see the next step. It installs on your phone like an app, talks and listens, remembers you,
coaches you towards your goals, and keeps your tasks and reminders.

Everything runs on the device itself. The only thing sent over the internet is the conversation, which goes
to the AI service (Groq's free tier by default).

## Install it on your Android phone

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
cloud/                the small cloud service (Cloudflare Worker + D1 database, free plan)
  src/worker.js       stores encrypted sync data and reminder times; sends the reminder pushes
  wrangler.toml       its settings; deploy with `npx wrangler deploy` from this folder
  sw.js               lets it install, work offline and show notifications
serve.js              optional: run it on this computer at http://localhost:3000
Start LightMoon.cmd   double-click to run serve.js and open the browser
```

No build step and no packages to install. Plain HTML, CSS and JavaScript.
