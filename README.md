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
| Talk | Tap the glowing core or the mic button (on a computer, Space also works) |
| Hands-free | Turn on **Wake word**, then say "LightMoon, what's on my list today?" Best on a computer; on phones it uses more battery |
| Stop it talking | Tap the core (or press Esc) |
| Type | Use the box at the bottom |

Things to try:
- "Remind me to call Mom at 6 pm."
- "I want to run 5 km by December, because I want more energy."
- "I ran 2 km this morning." (logs progress on your goal)
- "Remember that I work best in the mornings."
- "I finished the slides." (ticks off the task)
- "What should I focus on today?"

## Good to know

- **Reminders** go off while LightMoon is open. Missed ones are announced the next time you open it.
  For reminders that must reach you even when LightMoon is closed, tap **Add to Google Calendar** under the reminder.
- **Your data stays on the device.** Your phone and your computer each keep their own copy.
  Use **Settings → Download backup** now and then, and **Restore backup** to move your data to another device.
  Backups never include your API key.
- **Switching the AI:** Settings → *AI brain (advanced)*. Any OpenAI-compatible service works.
  Leave the defaults to use Groq's free tier, with an automatic backup model when the free limit is hit.
- **Renaming:** Settings → *Assistant name*. The new name also becomes the wake word.

## What it's made of

```
docs/                 the app (GitHub Pages publishes this folder)
  index.html          the HUD interface
  app.js              voice in/out, chat, panels, reminders, settings
  js/brain.js         talks to the AI model and runs its tools
  js/prompt.js        LightMoon's personality + what it knows about you
  js/tools.js         remember, tasks, reminders, goals, progress
  js/store.js         on-device storage, backup and restore
  sw.js               lets it install, work offline and show notifications
serve.js              optional: run it on this computer at http://localhost:3000
Start LightMoon.cmd   double-click to run serve.js and open the browser
```

No build step and no packages to install. Plain HTML, CSS and JavaScript.
