// Everything Vega knows is stored on this device, in the browser's local storage.
// Nothing here leaves the device except the conversation sent to the AI service.
import { localStamp, today } from './time.js';

export const MEMORY_CATEGORIES = ['preference', 'person', 'routine', 'goal', 'health', 'work', 'fact', 'other'];
export const GOAL_STATUSES = ['active', 'achieved', 'dropped'];
export const DEFAULT_AI = {
  baseUrl: 'https://api.groq.com/openai/v1',
  apiKey: '',
  model: 'openai/gpt-oss-120b',
  fallbackModel: 'llama-3.1-8b-instant',
};

const DATA_KEY = 'vega.data.v1';
const AI_KEY = 'vega.ai'; // kept apart from the data so backups never contain the API key
const MAX_MESSAGES = 400;

const blank = () => ({
  settings: {},
  ids: { message: 0, memory: 0, task: 0, goal: 0, checkin: 0 },
  messages: [],
  memories: [],
  tasks: [],
  goals: [],
  checkins: [],
});

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
    console.error('Vega could not save to this device:', err);
  }
}

function normalize(saved) {
  const base = blank();
  if (!saved || typeof saved !== 'object') return base;
  const list = name => (Array.isArray(saved[name]) ? saved[name] : []);
  return {
    settings: { ...saved.settings },
    ids: { ...base.ids, ...saved.ids },
    messages: list('messages'),
    memories: list('memories'),
    tasks: list('tasks'),
    goals: list('goals'),
    checkins: list('checkins'),
  };
}

// Carry over anything saved before the app was renamed from Jarvis to Vega.
function migrateOldName() {
  try {
    for (const [oldKey, newKey] of [['jarvis.data.v1', DATA_KEY], ['jarvis.ai', AI_KEY]]) {
      const old = readJson(oldKey);
      if (old === null) continue;
      if (old.settings?.assistant_name === 'Jarvis') delete old.settings.assistant_name; // adopt the new default name
      if (localStorage.getItem(newKey) === null) writeJson(newKey, old);
      localStorage.removeItem(oldKey);
    }
  } catch {
    // Storage unavailable: nothing to migrate.
  }
}

migrateOldName();
let data = normalize(readJson(DATA_KEY));

function save() {
  if (data.messages.length > MAX_MESSAGES) data.messages = data.messages.slice(-MAX_MESSAGES);
  writeJson(DATA_KEY, data);
}

const nextId = kind => ++data.ids[kind];

function removeWhere(name, predicate) {
  const before = data[name].length;
  data[name] = data[name].filter(item => !predicate(item));
  if (data[name].length === before) return false;
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
  set(key, value) {
    data.settings[key] = String(value);
    save();
  },
};

export function profile() {
  return {
    userName: settings.get('user_name'),
    address: settings.get('address', 'sir'),
    assistantName: settings.get('assistant_name', 'Vega'),
  };
}

export function saveProfile({ userName, address, assistantName }) {
  const clean = (value, max) => String(value).trim().slice(0, max);
  if (typeof userName === 'string') data.settings.user_name = clean(userName, 60);
  if (typeof address === 'string' && address.trim()) data.settings.address = clean(address, 30);
  if (typeof assistantName === 'string' && assistantName.trim()) data.settings.assistant_name = clean(assistantName, 30);
  save();
}

export function aiConfig() {
  const ai = { ...DEFAULT_AI, ...readJson(AI_KEY) };
  ai.baseUrl = (ai.baseUrl || DEFAULT_AI.baseUrl).trim().replace(/\/+$/, '');
  ai.model = ai.model || DEFAULT_AI.model;
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
    data.messages.push({ id: nextId('message'), role, content, created_at: localStamp() });
    save();
  },
  recent: limit => data.messages.slice(-limit),
};

export const memories = {
  list: () => [...data.memories].reverse(),
  add(content, category) {
    data.memories.push({ id: nextId('memory'), content, category, created_at: localStamp() });
    save();
  },
  remove: id => removeWhere('memories', memory => memory.id === id),
};

const whenOf = task => task.remind_at ?? task.due_at ?? '9999';

export const tasks = {
  open: () => data.tasks.filter(t => !t.done).sort((a, b) => whenOf(a).localeCompare(whenOf(b)) || a.id - b.id),
  doneToday: () =>
    data.tasks.filter(t => t.done && t.done_at?.startsWith(today())).sort((a, b) => b.done_at.localeCompare(a.done_at)),
  get: id => data.tasks.find(t => t.id === id),
  add({ title, dueAt = null, remindAt = null }) {
    data.tasks.push({
      id: nextId('task'), title, due_at: dueAt, remind_at: remindAt,
      done: false, reminded: false, done_at: null, created_at: localStamp(),
    });
    save();
  },
  complete(id) {
    const task = tasks.get(id);
    if (!task || task.done) return false;
    task.done = true;
    task.done_at = localStamp();
    save();
    return true;
  },
  remove: id => removeWhere('tasks', task => task.id === id),

  // Returns reminders that are due and marks them delivered, so each one fires once.
  takeDueReminders() {
    const now = localStamp();
    const due = data.tasks.filter(t => !t.done && !t.reminded && t.remind_at && t.remind_at <= now);
    for (const task of due) task.reminded = true;
    if (due.length) save();
    return due.map(({ id, title, remind_at }) => ({ id, title, remind_at }));
  },
};

export const goals = {
  active: () =>
    data.goals
      .filter(goal => goal.status === 'active')
      .map(goal => {
        const checkins = data.checkins.filter(c => c.goal_id === goal.id);
        const last = checkins.at(-1);
        return { ...goal, checkin_count: checkins.length, last_note: last?.note ?? null, last_checkin: last?.created_at ?? null };
      }),
  get: id => data.goals.find(goal => goal.id === id),
  add({ title, why = null, targetDate = null }) {
    data.goals.push({ id: nextId('goal'), title, why, target_date: targetDate, status: 'active', created_at: localStamp() });
    save();
  },
  setStatus(id, status) {
    const goal = goals.get(id);
    if (!goal) return false;
    goal.status = status;
    save();
    return true;
  },
  logProgress(goalId, note, rating = null) {
    data.checkins.push({ id: nextId('checkin'), goal_id: goalId, note, rating, created_at: localStamp() });
    save();
  },
};

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
  };
}

export function exportData() {
  return JSON.stringify({ app: 'vega', version: 1, exportedAt: new Date().toISOString(), ...data }, null, 2);
}

export function importData(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (!['vega', 'jarvis'].includes(parsed?.app)) throw new Error("That file isn't a Vega backup.");
  data = normalize(parsed);
  save();
}
