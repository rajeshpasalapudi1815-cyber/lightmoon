// Life Levelling link. Life Levelling is the user's game-style growth app (level, quests, plan, health,
// money, the Mirror), running on their computer or as its own phone app. When they connect it (Life
// Levelling → Settings → LightMoon, with this device's sync code), it leaves an encrypted summary of their
// day in LightMoon's cloud every few minutes and applies the requests LightMoon leaves there: log water,
// tick off a task... So LightMoon can coach from their real numbers and act on them from anywhere.
// The phone app only does this while it is open (the summary says runsOn: 'phone').
import { readFeed, sendRequest, syncCode } from './cloud.js';
import { localStamp } from './time.js';

const APP = 'lifelevelling';
const KEY = 'assistant.lifelevelling'; // this device only; always re-read from the cloud
const REFRESH_AFTER_MS = 2 * 60_000;
const STALE_AFTER_MS = 36 * 3_600_000; // not heard from in a long while: don't coach from it
const FETCH_TIMEOUT_MS = 4000;

let state = load();

function load() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || 'null');
  } catch {
    return null;
  }
}

function save(next) {
  state = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Private browsing: kept for this visit only.
  }
}

// The latest summary, if Life Levelling is connected and has reported reasonably recently.
export function summary() {
  const latest = state?.summary;
  if (!syncCode() || !latest || latest.disconnected) return null;
  return Date.now() - latest.generatedAt < STALE_AFTER_MS ? latest : null;
}

export const isConnected = () => Boolean(summary());

const onPhone = (latest = state?.summary) => latest?.runsOn === 'phone';

// Fetches a fresh summary (at most every couple of minutes, and never holding a reply up for long).
export async function refresh({ force = false } = {}) {
  if (!syncCode()) return null;
  if (!force && state?.fetchedAt && Date.now() - state.fetchedAt < REFRESH_AFTER_MS) return summary();
  try {
    const feed = await Promise.race([
      readFeed(APP),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), FETCH_TIMEOUT_MS)),
    ]);
    save({ summary: feed, fetchedAt: Date.now() });
  } catch {
    // Offline or slow: keep using the last summary.
  }
  return summary();
}

// For Settings: "Connected, updated 4 min ago".
export function describe() {
  const latest = state?.summary;
  if (!syncCode()) return 'Turn on sync first, then connect it in Life Levelling → Settings → LightMoon with this code.';
  if (!latest) return 'Not connected. In Life Levelling: Settings → LightMoon assistant, paste this sync code.';
  if (latest.disconnected) return 'Disconnected in Life Levelling.';
  const minutes = Math.round((Date.now() - latest.generatedAt) / 60_000);
  const age = minutes < 1 ? 'just now' : minutes < 120 ? `${minutes} min ago` : `${Math.round(minutes / 60)} hours ago`;
  const tooOld = onPhone(latest) ? ' (too old to use; open Life Levelling to refresh it)' : ' (too old to use; is the computer on?)';
  return `Connected${latest.you?.name ? ` as ${latest.you.name}` : ''}, updated ${age}${summary() ? '' : tooOld}.`;
}

// Life Levelling task ids are long; the model sees short references (L1, L2...) instead.
function taskRefs(latest = summary()) {
  if (!latest) return [];
  const seen = new Set();
  const done = (latest.doneToday ?? []).map(t => ({ ...t, doneToday: true }));
  const list = [...(latest.plan?.today ?? []), ...(latest.tasks ?? []), ...done].filter(t => t?.id && !seen.has(t.id) && seen.add(t.id));
  return list.map((task, index) => ({ ...task, ref: `L${index + 1}` }));
}

// "(done)", "(3/8 cups)", "(not yet)" for a habit in the summary.
function habitProgress(h) {
  if (h.status === 'done') return '(done)';
  if (h.status === 'over') return '(over the limit)';
  if (h.kind !== 'check' && h.goal) return `(${h.total}/${h.goal}${h.unit ? ` ${h.unit}` : ''})`;
  return h.total ? `(${h.total}${h.unit ? ` ${h.unit}` : ''})` : '(not yet)';
}

// ---------- What the model is told ----------

const PRIORITY = { 1: 'urgent', 2: 'high', 3: 'medium', 4: 'low', 5: 'minimal' };
const join = (parts, separator = '; ') => parts.filter(Boolean).join(separator);
const ago = ms => {
  const minutes = Math.round((Date.now() - ms) / 60_000);
  return minutes < 1 ? 'just now' : minutes < 120 ? `${minutes} min ago` : `${Math.round(minutes / 60)} hours ago`;
};

export function promptSection() {
  const s = summary();
  if (!s) return '';
  const refs = taskRefs(s);
  const refOf = id => refs.find(t => t.id === id)?.ref;
  const planIds = new Set((s.plan?.today ?? []).map(t => t.id));
  const taskLine = t => join([
    `[${refOf(t.id)}] ${t.title}`, PRIORITY[t.priority], t.status === 'in_progress' && 'started', t.due && `due ${t.due}`, t.reason, t.notes && `notes: ${t.notes}`,
  ], ' | ');
  const you = s.you ?? {};
  const h = s.health;
  const lines = [
    join([
      you.level != null && `Level ${you.level}${you.title ? ` "${you.title}"` : ''}`,
      you.xp != null && `${you.xp} XP`,
      you.gold != null && `${you.gold} gold`,
      you.streak != null && `streak ${you.streak} days (best ${you.longestStreak ?? '?'})`,
      you.weakness && `weakness: ${you.weakness}`,
    ], ' · '),
    s.readiness?.score != null && `Readiness ${s.readiness.score} (${s.readiness.band}): ${join(s.readiness.advice ?? [])}`,
    s.balance && `Life balance (7 days) ${s.balance.overall}/100, weakest ${s.balance.weakest}, strongest ${s.balance.strongest}. ${s.balance.message ?? ''}`,
    s.attributes?.length && `Stats: ${s.attributes.map(a => `${a.label} ${a.level}${a.trend ? ` (${a.trend})` : ''}`).join(', ')}`,
    s.plan && `Today's plan (they usually finish about ${s.plan.capacity}${s.plan.overloaded ? ', list is overloaded' : ''}): ${join(s.plan.message ?? [], ' ')}`,
    ...(s.plan?.today ?? []).map(t => `  ${taskLine(t)}`),
    s.plan?.stuck?.length && `Stuck: ${s.plan.stuck.map(t => `[${refOf(t.id)}] ${t.title} (${t.advice})`).join('; ')}`,
    refs.some(t => !planIds.has(t.id) && !t.doneToday) && 'Other open tasks:',
    ...refs.filter(t => !planIds.has(t.id) && !t.doneToday).slice(0, 15).map(t => `  ${taskLine(t)}`),
    refs.some(t => t.doneToday) && `Finished today: ${refs.filter(t => t.doneToday).map(t => `[${t.ref}] ${t.title}`).join('; ')}`,
    s.quests?.daily?.length && `Daily quests: ${s.quests.daily.map(q => `${q.title} ${q.done ? 'done' : `${q.progress}/${q.target}${q.unit ? ` ${q.unit}` : ''}`}`).join('; ')}`,
    s.quests?.boss && `Weekly boss: ${s.quests.boss.name}, ${s.quests.boss.defeated ? 'defeated' : `${s.quests.boss.hpLeft}/${s.quests.boss.hp} HP left`}`,
    s.mirror && join([
      s.mirror.intention ? `Morning intention: "${s.mirror.intention}"${s.mirror.why ? ` (why: ${s.mirror.why})` : ''}${s.mirror.ifThen ? `, plan: ${s.mirror.ifThen}` : ''}` : 'No morning intention set yet today',
      s.mirror.eveningDone ? 'The day is closed in the Mirror' : 'The day is not closed in the Mirror yet',
      s.mirror.weeklyFocus && `weekly focus: ${s.mirror.weeklyFocus}`,
      s.mirror.read?.length && `Mirror says: ${s.mirror.read.join(' ')}`,
    ], '. '),
    s.insights?.length && `Patterns the Mirror found: ${s.insights.map(i => `${i.title}: ${i.text}`).join(' | ')}`,
    h && join([
      `Health today: sleep ${h.sleep?.hours != null ? `${h.sleep.hours} h` : 'not logged'}${h.goals?.sleepHours ? ` (goal ${h.goals.sleepHours} h)` : ''}`,
      `water ${h.waterMl ?? 0} ml${h.goals?.waterGlasses ? ` (goal ${h.goals.waterGlasses} glasses of ${h.goals.glassMl ?? 250} ml)` : ''}`,
      `exercise ${h.exerciseMinutes ?? 0} min${h.goals?.exerciseMinutes ? ` (goal ${h.goals.exerciseMinutes})` : ''}`,
      h.moods?.length ? `mood ${h.moods.map(m => `${m.slot} ${m.mood}/5`).join(', ')}` : 'mood not logged',
    ], ', '),
    s.money && join([
      s.money.spentToday != null && `Money: spent ${s.money.spentToday} today`,
      s.money.monthSpent != null && `this month ${s.money.monthIncome ?? 0} in, ${s.money.monthSpent} out`,
      s.money.warnings?.length && `warnings: ${s.money.warnings.join('; ')}`,
    ], ', '),
    s.lessons?.dueCount ? `Lessons due for review: ${s.lessons.dueCount} (${(s.lessons.due ?? []).join(', ')})` : null,
    s.habits?.length && `Habits today: ${s.habits.map((h, i) => `[H${i + 1}] ${h.name} ${habitProgress(h)}`).join('; ')}`,
    s.actions?.length && `Recent requests you sent: ${s.actions.slice(0, 5).map(a => `${a.ok ? 'done' : 'FAILED'}: ${a.message}`).join('; ')}`,
  ];
  const where = onPhone(s) ? '; it is an app on their phone and only updates while it is open' : '';
  return `LIFE LEVELLING (their game-style growth app; data from ${ago(s.generatedAt)}${where})
${lines.filter(Boolean).join('\n')}`;
}

// ---------- Tools: requests Life Levelling applies within a minute (on the phone: when its app is open) ----------

function tool(name, description, properties, required = []) {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } };
}

const TASK_REF = { type: 'string', description: 'The Life Levelling task reference shown as [L3], without brackets, e.g. "L3".' };

export const LIFE_TOOLS = [
  tool(
    'life_log_health',
    'Log health in Life Levelling when the user reports it: water drunk, last night\'s sleep, their mood, or exercise.',
    {
      kind: { type: 'string', enum: ['water', 'sleep', 'mood', 'exercise'] },
      ml: { type: 'integer', minimum: 100, maximum: 3000, description: 'water: millilitres (a glass is about 250).' },
      hours: { type: 'number', description: 'sleep: hours slept, e.g. 7.5.' },
      quality: { type: 'integer', minimum: 1, maximum: 5, description: 'sleep: optional quality, 1 (awful) to 5 (great).' },
      mood: { type: 'integer', minimum: 1, maximum: 5, description: 'mood: 1 (very low) to 5 (great).' },
      note: { type: 'string', description: 'mood: optional short note in their words.' },
      activity: { type: 'string', description: 'exercise: e.g. "walk", "gym", "yoga".' },
      minutes: { type: 'integer', minimum: 1, maximum: 600, description: 'exercise: minutes.' },
    },
    ['kind'],
  ),
  tool('life_complete_task', 'Tick off a Life Levelling task the user says they finished. It earns them XP and gold.', { task: TASK_REF }, ['task']),
  tool(
    'life_update_task',
    'Change a Life Levelling task: rename it, edit its notes, change its priority, move or clear its due date and time, start it, '
      + 'pause it, or reopen one finished today by mistake. Send only what changes.',
    {
      task: TASK_REF,
      title: { type: 'string', description: 'New title.' },
      notes: { type: 'string', description: 'New notes (replaces the old ones); an empty string clears them.' },
      priority: { type: 'integer', minimum: 1, maximum: 5, description: '1 urgent, 2 high, 3 medium, 4 low, 5 minimal.' },
      due_date: { type: 'string', description: 'New due date, YYYY-MM-DD.' },
      due_time: { type: 'string', description: 'New due time, HH:MM.' },
      clear_due: { type: 'boolean', description: 'true to remove the due date and time ("someday").' },
      status: { type: 'string', enum: ['in_progress', 'pending'], description: 'in_progress to start it; pending to pause it or reopen a finished one.' },
    },
    ['task'],
  ),
  tool(
    'life_delete_task',
    'Delete a Life Levelling task for good. Only when the user clearly asks to delete or remove it; if they finished it, use life_complete_task.',
    { task: TASK_REF },
    ['task'],
  ),
  tool(
    'life_add_task',
    'Add a task to Life Levelling (their main to-do list, where finishing earns XP).',
    {
      title: { type: 'string', description: 'Short task title.' },
      priority: { type: 'integer', minimum: 1, maximum: 5, description: '1 urgent, 2 high, 3 medium (default), 4 low, 5 minimal.' },
      due_date: { type: 'string', description: 'Optional, YYYY-MM-DD.' },
      due_time: { type: 'string', description: 'Optional, HH:MM.' },
    },
    ['title'],
  ),
  tool(
    'life_set_intention',
    "Set today's morning intention in Life Levelling's Mirror: the one thing that would make today a win.",
    {
      intention: { type: 'string', description: 'In their words, under 140 characters.' },
      why: { type: 'string', description: 'Optional: why it matters.' },
      if_then: { type: 'string', description: 'Optional: "If <obstacle>, then I will <action>."' },
    },
    ['intention'],
  ),
  tool(
    'life_log_habit',
    'Tick off or count a Life Levelling habit the user says they did ("I meditated", "two more glasses of water", "took my vitamins").',
    {
      habit: { type: 'string', description: 'The habit reference shown as [H2], without brackets, e.g. "H2".' },
      amount: { type: 'number', description: 'For counted habits: how much (cups, minutes, steps...). Leave out for a simple tick.' },
      note: { type: 'string', description: 'Optional short note.' },
    },
    ['habit'],
  ),
  tool(
    'life_close_day',
    "Close the day in Life Levelling's Mirror (the evening reflection): whether today's intention happened, a win, a lesson, and a 1-5 rating. "
      + 'Ask them in the evening, then log what they said; leave out what they did not say.',
    {
      outcome: { type: 'string', enum: ['done', 'partly', 'missed'], description: "Did the morning intention happen?" },
      win: { type: 'string', description: 'The best thing about today, in their words.' },
      lesson: { type: 'string', description: 'What they learned or would do differently.' },
      rating: { type: 'integer', minimum: 1, maximum: 5, description: 'How the day felt, 1 to 5.' },
    },
  ),
  tool(
    'life_log_expense',
    'Record money the user spent, in Life Levelling.',
    {
      amount: { type: 'number', description: 'How much, as a plain number.' },
      category: { type: 'string', description: 'e.g. Food, Transport, Shopping, Rent, Utilities, Health, Entertainment.' },
      note: { type: 'string', description: 'Optional: what it was.' },
    },
    ['amount', 'category'],
  ),
];

async function send(type, fields, chip) {
  await sendRequest(APP, { type, ...fields, at: Date.now(), date: localStamp().slice(0, 10) });
  const when = onPhone()
    ? 'Life Levelling applies it the next time its app is open on their phone (within a minute if it is open now).'
    : 'Life Levelling applies it within a minute (while their computer is on).';
  return { text: chip, result: `${chip}. ${when}` };
}

function findTask(ref) {
  const wanted = String(ref ?? '').trim().replace(/^\[|\]$/g, '').toUpperCase();
  const task = taskRefs().find(t => t.ref === wanted);
  if (!task) throw new Error(`There is no Life Levelling task ${ref}. Use a reference like L3 from your context.`);
  return task;
}

const required = (value, field) => {
  if (value == null || value === '') throw new Error(`${field} is required.`);
  return value;
};

export const lifeHandlers = {
  life_log_health({ kind, ml, hours, quality, mood, note, activity, minutes }) {
    if (kind === 'water') return send('log_water', { ml: Number(required(ml, 'ml')) }, `Sent to Life Levelling: ${ml} ml of water`);
    if (kind === 'sleep') return send('log_sleep', { hours: Number(required(hours, 'hours')), quality }, `Sent to Life Levelling: ${hours} h of sleep`);
    if (kind === 'mood') return send('log_mood', { mood: Number(required(mood, 'mood')), note }, `Sent to Life Levelling: mood ${mood}/5`);
    if (kind === 'exercise') {
      return send('log_exercise', { activity: required(activity, 'activity'), minutes: Number(required(minutes, 'minutes')) },
        `Sent to Life Levelling: ${minutes} min of ${activity}`);
    }
    throw new Error('kind must be water, sleep, mood or exercise.');
  },
  life_complete_task({ task }) {
    const found = findTask(task);
    return send('complete_task', { taskId: found.id }, `Ticked off in Life Levelling: ${found.title}`);
  },
  life_update_task({ task, title, notes, priority, due_date, due_time, clear_due, status }) {
    const found = findTask(task);
    const changes = { title, notes, priority, dueDate: due_date, dueTime: due_time, clearDue: clear_due === true || undefined, status };
    for (const key of Object.keys(changes)) if (changes[key] === undefined || changes[key] === null) delete changes[key];
    if (!Object.keys(changes).length) throw new Error('Say what to change: title, notes, priority, due_date, due_time, clear_due or status.');
    const what = status === 'in_progress' ? 'Started' : status === 'pending' && found.doneToday ? 'Reopened' : 'Changed';
    return send('update_task', { taskId: found.id, ...changes }, `${what} in Life Levelling: ${title ?? found.title}`);
  },
  life_delete_task({ task }) {
    const found = findTask(task);
    return send('delete_task', { taskId: found.id }, `Deleted from Life Levelling: ${found.title}`);
  },
  life_log_habit({ habit, amount, note }) {
    const wanted = String(habit ?? '').trim().replace(/^\[|\]$/g, '').toUpperCase();
    const index = /^H(\d+)$/.exec(wanted)?.[1];
    const found = index && summary()?.habits?.[Number(index) - 1];
    if (!found) throw new Error(`There is no Life Levelling habit ${habit}. Use a reference like H2 from your context.`);
    const fields = { habitId: found.id, ...(amount != null && { amount: Number(amount) }), ...(note && { note }) };
    return send('log_habit', fields, `Logged in Life Levelling: ${found.name}${amount != null ? ` ${amount}${found.unit ? ` ${found.unit}` : ''}` : ''}`);
  },
  life_close_day({ outcome, win, lesson, rating }) {
    const fields = { outcome, win, lesson, rating };
    for (const key of Object.keys(fields)) if (fields[key] == null || fields[key] === '') delete fields[key];
    if (!Object.keys(fields).length) throw new Error('Ask how the day went first: outcome, a win, a lesson or a rating.');
    return send('close_day', fields, 'Day closed in Life Levelling');
  },
  life_add_task({ title, priority, due_date, due_time }) {
    const name = String(required(title, 'title')).trim().slice(0, 200);
    return send('add_task', { title: name, priority, dueDate: due_date, dueTime: due_time }, `Added to Life Levelling: ${name}`);
  },
  life_set_intention({ intention, why, if_then }) {
    const text = String(required(intention, 'intention')).trim().slice(0, 140);
    return send('set_intention', { intention: text, why, ifThen: if_then }, `Today's intention: ${text}`);
  },
  life_log_expense({ amount, category, note }) {
    return send('log_expense', { amount: Number(required(amount, 'amount')), category: required(category, 'category'), note },
      `Sent to Life Levelling: spent ${amount} on ${category}`);
  },
};
