// Tools the model can call to change LightMoon's memory, tasks and goals, and to check the weather.
import { memories, tasks, goals, MEMORY_CATEGORIES, GOAL_STATUSES } from './store.js';
import { normalizeTime, localStamp, prettyTime } from './time.js';
import { findPlace, placeFromDevice, savedPlace, savePlace, weatherSummary } from './weather.js';
import { LIFE_TOOLS, lifeHandlers, isConnected as lifeConnected } from './lifelevelling.js';
import { phoneTools, phoneHandlers } from './phone.js';

// What the model sends when the user means "where I am" rather than naming a city.
const MEANS_HERE = /^(here|local|nearby)$|\b(my|current|this|our)\s+(location|city|place|area|town)\b|where i am/i;

function tool(name, description, properties, required = []) {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } };
}

const ID = { type: 'string', description: 'The id shown as [#id] in your context, without the #, e.g. "k3x9q2".' };

export const TOOLS = [
  tool(
    'remember',
    'Save a lasting fact about the user: a preference, a person in their life, a routine, an ambition or an important detail. Skip small talk and facts you already have.',
    {
      content: { type: 'string', description: 'The fact as a short third-person sentence, e.g. "Prefers to work out in the morning."' },
      category: { type: 'string', enum: MEMORY_CATEGORIES },
    },
    ['content', 'category'],
  ),
  tool('forget', 'Delete a saved fact that is wrong or that the user asks you to forget.', { id: ID }, ['id']),
  tool(
    'add_task',
    'Add a to-do. Set remind_at when the user wants to be reminded at a particular time, and then also write announcement.',
    {
      title: { type: 'string', description: 'Short task title, e.g. "Call Mom".' },
      due_at: { type: 'string', description: 'Optional due date (YYYY-MM-DD) or time (YYYY-MM-DDTHH:MM), local time.' },
      remind_at: { type: 'string', description: 'Optional reminder time, local, format YYYY-MM-DDTHH:MM.' },
      announcement: {
        type: 'string',
        description: 'With remind_at: the one short sentence you will say out loud when the reminder goes off, addressing the user as they like, '
          + 'e.g. "Boss, you have a meeting at 5 o\'clock." or "Sir, time to call your mom." Speak as at that moment, not as now.',
      },
    },
    ['title'],
  ),
  tool('complete_task', 'Mark a task as done.', { id: ID }, ['id']),
  tool('delete_task', 'Delete a task the user no longer wants.', { id: ID }, ['id']),
  tool(
    'add_goal',
    'Start tracking a goal the user wants to achieve.',
    {
      title: { type: 'string', description: 'The goal, e.g. "Run 5 km without stopping".' },
      why: { type: 'string', description: 'Why it matters to them, if they said.' },
      target_date: { type: 'string', description: 'Optional target date, YYYY-MM-DD.' },
    },
    ['title'],
  ),
  tool(
    'log_goal_progress',
    'Record a check-in when the user reports progress, effort or a setback on one of their goals.',
    {
      goal_id: ID,
      note: { type: 'string', description: 'What happened, briefly.' },
      rating: { type: 'integer', minimum: 1, maximum: 5, description: 'Optional: how it went, from 1 (badly) to 5 (great).' },
    },
    ['goal_id', 'note'],
  ),
  tool(
    'set_goal_status',
    'Mark a goal achieved or dropped, or make it active again.',
    { goal_id: ID, status: { type: 'string', enum: GOAL_STATUSES } },
    ['goal_id', 'status'],
  ),
  tool(
    'get_weather',
    "Get today's weather: now, the day's range, and when rain is likely. Uses the user's saved place unless they name a city.",
    { city: { type: 'string', description: 'Optional city, e.g. "Hyderabad".' } },
  ),
  tool(
    'set_weather_place',
    'Save the city used for weather in daily briefings, when the user tells you where they are.',
    { city: { type: 'string', description: 'The city, e.g. "Hyderabad".' } },
    ['city'],
  ),
];

// The Life Levelling tools are offered only while Life Levelling is connected, the phone tools only in the
// Android app (and only for what the user has allowed).
export const currentTools = () => [...TOOLS, ...(lifeConnected() ? LIFE_TOOLS : []), ...phoneTools()];

function toId(value) {
  const id = String(value ?? '').trim().replace(/^\[?#/, '').replace(/\]$/, '');
  if (!/^[a-z0-9]{1,16}$/i.test(id)) throw new Error(`"${value}" is not a valid id.`);
  return id;
}

function toText(value, field, max) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${field} is required.`);
  return text.slice(0, max);
}

function toTime(value, field, options) {
  if (value == null || value === '') return null;
  const stamp = normalizeTime(value, options);
  if (!stamp) throw new Error(`Could not read ${field} "${value}". Use YYYY-MM-DDTHH:MM.`);
  return stamp;
}

function findTask(id) {
  const task = tasks.get(toId(id));
  if (!task) throw new Error(`There is no task #${id}.`);
  return task;
}

function findGoal(id) {
  const goal = goals.get(toId(id));
  if (!goal) throw new Error(`There is no goal #${id}.`);
  return goal;
}

// Each handler returns a short summary (shown as a chip under the reply), or an object with extras:
// `result` (what the model is told, when it differs from the chip) and `calendar` (a reminder to export).
const handlers = {
  remember({ content, category }) {
    const fact = toText(content, 'content', 300);
    memories.add(fact, MEMORY_CATEGORIES.includes(category) ? category : 'other');
    return `Remembered: ${fact}`;
  },

  forget({ id }) {
    if (!memories.remove(toId(id))) throw new Error(`There is no saved fact #${id}.`);
    return 'Forgot a saved fact';
  },

  add_task({ title, due_at, remind_at, announcement }) {
    const name = toText(title, 'title', 200);
    const remindAt = toTime(remind_at, 'remind_at', { requireTime: true });
    if (remindAt && remindAt < localStamp()) {
      throw new Error(`remind_at ${remindAt} is in the past; it is now ${localStamp()}.`);
    }
    const announce = remindAt && announcement ? String(announcement).trim().slice(0, 200) || null : null;
    tasks.add({ title: name, dueAt: toTime(due_at, 'due_at'), remindAt, announce });
    if (!remindAt) return `Task added: ${name}`;
    return { text: `Reminder set: ${name}, ${prettyTime(remindAt)}`, calendar: { title: name, at: remindAt } };
  },

  complete_task({ id }) {
    const task = findTask(id);
    tasks.complete(task.id);
    return `Done: ${task.title}`;
  },

  delete_task({ id }) {
    const task = findTask(id);
    tasks.remove(task.id);
    return `Deleted: ${task.title}`;
  },

  add_goal({ title, why, target_date }) {
    const name = toText(title, 'title', 200);
    goals.add({
      title: name,
      why: why ? String(why).trim().slice(0, 300) : null,
      targetDate: toTime(target_date, 'target_date')?.slice(0, 10) ?? null,
    });
    return `New goal: ${name}`;
  },

  log_goal_progress({ goal_id, note, rating }) {
    const goal = findGoal(goal_id);
    const score = Number(rating);
    goals.logProgress(goal.id, toText(note, 'note', 300), Number.isInteger(score) && score >= 1 && score <= 5 ? score : null);
    return `Progress logged: ${goal.title}`;
  },

  set_goal_status({ goal_id, status }) {
    if (!GOAL_STATUSES.includes(status)) throw new Error(`status must be one of: ${GOAL_STATUSES.join(', ')}.`);
    const goal = findGoal(goal_id);
    goals.setStatus(goal.id, status);
    const verb = { achieved: 'Goal achieved', dropped: 'Goal dropped', active: 'Goal reactivated' }[status];
    return `${verb}: ${goal.title}`;
  },

  async get_weather({ city }) {
    const named = city?.trim() && !MEANS_HERE.test(city.trim()) ? city.trim() : null;
    let place = named ? await findPlace(named) : savedPlace();
    if (!place) {
      // No city saved yet: ask the phone where it is (it shows a permission prompt the first time).
      try {
        place = await placeFromDevice();
      } catch (err) {
        throw new Error(`${err.message} Ask the user which city they are in, then use set_weather_place.`);
      }
      savePlace(place);
    }
    return { text: `Checked the weather: ${place.name}`, result: await weatherSummary(place) };
  },

  async set_weather_place({ city }) {
    const place = await findPlace(toText(city, 'city', 100));
    savePlace(place);
    return `Weather place: ${place.name}`;
  },

  ...lifeHandlers,
  ...phoneHandlers,
};

export async function runTool(name, rawArgs) {
  if (!Object.hasOwn(handlers, name)) return { ok: false, error: `Unknown tool "${name}".` };
  try {
    const args = typeof rawArgs === 'string' ? JSON.parse(rawArgs || '{}') : (rawArgs ?? {});
    const out = await handlers[name](args);
    const action = typeof out === 'string' ? { text: out } : out;
    return { ok: true, result: action.result ?? action.text, action };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
