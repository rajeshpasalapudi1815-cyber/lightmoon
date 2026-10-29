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
// reminder went off. Never at night, and not for a heads-up that needs no answer (the task's check_in is false).
export const CHECK_IN_MINUTES = [15, 45, 90];
const QUIET_FROM_HOUR = 23;
const QUIET_UNTIL_HOUR = 7;

export const isQuietTime = ms => {
  const hour = new Date(ms).getHours();
  return hour >= QUIET_FROM_HOUR || hour < QUIET_UNTIL_HOUR;
};

// A check-in is its own alert, for the cloud and the phone's alarms: the task's id plus "-c1", "-c2"...
export const checkInId = (taskId, n) => `${taskId}-c${n}`;

export function parseAlertId(id) {
  const match = /^([a-z0-9]+)-c(\d+)$/.exec(String(id));
  return match ? { taskId: match[1], n: Number(match[2]) } : { taskId: String(id), n: 0 };
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

// What LightMoon says when it checks in, e.g. "Sir, just checking: did you take your tablets?"
export function checkInLine(task, settings, n) {
  const who = capitalize(addressWord(settings));
  const question = task.check_in || `did you get to "${task.title}"?`;
  if (n >= CHECK_IN_MINUTES.length) return `${who}, one last check: ${question} I'll leave it with you after this.`;
  if (n === 1) return `${who}, just checking: ${question}`;
  return `${who}, checking again: ${question} Tell me when it's done, or say snooze.`;
}
