// Sleep mode ("good night, Moon", or set hours such as 23:00 to 06:30): LightMoon goes quiet. Reminders, check-ins,
// heads-ups and its own greetings are held, except the ones marked urgent or emergency, which still speak. Saying the
// wake phrase (or the sleep hours ending) wakes it, and it catches them up on everything that came in meanwhile.
// The times and the urgent list are synced settings, so every device sleeps and wakes together.
//
// settings: sleep_from / sleep_until ('HH:MM', both or neither), sleep_now (ms it was sent to sleep by voice),
// sleep_end (ms a voice sleep ends, 0 = until woken or the sleep hours end), sleep_woke (ms it was last woken),
// urgent_people (names, comma-separated).

const HELD_KEY = 'assistant.sleepHeld'; // this device: what it kept back while asleep
const MAX_HELD = 40;
const URGENT_WORDS = /\b(urgent|emergency|asap|critical)\b/i;

let settings = { get: () => '', set: () => {} };
export function useSettings(store) {
  settings = store;
}

const minutesOf = hhmm => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '').trim());
  return match && Number(match[1]) < 24 && Number(match[2]) < 60 ? Number(match[1]) * 60 + Number(match[2]) : null;
};

export const sleepHours = () => {
  const from = minutesOf(settings.get('sleep_from'));
  const until = minutesOf(settings.get('sleep_until'));
  return from == null || until == null || from === until ? null : { from: settings.get('sleep_from'), until: settings.get('sleep_until') };
};

// When the sleep hours that cover `now` started (ms), or null if `now` is outside them.
export function hoursStartedAt(now = Date.now()) {
  const hours = sleepHours();
  if (!hours) return null;
  const from = minutesOf(hours.from);
  const until = minutesOf(hours.until);
  const day = new Date(now);
  const minute = day.getHours() * 60 + day.getMinutes();
  const inside = from < until ? minute >= from && minute < until : minute >= from || minute < until;
  if (!inside) return null;
  const start = new Date(now);
  start.setHours(Math.floor(from / 60), from % 60, 0, 0);
  if (start.getTime() > now) start.setDate(start.getDate() - 1); // overnight: it started yesterday evening
  return start.getTime();
}

// When the sleep that covers `now` began (ms), or null if LightMoon is awake.
export function sleepingSince(now = Date.now()) {
  const woke = Number(settings.get('sleep_woke')) || 0;
  const said = Number(settings.get('sleep_now')) || 0;
  const end = Number(settings.get('sleep_end')) || 0;
  if (said > woke && said <= now && (!end || now < end)) return said;
  const hours = hoursStartedAt(now);
  return hours != null && hours > woke ? hours : null;
}

export const isAsleep = (now = Date.now()) => sleepingSince(now) != null;

// Sends it to sleep now, until `until` (ms), or until woken / the sleep hours end.
export function goToSleep(until = 0, now = Date.now()) {
  settings.set('sleep_now', String(now));
  settings.set('sleep_end', String(until > now ? until : 0));
}

// Wakes it. Returns when it had gone to sleep (ms), or null if it was awake.
export function wakeUp(now = Date.now()) {
  const since = sleepingSince(now);
  settings.set('sleep_woke', String(now));
  return since;
}

export function setSleepHours(from, until) {
  if (!from && !until) {
    settings.set('sleep_from', '');
    settings.set('sleep_until', '');
    return null;
  }
  if (minutesOf(from) == null || minutesOf(until) == null) throw new Error('Give both times as HH:MM, e.g. 23:00 and 06:30.');
  settings.set('sleep_from', from.padStart(5, '0'));
  settings.set('sleep_until', until.padStart(5, '0'));
  return sleepHours();
}

// ---------- Urgent ----------

const tidyName = name => String(name ?? '').trim().replace(/\s+/g, ' ').slice(0, 60);
export const urgentPeople = () => String(settings.get('urgent_people') ?? '').split(',').map(tidyName).filter(Boolean);

export function markUrgentPerson(name, on = true) {
  const who = tidyName(name);
  if (!who) throw new Error('Say who.');
  const rest = urgentPeople().filter(n => n.toLowerCase() !== who.toLowerCase());
  settings.set('urgent_people', (on ? [...rest, who] : rest).slice(0, 30).join(', '));
  return urgentPeople();
}

// Whether `who` (a caller's or sender's name) is on their urgent list: "Mom" matches "Mom", "Asha" matches "Asha Rani".
export function isUrgentPerson(who) {
  const name = String(who ?? '').toLowerCase();
  if (!name) return false;
  return urgentPeople().some(person => {
    const p = person.toLowerCase();
    return name === p || name.split(/\s+/).includes(p) || p.split(/\s+/).includes(name);
  });
}

// A reminder that wakes it: marked urgent, or with "urgent" / "emergency" in its title.
export const isUrgentTask = task => Boolean(task?.urgent) || URGENT_WORDS.test(String(task?.title ?? ''));

// ---------- What it kept back ----------

function readHeld() {
  try {
    const list = JSON.parse(localStorage.getItem(HELD_KEY) || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function hold(line, now = Date.now()) {
  const list = [...readHeld(), { at: now, line: String(line).slice(0, 240) }].slice(-MAX_HELD);
  try {
    localStorage.setItem(HELD_KEY, JSON.stringify(list));
  } catch {
    // Private browsing: the catch-up still covers calls, messages and tasks.
  }
}

// What was kept back since `since`, and forgets it all.
export function takeHeld(since = 0) {
  const list = readHeld().filter(h => h.at >= since);
  try {
    localStorage.removeItem(HELD_KEY);
  } catch {
    // Nothing to clear.
  }
  return list;
}

// "11:05 pm" for the catch-up.
const clock = ms => new Date(ms).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });

// The automatic message asking the AI for the catch-up.
export function catchUpRequest(since, held) {
  const kept = held.length ? held.map(h => `${clock(h.at)}: ${h.line}`).join(' | ') : 'nothing';
  return `(Automatic message: I just woke you from sleep mode; you were asleep since ${clock(since)}. Catch me up in under 130 words, `
    + 'spoken: anything urgent or failing soon first, then who called (say which I have already returned), messages, the mood and '
    + 'urgency of new mail, money spent, and the Life Levelling tasks due today with their times. Only what is in your context; '
    + `skip what is empty. Reminders and check-ins you held back while asleep: ${kept}. End by asking what I want to do first. Do not use tools.)`;
}
