// The rhythm learner: LightMoon learns from how reminders actually go (done early, done how long after they
// rang, snoozed, "stop asking", left unanswered) and turns that into a few plain sentences: a better time for
// something you always do late, a reminder you keep snoozing, the hours you get things done fastest. It's
// learned on the device from the user's own answers, and the AI uses it to suggest, never to change things alone.

const STOP_WORDS = new Set(['my', 'the', 'a', 'an', 'to', 'at', 'for', 'and', 'of', 'on', 'in', 'pm', 'am', 'today', 'tomorrow', 'tonight', 'please', 'remind', 'me']);
const MIN_CASES = 3; // what LightMoon needs to see before it says anything about a kind of reminder
const QUICK_MINUTES = 15;
const UNANSWERED_AFTER_MS = 12 * 3600_000;
const LOOK_BACK_MS = 60 * 86_400_000;

// Reminders about the same thing share a kind: "Take tablets", "take my tablets at 9" → "take tablets".
export function kindOf(title) {
  const words = String(title ?? '').toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(w => w && !STOP_WORDS.has(w));
  return words.slice(0, 3).join(' ') || 'other';
}

const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
};
const hourName = hour => `${hour % 12 || 12} ${hour < 12 ? 'am' : 'pm'}`;

// Reminders that rang and were never answered (no done, snooze or "stop asking" within 12 hours), as outcomes.
function unanswered(tasks, now) {
  return tasks
    .filter(t => t.reminded && !t.done && !t.answered && t.remind_at && !t.deleted)
    .map(t => ({ t, rang: Date.parse(t.remind_at) }))
    .filter(({ rang }) => Number.isFinite(rang) && now - rang > UNANSWERED_AFTER_MS && now - rang < LOOK_BACK_MS)
    .map(({ t, rang }) => ({ title: t.title, kind: kindOf(t.title), outcome: 'unanswered', hour: new Date(rang).getHours() }));
}

// What LightMoon has learned: { insights: [sentence], kinds: [...] }. `outcomes` are the store's records.
export function learnRhythm(outcomes, tasks = [], now = Date.now()) {
  const recent = outcomes.filter(o => !o.deleted && o.kind && (!o.updated_at || now - o.updated_at < LOOK_BACK_MS));
  const all = [...recent, ...unanswered(tasks, now)];
  const byKind = new Map();
  for (const o of all) {
    if (!byKind.has(o.kind)) byKind.set(o.kind, []);
    byKind.get(o.kind).push(o);
  }

  const insights = [];
  const kinds = [];
  for (const [kind, list] of byKind) {
    if (list.length < MIN_CASES) continue;
    const title = list.at(-1).title ?? kind;
    const done = list.filter(o => o.outcome === 'done');
    const early = list.filter(o => o.outcome === 'early').length;
    const snoozed = list.filter(o => o.outcome === 'snoozed').length;
    const ignored = list.filter(o => o.outcome === 'unanswered' || o.outcome === 'stopped').length;
    const delay = done.length >= MIN_CASES ? median(done.map(o => o.minutes)) : null;
    kinds.push({ kind, title, count: list.length, done: done.length, early, snoozed, ignored, delay });
    if (delay !== null && delay >= 20) {
      insights.push(`"${title}": usually done about ${delay} minutes after the reminder (${done.length} times). A reminder ${delay} minutes later may suit better.`);
    } else if (snoozed * 2 >= list.length) {
      insights.push(`"${title}": snoozed ${snoozed} of the last ${list.length} times. The time it's set for may not suit.`);
    } else if (ignored * 2 >= list.length) {
      insights.push(`"${title}": left unanswered or stopped ${ignored} of ${list.length} times. Worth asking whether it still matters, or finding a better moment.`);
    } else if (early * 2 >= list.length) {
      insights.push(`"${title}": often done before the reminder even rings (${early} of ${list.length}). An earlier reminder, or none, may be enough.`);
    } else if (delay !== null && delay <= 5 && done.length >= list.length - 1) {
      insights.push(`"${title}": reliably done within ${Math.max(delay, 1)} minutes of the reminder.`);
    }
  }

  // When reminders get done fastest and slowest, by hour of day (only hours with enough reminders).
  const byHour = new Map();
  for (const o of all.filter(x => Number.isInteger(x.hour))) {
    const slot = byHour.get(o.hour) ?? { quick: 0, total: 0 };
    slot.total += 1;
    if ((o.outcome === 'done' && o.minutes <= QUICK_MINUTES) || o.outcome === 'early') slot.quick += 1;
    byHour.set(o.hour, slot);
  }
  const hours = [...byHour].filter(([, s]) => s.total >= MIN_CASES).map(([hour, s]) => ({ hour, rate: s.quick / s.total }));
  if (hours.length >= 2) {
    hours.sort((a, b) => b.rate - a.rate);
    const best = hours[0];
    const worst = hours.at(-1);
    if (best.rate - worst.rate >= 0.3) {
      insights.push(`Reminders get done fastest around ${hourName(best.hour)} (${Math.round(best.rate * 100)}% within ${QUICK_MINUTES} minutes) and slowest around ${hourName(worst.hour)} (${Math.round(worst.rate * 100)}%): demanding things fit the fast hours.`);
    }
  }
  return { insights: insights.slice(0, 6), kinds };
}
