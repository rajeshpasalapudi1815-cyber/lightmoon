// Tools the model can call to change LightMoon's memory, tasks and goals, and to check the weather.
import { memories, tasks, goals, routines, MEMORY_CATEGORIES, GOAL_STATUSES } from './store.js';
import { normalizeTime, localStamp, prettyTime } from './time.js';
import { findPlace, placeFromDevice, savedPlace, savePlace, weatherSummary } from './weather.js';
import { LIFE_TOOLS, lifeHandlers, isConnected as lifeConnected } from './lifelevelling.js';
import { phoneTools, phoneHandlers } from './phone.js';
import { lookUp, headlines } from './knowledge.js';

// What the model sends when the user means "where I am" rather than naming a city.
const MEANS_HERE = /^(here|local|nearby)$|\b(my|current|this|our)\s+(location|city|place|area|town)\b|where i am/i;

function tool(name, description, properties, required = []) {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, ...(required.length && { required }) } } };
}

const ID = { type: 'string', description: 'The [#id] from your context, without the #.' };

export const TOOLS = [
  tool(
    'remember',
    'Save a lasting fact about the user (a preference, a person, a routine, an ambition). Not small talk or facts you have.',
    {
      content: { type: 'string', description: 'A short third-person sentence, e.g. "Prefers morning workouts."' },
      category: { type: 'string', enum: MEMORY_CATEGORIES },
    },
    ['content', 'category'],
  ),
  tool('forget', 'Delete a saved fact that is wrong or that they ask you to forget.', { id: ID }, ['id']),
  tool(
    'add_task',
    'Add a to-do. With remind_at, also write announcement.',
    {
      title: { type: 'string' },
      due_at: { type: 'string', description: 'Date or date and time.' },
      remind_at: { type: 'string', description: 'When to remind them.' },
      announcement: {
        type: 'string',
        description: 'What you will say when the reminder goes off, as at that moment, e.g. "Boss, you have a meeting at 5 o\'clock."',
      },
    },
    ['title'],
  ),
  tool('complete_task', 'Mark a task done.', { id: ID }, ['id']),
  tool('delete_task', 'Delete a task they no longer want.', { id: ID }, ['id']),
  tool(
    'add_goal',
    'Start tracking a goal.',
    { title: { type: 'string' }, why: { type: 'string', description: 'Why it matters, if they said.' }, target_date: { type: 'string' } },
    ['title'],
  ),
  tool(
    'log_goal_progress',
    'Log progress, effort or a setback on a goal.',
    { goal_id: ID, note: { type: 'string' }, rating: { type: 'integer', minimum: 1, maximum: 5, description: 'Optional, 5 = great.' } },
    ['goal_id', 'note'],
  ),
  tool(
    'set_goal_status',
    'Mark a goal achieved or dropped, or active again.',
    { goal_id: ID, status: { type: 'string', enum: GOAL_STATUSES } },
    ['goal_id', 'status'],
  ),
  tool('get_weather', "Today's weather: now, the range, and when rain is likely. The saved place unless they name a city.", { city: { type: 'string' } }),
  tool('set_weather_place', 'Save their city for the weather.', { city: { type: 'string' } }, ['city']),
  tool(
    'look_up',
    'Search Wikipedia for a fact you are unsure of or that may have changed. Pass a short topic ("Charminar"), not a question.',
    { topic: { type: 'string' } },
    ['topic'],
  ),
  tool('news_headlines', "Today's top world news.", {}),
  tool(
    'save_routine',
    'Save a routine: a phrase, and what to do when they say it. The same phrase again replaces it.',
    { trigger: { type: 'string', description: 'e.g. "good night"' }, steps: { type: 'string', description: 'In order, in plain words.' } },
    ['trigger', 'steps'],
  ),
  tool('delete_routine', 'Delete a routine.', { id: ID }, ['id']),
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
    const { title } = task; // removing empties the record
    tasks.remove(task.id);
    return `Deleted: ${title}`;
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

  async look_up({ topic }) {
    const what = toText(topic, 'topic', 200);
    return { text: `Looked up: ${what}`, result: await lookUp(what) };
  },

  async news_headlines() {
    return { text: 'Checked the news', result: await headlines() };
  },

  save_routine({ trigger, steps }) {
    const phrase = toText(trigger, 'trigger', 60).replace(/^["']|["']$/g, '');
    const isNew = routines.save({ trigger: phrase, steps: toText(steps, 'steps', 1000) });
    return `${isNew ? 'New routine' : 'Routine updated'}: "${phrase}"`;
  },

  delete_routine({ id }) {
    const routine = routines.get(toId(id));
    if (!routine) throw new Error(`There is no routine #${id}.`);
    const { trigger } = routine; // removing empties the record
    routines.remove(routine.id);
    return `Deleted the routine "${trigger}"`;
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
