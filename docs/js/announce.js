// The words LightMoon says when a reminder goes off, e.g. "Boss, you have a meeting at 5 o'clock.", and when it
// checks in afterwards. Shared by the app and the service worker (which can't use the app's storage module).
// The Android app has the same rules and words in SyncWorker.java: change both together.

// How the user likes to be addressed: "sir", "ma'am", "boss", or their name. `settings` uses the stored keys.
export function addressWord(settings = {}) {
  const address = settings.address || 'sir';
  return address === 'name' ? settings.user_name || 'friend' : address;
}

const capitalize = text => text.charAt(0).toUpperCase() + text.slice(1);

// The sentence the AI wrote when the reminder was set, or a plain one if it didn't write one.
export function reminderLine(task, settings) {
  return task.announce || `${capitalize(addressWord(settings))}, it's time: ${task.title}.`;
}

// ---------- Checking in after a reminder ----------
// Until they say it's done (or "not now", or "stop asking"), LightMoon asks again this many minutes after the
// reminder went off: soon, then every few hours, the last a day later. Never at night (those are skipped), and not
// for a heads-up that needs no answer (the task's check_in is false).
export const CHECK_IN_MINUTES = [15, 45, 90, 180, 300, 480, 720, 1440];
const QUIET_FROM_HOUR = 23;
const QUIET_UNTIL_HOUR = 7;

export const isQuietTime = ms => {
  const hour = new Date(ms).getHours();
  return hour >= QUIET_FROM_HOUR || hour < QUIET_UNTIL_HOUR;
};

// A check-in is its own alert, for the cloud and the phone's alarms: the task's id plus "-c1", "-c2"...
// A heads-up before the reminder is the task's id plus "-h30" (30 minutes before).
export const checkInId = (taskId, n) => `${taskId}-c${n}`;
export const headsUpId = (taskId, minutes) => `${taskId}-h${minutes}`;

// -> { taskId, n } (n: the check-in, 0 for the reminder itself), plus headsUp (minutes) for a heads-up.
export function parseAlertId(id) {
  const match = /^([a-z0-9]+)-([ch])(\d+)$/.exec(String(id));
  if (!match) return { taskId: String(id), n: 0 };
  return match[2] === 'c' ? { taskId: match[1], n: Number(match[3]) } : { taskId: match[1], n: 0, headsUp: Number(match[3]) };
}

// ---------- Heads-ups before a reminder ----------
// A task can ask for heads-ups some minutes before its reminder (heads_up: [30, 10]): "in 30 minutes: shopping".
// Not between 11 pm and 6 am (a 5 am wake-up rings at 5, not at 4:30). The Android app has the same rules and
// words in SyncWorker.java: change both together.
const HEADS_UP_QUIET_FROM = 23;
const HEADS_UP_QUIET_UNTIL = 6;
const quietForHeadsUp = ms => {
  const hour = new Date(ms).getHours();
  return hour >= HEADS_UP_QUIET_FROM || hour < HEADS_UP_QUIET_UNTIL;
};

// The minutes asked for: whole numbers from 5 to 240, at most three, largest first.
export const headsUpMinutes = value => [...new Set((Array.isArray(value) ? value : []).map(Number)
  .filter(m => Number.isInteger(m) && m >= 5 && m <= 240))].sort((a, b) => b - a).slice(0, 3);

// The heads-ups still to come for a task's reminder: [{ id, minutes, at }].
export function headsUpsOf(task) {
  if (!task?.remind_at || task.done || task.deleted) return [];
  const rings = Date.parse(task.remind_at);
  if (!Number.isFinite(rings)) return [];
  const said = new Set(task.heads_up_said ?? []);
  return headsUpMinutes(task.heads_up).filter(m => !said.has(m))
    .map(m => ({ id: headsUpId(task.id, m), minutes: m, at: rings - m * 60_000 }))
    .filter(h => !quietForHeadsUp(h.at));
}

// "7 pm", "7:30 am" from "YYYY-MM-DDTHH:MM".
export function spokenClock(stamp) {
  const [h, m] = String(stamp).slice(11, 16).split(':').map(Number);
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'am' : 'pm'}`;
}

// "Sir, heads up: shopping in 30 minutes, at 7 pm."
export function headsUpLine(task, settings, minutes) {
  return `${capitalize(addressWord(settings))}, heads up: ${task.title} in ${minutes} minutes, at ${spokenClock(task.remind_at)}.`;
}

export const checksIn = (task, settings = {}) =>
  Boolean(task.remind_at) && !task.done && !task.deleted && !task.answered && task.check_in !== false
  && settings.reminder_checks !== 'off';

// The check-ins still to come for a task's reminder (whether or not it has gone off yet): [{ id, n, at }].
export function checkInsOf(task, settings = {}) {
  if (!checksIn(task, settings)) return [];
  const rang = Date.parse(task.remind_at); // local time, "YYYY-MM-DDTHH:MM"
  if (!Number.isFinite(rang)) return [];
  return CHECK_IN_MINUTES.map((minutes, i) => ({ id: checkInId(task.id, i + 1), n: i + 1, at: rang + minutes * 60_000 }))
    .filter(check => check.n > (task.checked_in ?? 0) && !isQuietTime(check.at));
}

// How LightMoon holds them to things (Settings → Reminders → How I push you; synced): "gentle", "firm" or "strict".
export const coachStyle = (settings = {}) => (['gentle', 'strict'].includes(settings.coach_style) ? settings.coach_style : 'firm');

// What LightMoon says when it checks in, e.g. "Sir, did you do it? Did you take your tablets?"
export function checkInLine(task, settings, n) {
  const who = capitalize(addressWord(settings));
  const question = task.check_in || `did you get to "${task.title}"?`;
  const last = n >= CHECK_IN_MINUTES.length;
  const late = n >= 4; // hours have gone by
  switch (coachStyle(settings)) {
    case 'gentle':
      if (last) return `${who}, one last check: ${question} I'll leave it with you after this.`;
      if (n === 1) return `${who}, just checking: ${question}`;
      return `${who}, checking again: ${question} Tell me when it's done, or say snooze.`;
    case 'strict':
      if (last) return `${who}, a whole day and still nothing. ${question} Do it now, or tell me you're dropping it.`;
      if (late) return `${who}, this is still not done. ${question} No more putting it off. Do it now.`;
      if (n === 1) return `${who}. ${question} I want an answer.`;
      return `${who}, I'm still waiting. ${question} Done, or not done?`;
    default:
      if (last) return `${who}, it's been a day. ${question} Do it today, give it a new time, or drop it. I won't let it sit.`;
      if (late) return `${who}, this is still open. ${question} Do it now, or tell me exactly when.`;
      if (n === 1) return `${who}, time's up: ${question}`;
      return `${who}, checking again: ${question} It's not done until you tell me it is.`;
  }
}
