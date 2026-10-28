// Life Levelling link. Life Levelling is the user's game-style growth app (level, quests, plan, health,
// money, the Mirror), running on their computer. When they connect it (Life Levelling → Settings →
// LightMoon, with this device's sync code), it leaves an encrypted summary of their day in LightMoon's
// cloud every few minutes and applies the requests LightMoon leaves there: log water, tick off a task...
// So LightMoon can coach from their real numbers and act on them from anywhere.
import { readFeed, sendRequest, syncCode } from './cloud.js';
import { localStamp } from './time.js';

const APP = 'lifelevelling';
const KEY = 'assistant.lifelevelling'; // this device only; always re-read from the cloud
const REFRESH_AFTER_MS = 2 * 60_000;
const STALE_AFTER_MS = 36 * 3_600_000; // the computer has been off for a long while: don't coach from it
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
  return `Connected${latest.you?.name ? ` as ${latest.you.name}` : ''}, updated ${age}${summary() ? '' : ' (too old to use; is the computer on?)'}.`;
}

// Life Levelling task ids are long; the model sees short references (L1, L2...) instead.
function taskRefs(latest = summary()) {
  if (!latest) return [];
  const seen = new Set();
  const list = [...(latest.plan?.today ?? []), ...(latest.tasks ?? [])].filter(t => t?.id && !seen.has(t.id) && seen.add(t.id));
  return list.map((task, index) => ({ ...task, ref: `L${index + 1}` }));
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
  const taskLine = t => join([`[${refOf(t.id)}] ${t.title}`, PRIORITY[t.priority], t.due && `due ${t.due}`, t.reason], ' | ');
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
    refs.some(t => !planIds.has(t.id)) && 'Other open tasks:',
    ...refs.filter(t => !planIds.has(t.id)).slice(0, 15).map(t => `  ${taskLine(t)}`),
    s.quests?.daily?.length && `Daily quests: ${s.quests.daily.map(q => `${q.title} ${q.done ? 'done' : `${q.progress}/${q.target}${q.unit ? ` ${q.unit}` : ''}`}`).join('; ')}`,
    s.quests?.boss && `Weekly boss: ${s.quests.boss.name}, ${s.quests.boss.defeated ? 'defeated' : `${s.quests.boss.hpLeft}/${s.quests.boss.hp} HP left`}`,
    s.mirror && join([
      s.mirror.intention ? `Morning intention: "${s.mirror.intention}"${s.mirror.why ? ` (why: ${s.mirror.why})` : ''}${s.mirror.ifThen ? `, plan: ${s.mirror.ifThen}` : ''}` : 'No morning intention set yet today',
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
    s.actions?.length && `Recent requests you sent: ${s.actions.slice(0, 5).map(a => `${a.ok ? 'done' : 'FAILED'}: ${a.message}`).join('; ')}`,
  ];
  return `LIFE LEVELLING (their game-style growth app; data from ${ago(s.generatedAt)})
${lines.filter(Boolean).join('\n')}`;
}

// ---------- Tools: requests Life Levelling applies within a minute ----------

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
  return { text: chip, result: `${chip}. Life Levelling applies it within a minute (while their computer is on).` };
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
