// Everything LightMoon knows is stored on this device, in the browser's local storage.
// Nothing here leaves the device except the conversation sent to the AI service, and, if sync is on,
// an encrypted copy (see cloud.js). Records carry random ids and change times so devices can merge.
import { localStamp, today } from './time.js';
import { reminderLine, checkInsOf, checkInLine, checksIn } from './announce.js';

export const MEMORY_CATEGORIES = ['preference', 'person', 'routine', 'goal', 'health', 'work', 'fact', 'other'];
export const GOAL_STATUSES = ['active', 'achieved', 'dropped'];
export const DEFAULT_AI = {
  baseUrl: 'https://api.groq.com/openai/v1',
  apiKey: '',
  model: 'openai/gpt-oss-120b',
  fallbackModel: 'openai/gpt-oss-20b',
};

// Models Groq stopped serving to free accounts ("does not exist or you do not have access"), and what replaces them.
const RETIRED_MODELS = { 'llama-3.1-8b-instant': DEFAULT_AI.fallbackModel };

// Storage keys don't use the app's name, so renaming the assistant never strands data.
const DATA_KEY = 'assistant.data.v1';
const AI_KEY = 'assistant.ai'; // kept apart from the data so backups never contain the API key
const MAX_MESSAGES = 400;
const KEEP_DELETED_MS = 60 * 86_400_000; // deletions are remembered this long so they reach other devices
const COLLECTIONS = ['memories', 'tasks', 'goals', 'checkins', 'routines'];
const LOCAL_SETTINGS = new Set(['last_briefing']); // per device, never synced

const blank = () => ({
  settings: {},
  settingsAt: {}, // when each setting last changed, for sync
  messages: [],
  memories: [],
  tasks: [],
  goals: [],
  checkins: [],
  routines: [], // "good night" -> steps the AI carries out with its tools
});

// Short random ids that won't clash between a phone and a computer.
export function newId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), byte => (byte % 36).toString(36)).join('');
}

function readJson(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null');
  } catch {
    return null;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    console.error('LightMoon could not save to this device:', err);
  }
}

const createdMs = record => Date.parse(record.done_at ?? record.created_at ?? '') || 0;

function normalize(saved) {
  const base = blank();
  if (!saved || typeof saved !== 'object') return base;
  const list = name => (Array.isArray(saved[name]) ? saved[name].filter(item => item && typeof item === 'object') : []);
  const data = {
    settings: { ...saved.settings },
    settingsAt: { ...saved.settingsAt },
    messages: list('messages'),
    memories: list('memories'),
    tasks: list('tasks'),
    goals: list('goals'),
    checkins: list('checkins'),
    routines: list('routines'),
  };
  return upgradeRecords(data);
}

// Older versions numbered records 1, 2, 3 on each device and kept no change times.
// Give them unique ids and times so they can be merged with other devices.
function upgradeRecords(data) {
  const goalIds = new Map();
  for (const name of COLLECTIONS) {
    for (const record of data[name]) {
      if (typeof record.id === 'number') {
        const id = newId();
        if (name === 'goals') goalIds.set(record.id, id);
        record.id = id;
      }
      record.updated_at ??= Math.min(createdMs(record), Date.now());
    }
  }
  for (const checkin of data.checkins) {
    if (goalIds.has(checkin.goal_id)) checkin.goal_id = goalIds.get(checkin.goal_id);
  }
  data.messages.forEach((message, index) => {
    if (typeof message.id === 'number') message.id = newId();
    message.at ??= (Date.parse(message.created_at ?? '') || 0) + index; // keeps same-minute messages in order
  });
  data.messages.sort((a, b) => a.at - b.at);
  for (const key of Object.keys(data.settings)) {
    if (!LOCAL_SETTINGS.has(key)) data.settingsAt[key] ??= 0;
  }
  return data;
}

// Earlier versions (named Vega, and before that Jarvis) stored data under their own names.
// Carry it over once, dropping the old default name so the current one applies.
const OLD_PREFIXES = ['vega', 'jarvis'];
const OLD_DEFAULT_NAMES = ['Vega', 'Jarvis'];

function migrateOldKeys() {
  try {
    for (const prefix of OLD_PREFIXES) {
      for (const [oldKey, newKey] of [[`${prefix}.data.v1`, DATA_KEY], [`${prefix}.ai`, AI_KEY]]) {
        const old = readJson(oldKey);
        if (old === null) continue;
        if (OLD_DEFAULT_NAMES.includes(old.settings?.assistant_name)) delete old.settings.assistant_name;
        if (localStorage.getItem(newKey) === null) writeJson(newKey, old);
        localStorage.removeItem(oldKey);
      }
    }
  } catch {
    // Storage unavailable: nothing to migrate.
  }
}

migrateOldKeys();
let data = normalize(readJson(DATA_KEY));
writeJson(DATA_KEY, data); // keep upgraded ids stable from the first launch

const changeListeners = new Set();

// Called after every change made on this device (cloud.js uses it to sync).
export const onLocalChange = callback => changeListeners.add(callback);

function save({ quiet = false } = {}) {
  if (data.messages.length > MAX_MESSAGES) data.messages = data.messages.slice(-MAX_MESSAGES);
  const cutoff = Date.now() - KEEP_DELETED_MS;
  for (const name of COLLECTIONS) data[name] = data[name].filter(r => !r.deleted || r.updated_at > cutoff);
  writeJson(DATA_KEY, data);
  if (!quiet) for (const callback of changeListeners) callback();
}

// An edit always counts as newer than the version it replaces, even if this device's clock is behind.
const touch = record => {
  record.updated_at = Math.max(Date.now(), (record.updated_at ?? 0) + 1);
};
const live = name => data[name].filter(record => !record.deleted);
const find = (name, id) => live(name).find(record => record.id === String(id));

// Deleted records stay as an empty marker for a while, so the deletion reaches other devices.
function remove(name, id) {
  const record = find(name, id);
  if (!record) return false;
  for (const key of Object.keys(record)) if (!['id', 'goal_id'].includes(key)) delete record[key];
  record.deleted = true;
  touch(record);
  save();
  return true;
}

// Another tab or window changed the data: reload it and let the page re-render.
export function onExternalChange(callback) {
  window.addEventListener('storage', event => {
    if (event.key !== DATA_KEY && event.key !== AI_KEY) return;
    data = normalize(readJson(DATA_KEY));
    callback();
  });
}

// ---------- Profile and AI settings ----------

export const settings = {
  get: (key, fallback = '') => data.settings[key] ?? fallback,
  all: () => ({ ...data.settings }),
  set(key, value) {
    data.settings[key] = String(value);
    if (!LOCAL_SETTINGS.has(key)) data.settingsAt[key] = Date.now();
    save();
  },
};

export function profile() {
  return {
    userName: settings.get('user_name'),
    address: settings.get('address', 'sir'),
    assistantName: settings.get('assistant_name', 'LightMoon'),
  };
}

export function saveProfile({ userName, address, assistantName }) {
  const clean = (value, max) => String(value).trim().slice(0, max);
  const update = (key, value) => {
    if (data.settings[key] === value) return;
    data.settings[key] = value;
    data.settingsAt[key] = Date.now();
  };
  if (typeof userName === 'string') update('user_name', clean(userName, 60));
  if (typeof address === 'string' && address.trim()) update('address', clean(address, 30));
  if (typeof assistantName === 'string' && assistantName.trim()) update('assistant_name', clean(assistantName, 30));
  save();
}

export function aiConfig() {
  const ai = { ...DEFAULT_AI, ...readJson(AI_KEY) };
  ai.baseUrl = (ai.baseUrl || DEFAULT_AI.baseUrl).trim().replace(/\/+$/, '');
  ai.model = RETIRED_MODELS[ai.model] ?? (ai.model || DEFAULT_AI.model);
  ai.fallbackModel = RETIRED_MODELS[ai.fallbackModel] ?? ai.fallbackModel;
  // Local servers such as Ollama don't need a key.
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(`${ai.baseUrl}/`);
  return { ...ai, ready: isLocal || Boolean(ai.apiKey) };
}

export function saveAiConfig(changes) {
  const { ready, ...current } = aiConfig();
  writeJson(AI_KEY, { ...current, ...changes });
}

// ---------- Conversation, memories, tasks, goals ----------

export const messages = {
  add(role, content) {
    const at = Math.max(Date.now(), (data.messages.at(-1)?.at ?? 0) + 1);
    data.messages.push({ id: newId(), role, content, created_at: localStamp(), at });
    save();
  },
  recent: limit => data.messages.slice(-limit),
};

const byCreated = (a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? '') || a.updated_at - b.updated_at;

export const memories = {
  list: () => live('memories').sort(byCreated).reverse(),
  add(content, category) {
    data.memories.push({ id: newId(), content, category, created_at: localStamp(), updated_at: Date.now() });
    save();
  },
  remove: id => remove('memories', id),
};

const whenOf = task => task.remind_at ?? task.due_at ?? '9999';
const LATE_CHECK_IN_MS = 20 * 60_000; // a check-in missed by more than this (the device was off) is skipped
const WAITING_FOR_MS = 12 * 3600_000; // how long a reminder nobody answered stays on the AI's mind

export const tasks = {
  open: () => live('tasks').filter(t => !t.done).sort((a, b) => whenOf(a).localeCompare(whenOf(b)) || byCreated(a, b)),
  doneToday: () =>
    live('tasks').filter(t => t.done && t.done_at?.startsWith(today())).sort((a, b) => b.done_at.localeCompare(a.done_at)),
  get: id => find('tasks', id),
  // `announce` is what to say out loud when the reminder goes off. `checkIn` is the question to ask afterwards
  // until they answer (null: a plain one), or false for a heads-up that needs no answer.
  add({ title, dueAt = null, remindAt = null, announce = null, checkIn = null }) {
    data.tasks.push({
      id: newId(), title, due_at: dueAt, remind_at: remindAt, announce, check_in: checkIn,
      done: false, reminded: false, done_at: null, created_at: localStamp(), updated_at: Date.now(),
    });
    save();
  },
  // "Later": the reminder goes off again at `remindAt`, and the check-ins start over from then.
  snooze(id, remindAt) {
    const task = tasks.get(id);
    if (!task || task.done) return false;
    Object.assign(task, { remind_at: remindAt, reminded: false, checked_in: 0, answered: false });
    touch(task);
    save();
    return true;
  },
  // "Stop asking": no more check-ins, though it isn't done.
  stopCheckingIn(id) {
    const task = tasks.get(id);
    if (!task || task.answered) return false;
    task.answered = true;
    touch(task);
    save();
    return true;
  },
  // Saying a reminder or a check-in is bookkeeping, not a change: it keeps the task's change time, so it can't
  // win over a real change made on another device meanwhile (Done tapped on the phone as the computer checks
  // in). Merging keeps what was said on either device (mergeIn).
  // A check-in was said (here, or by the phone or a notification while LightMoon was closed).
  markCheckedIn(id, n) {
    const task = tasks.get(id);
    if (!task || (task.checked_in ?? 0) >= n) return;
    task.checked_in = n;
    save();
  },
  markReminded(id) {
    const task = tasks.get(id);
    if (!task || task.reminded) return;
    task.reminded = true;
    save();
  },
  complete(id) {
    const task = tasks.get(id);
    if (!task || task.done) return false;
    task.done = true;
    task.done_at = localStamp();
    touch(task);
    save();
    return true;
  },
  remove: id => remove('tasks', id),

  // Everything to alert at or after `since` (ms), for notifications and the phone's alarms: each unfinished
  // task's reminder and its check-ins, with the words to say. This includes ones already announced on this
  // device, so the user's other devices still get them.
  alertsSince(since) {
    const words = data.settings;
    const alerts = [];
    for (const task of tasks.open().filter(t => t.remind_at)) {
      const base = { title: task.title, updated: task.updated_at };
      alerts.push({ ...base, id: task.id, at: Date.parse(task.remind_at), say: reminderLine(task, words) });
      for (const check of checkInsOf(task, words)) alerts.push({ ...base, id: check.id, at: check.at, say: checkInLine(task, words, check.n) });
    }
    return alerts.filter(alert => Number.isFinite(alert.at) && alert.at >= since);
  },

  // Returns reminders that are due and marks them delivered, so each one fires once. Check-ins that fell
  // due meanwhile (the app was closed) are counted as said: the reminder is announced instead.
  takeDueReminders() {
    const now = localStamp();
    const due = live('tasks').filter(t => !t.done && !t.reminded && t.remind_at && t.remind_at <= now);
    for (const task of due) {
      task.reminded = true;
      const passed = checkInsOf(task, data.settings).filter(check => check.at <= Date.now());
      if (passed.length) task.checked_in = passed.at(-1).n;
    }
    if (due.length) save();
    return due.map(({ id, title, remind_at, announce }) => ({ id, title, remind_at, announce }));
  },

  // Check-ins due now for reminders that went off and got no answer: the latest one per task, with its words.
  // Ones missed by a long way are skipped quietly (marked said), so opening the app doesn't bring a pile of them.
  takeDueCheckIns() {
    const now = Date.now();
    const due = [];
    let changed = false;
    for (const task of live('tasks').filter(t => t.reminded)) {
      const passed = checkInsOf(task, data.settings).filter(check => check.at <= now);
      if (!passed.length) continue;
      const latest = passed.at(-1);
      task.checked_in = latest.n;
      changed = true;
      if (now - latest.at <= LATE_CHECK_IN_MS) due.push({ id: latest.id, task, n: latest.n, say: checkInLine(task, data.settings, latest.n) });
    }
    if (changed) save();
    return due;
  },

  // Reminders that went off in the last few hours with no answer yet, so the AI can ask how it went.
  waitingForAnswer() {
    const since = localStamp(new Date(Date.now() - WAITING_FOR_MS));
    return live('tasks').filter(t => t.reminded && checksIn(t, data.settings) && t.remind_at >= since && t.remind_at <= localStamp());
  },
};

export const goals = {
  active: () =>
    live('goals')
      .filter(goal => goal.status === 'active')
      .sort(byCreated)
      .map(goal => {
        const checkins = live('checkins').filter(c => c.goal_id === goal.id).sort(byCreated);
        const last = checkins.at(-1);
        return { ...goal, checkin_count: checkins.length, last_note: last?.note ?? null, last_checkin: last?.created_at ?? null };
      }),
  get: id => find('goals', id),
  add({ title, why = null, targetDate = null }) {
    data.goals.push({ id: newId(), title, why, target_date: targetDate, status: 'active', created_at: localStamp(), updated_at: Date.now() });
    save();
  },
  setStatus(id, status) {
    const goal = goals.get(id);
    if (!goal) return false;
    goal.status = status;
    touch(goal);
    save();
    return true;
  },
  logProgress(goalId, note, rating = null) {
    data.checkins.push({ id: newId(), goal_id: goalId, note, rating, created_at: localStamp(), updated_at: Date.now() });
    save();
  },
};

// A routine: a phrase ("good night") and what to do when the user says it, in their words; the AI carries
// the steps out with its tools. Saving one with an existing phrase replaces it.
export const routines = {
  list: () => live('routines').filter(r => typeof r.trigger === 'string').sort((a, b) => a.trigger.localeCompare(b.trigger)),
  get: id => find('routines', id),
  save({ trigger, steps }) {
    const existing = live('routines').find(r => r.trigger.toLowerCase() === trigger.toLowerCase());
    if (existing) {
      existing.steps = steps;
      touch(existing);
    } else {
      data.routines.push({ id: newId(), trigger, steps, created_at: localStamp(), updated_at: Date.now() });
    }
    save();
    return !existing;
  },
  remove: id => remove('routines', id),
};

// ---------- Sync support (used by cloud.js) ----------

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// The part of the data shared between devices, in a fixed order so two copies can be compared.
export function syncableData(source = data) {
  const settings = {};
  const settingsAt = {};
  for (const key of Object.keys(source.settings).sort()) {
    if (LOCAL_SETTINGS.has(key)) continue;
    settings[key] = source.settings[key];
    settingsAt[key] = source.settingsAt[key] ?? 0;
  }
  const shared = { settings, settingsAt, messages: source.messages };
  for (const name of COLLECTIONS) shared[name] = [...source[name]].sort(byId);
  return shared;
}

// The same, for a copy that came from another device.
export const syncableOf = remote => syncableData(normalize(remote));

// Merges another device's copy in: for each record the most recent change wins, chats are combined.
// Returns how many chat messages were new here.
// A reminder (and its check-ins) said on either device counts as said, for the same reminder time (see markReminded).
function keepWhatWasSaid(task, other) {
  if (task.deleted || other.deleted || task.remind_at !== other.remind_at) return;
  if (other.reminded) task.reminded = true;
  if ((other.checked_in ?? 0) > (task.checked_in ?? 0)) task.checked_in = other.checked_in;
}

export function mergeIn(remote) {
  const theirs = normalize(remote);
  for (const name of COLLECTIONS) {
    const merged = new Map(data[name].map(record => [record.id, record]));
    for (const record of theirs[name]) {
      const mine = merged.get(record.id);
      const newer = !mine || (record.updated_at ?? 0) > (mine.updated_at ?? 0);
      const winner = newer ? { ...record } : mine;
      if (name === 'tasks' && mine) keepWhatWasSaid(winner, newer ? mine : record);
      if (newer) merged.set(record.id, winner);
    }
    data[name] = [...merged.values()];
  }
  const known = new Set(data.messages.map(m => m.id));
  const added = theirs.messages.filter(m => !known.has(m.id));
  data.messages = [...data.messages, ...added].sort((a, b) => a.at - b.at || byId(a, b));
  for (const [key, at] of Object.entries(theirs.settingsAt)) {
    if (LOCAL_SETTINGS.has(key) || at <= (data.settingsAt[key] ?? 0)) continue;
    data.settings[key] = theirs.settings[key];
    data.settingsAt[key] = at;
  }
  save({ quiet: true });
  return added.length;
}

// ---------- Whole-state helpers ----------

export function snapshot() {
  const ai = aiConfig();
  let provider = ai.baseUrl;
  try {
    provider = new URL(ai.baseUrl).host;
  } catch {
    // Show the raw value if it isn't a valid URL.
  }
  return {
    profile: profile(),
    ai: { ready: ai.ready, hasKey: Boolean(ai.apiKey), model: ai.model, provider },
    tasks: tasks.open(),
    doneToday: tasks.doneToday(),
    goals: goals.active(),
    memories: memories.list(),
    routines: routines.list(),
  };
}

// Removes everything this app keeps on the device: data, AI settings, preferences, the app lock and sync settings.
export function eraseEverything() {
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith('assistant.')) localStorage.removeItem(key);
  }
  data = blank();
}

export function exportData() {
  return JSON.stringify({ app: 'lightmoon', version: 2, exportedAt: new Date().toISOString(), ...data }, null, 2);
}

export function importData(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (!['lightmoon', ...OLD_PREFIXES].includes(parsed?.app)) throw new Error("That file isn't a LightMoon backup.");
  data = normalize(parsed);
  save();
}
