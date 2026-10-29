// LightMoon's own model: a small model that learns from the big model's answers while the big model does the work.
// Collect (opt-in, per device): each finished exchange with the big model is kept on this device as a training
// example, without the PHONE section, phone tool use or anything that looks like a one-time code. Export: one
// JSONL file in the chat format with tool calls, ready for fine-tuning (see trainer/README.md).
// Shadow (computer only): the same request goes to our model on this computer (llama-server, 127.0.0.1:8080) in
// the background; nobody sees its answer, it only keeps score of how often it agrees, per kind of request.
// Once a kind is reliable (and the user allows it), our model answers that kind itself.
// The same agreement rule is in trainer/eval.py.
import { isNativeApp, fileSaver } from './native.js';
import { normalizeTime, today } from './time.js';

const PREFS_KEY = 'assistant.learning'; // per device, never synced or backed up
const DB_NAME = 'lightmoon-learning';
const MAX_EXAMPLES = 5000; // the most recent ones; about 15 KB each
const LOCAL_URL = 'http://127.0.0.1:8080/v1';
const TRUST_AGREEMENT = 0.95;
const TRUST_CASES = 50;
const SIMILAR_REPLY = 0.4; // share of words in common for two replies to count as saying much the same
const SIMILAR_TEXT = 0.5; // the same, for a text argument such as a task's title
const MODEL_CHECK_MS = 5 * 60_000; // how long "our model is (not) running" is believed
const SHADOW_TIMEOUT_MS = 180_000; // a laptop CPU reads a long prompt slowly, and nobody is waiting
const ROUTE_TIMEOUT_MS = 30_000; // someone is waiting: past this, the big model answers instead
const FAST_ENOUGH_SECONDS = 15; // a kind is handed over only if our model answers it this fast on average
const MAX_STEPS = 4; // answers compared per exchange
const MAX_QUEUE = 8;

// Phone data and one-time codes never go into a training example. The code rule is phone.js's, plus passwords.
const PHONE_SECTION = /\n\nPHONE \([\s\S]*$/; // the last section of the system prompt
const SECURITY_WORDS = /\b(otp|one[- ]?time|verification|security code|passcode|password|login code|auth\w* code|(?<!pin )code|pin(?!\s*code)|sign[- ]?in|log[- ]?in)\b/i;
const CODE_NUMBER = /(?<![\d:/.-])(\d{4,8}|\d{3}[- ]\d{3})(?![\d:/-])/g;
const BRIEFING_REQUEST = /^\(Automatic message: I just opened the app/; // brain.js's briefingRequest
const CARD_NUMBER = /\b(?:\d{4}[ -]?){3}\d{1,7}\b/g; // groups of four, so dates don't look like one

const KIND_NAMES = { talk: 'Just talking', 'after-tool': 'Confirming what it did', briefing: 'Spoken briefings', writing: 'Other writing' };

// ---------- Preferences and scores ----------

function readPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) || 'null') ?? {};
  } catch {
    return {};
  }
}

export function prefs() {
  const saved = readPrefs();
  return { collect: false, route: false, localUrl: LOCAL_URL, scores: {}, ...saved };
}

function savePrefs(changes) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...readPrefs(), ...changes }));
  } catch (err) {
    console.error('[learning] could not save:', err.message);
  }
}

// ---------- The examples, in their own IndexedDB database ----------

let opening = null;

function database() {
  opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('examples', { autoIncrement: true });
      request.result.createObjectStore('tools'); // every example offers much the same tools: kept once each
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      opening = null;
      reject(request.error);
    };
  });
  return opening;
}

// `action` may return a request, or a list of them: their results come back once the transaction is done.
async function transact(mode, action) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(['examples', 'tools'], mode);
    const requests = action(transaction.objectStore('examples'), transaction.objectStore('tools'));
    transaction.oncomplete = () => resolve(Array.isArray(requests) ? requests.map(request => request.result) : requests?.result);
    transaction.onerror = () => reject(transaction.error);
  });
}

// A short fingerprint of the tool list (cyrb53).
function fingerprint(text) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

function keep(exchange, tools) {
  const toolsKey = tools ? fingerprint(JSON.stringify(tools)) : null;
  return transact('readwrite', (examples, toolSets) => {
    if (tools) toolSets.put(tools, toolsKey);
    examples.add({ at: Date.now(), messages: exchange, tools: toolsKey });
    // Only the most recent MAX_EXAMPLES stay.
    const count = examples.count();
    count.onsuccess = () => {
      let extra = count.result - MAX_EXAMPLES;
      if (extra <= 0) return;
      examples.openCursor().onsuccess = event => {
        const cursor = event.target.result;
        if (!cursor || extra-- <= 0) return;
        cursor.delete();
        cursor.continue();
      };
    };
  });
}

export const exampleCount = () => transact('readonly', examples => examples.count());
export const deleteExamples = () => transact('readwrite', (examples, toolSets) => {
  examples.clear();
  toolSets.clear();
});

// One line per example: {"messages": [...], "tools": [...]}, OpenAI's fine-tuning format with tool calls.
export async function trainingFile() {
  const [examples, keys, sets] = await transact('readonly', (examplesStore, toolsStore) => [examplesStore.getAll(), toolsStore.getAllKeys(), toolsStore.getAll()]);
  const toolSets = new Map(keys.map((key, i) => [key, sets[i]]));
  return examples
    .map(({ messages, tools }) => JSON.stringify({ messages, ...(toolSets.has(tools) && { tools: toolSets.get(tools) }) }))
    .join('\n');
}

// ---------- Privacy ----------

const hideCodes = text => text
  .split('\n')
  .map(line => (SECURITY_WORDS.test(line) ? line.replace(CODE_NUMBER, '[code]') : line).replace(CARD_NUMBER, '[number]'))
  .join('\n');

// Tool arguments are JSON: only their text values are cleaned, so the JSON stays valid.
function hideCodesInArguments(json) {
  try {
    const clean = value => (typeof value === 'string' ? hideCodes(value)
      : Array.isArray(value) ? value.map(clean)
        : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clean(v)])) : value);
    return JSON.stringify(clean(JSON.parse(json || '{}')));
  } catch {
    return hideCodes(String(json ?? ''));
  }
}

const usesPhone = exchange => exchange.some(m => m.tool_calls?.some(call => call.function?.name?.startsWith('phone_')));

// Returns the exchange as it may be kept, or null if it must not be kept at all: anything that used the phone's
// tools (other people's calls, messages and calendar), and briefings given from the phone's data.
function cleaned(exchange, tools) {
  const system = exchange[0]?.role === 'system' ? exchange[0].content : '';
  if (usesPhone(exchange) || (!tools && PHONE_SECTION.test(system))) return null;
  return exchange.map(m => ({
    ...m,
    ...(typeof m.content === 'string' && { content: hideCodes(m.role === 'system' ? m.content.replace(PHONE_SECTION, '') : m.content) }),
    ...(m.tool_calls && {
      tool_calls: m.tool_calls.map(call => ({ ...call, function: { ...call.function, arguments: hideCodesInArguments(call.function?.arguments) } })),
    }),
  }));
}

// ---------- Hooks for brain.js ----------

// What our model answered in each conversation, by the position its answer takes: { modelId, answer, used }.
// Used answers are its own (nothing to learn from them); the others are scored without asking it again.
const tried = new WeakMap();

// After the big model has finished an exchange: keep it as an example, and on a computer, see what our model
// would have said. `convo` is everything the model was sent (with its tool calls and their results), `reply` its
// final message.
export function learnFrom(convo, tools, reply) {
  try {
    if (!prefs().collect) return;
    const attempts = tried.get(convo) ?? new Map();
    // Only the big model's answers are worth learning: where our model took over, the example stops at the big
    // model's last answer before that.
    const ours = [...attempts].filter(([, attempt]) => attempt.used).map(([at]) => at);
    const exchange = [...convo, { role: 'assistant', content: reply?.content ?? '' }].slice(0, Math.min(Infinity, ...ours));
    const end = exchange.findLastIndex(m => m.role === 'assistant');
    if (end <= exchange.findLastIndex(m => m.role === 'user')) return; // our model answered from the start
    const kept = cleaned(exchange.slice(0, end + 1), tools);
    if (!kept) return;
    keep(kept, tools).catch(err => console.error('[learning] could not keep an example:', err.message));
    if (!isNativeApp) shadow(kept, tools, attempts);
  } catch (err) {
    console.error('[learning]', err.message);
  }
}

// Before asking the big model: our model answers instead when the user allowed it and it has proven reliable at
// this kind of request. Returns its message, or null to let the big model answer (on any problem, too).
export async function answerLocally(convo, tools, onText) {
  const settings = prefs();
  if (isNativeApp || !settings.route) return null;
  const model = await localModel();
  if (!model || !trustedKinds(model.id).length) return null;
  try {
    const started = Date.now();
    const answer = await askLocal(model, convo, tools, ROUTE_TIMEOUT_MS);
    const seconds = (Date.now() - started) / 1000;
    const kinds = kindsOf(answer, { tools, afterTool: convo.at(-1)?.role === 'tool', convo });
    const used = kinds.every(kind => trustedKinds(model.id).includes(kind));
    if (!tried.has(convo)) tried.set(convo, new Map());
    tried.get(convo).set(convo.length, { modelId: model.id, answer, seconds, used });
    if (!used) return null;
    if (answer.content) onText?.(answer.content);
    return answer;
  } catch (err) {
    console.warn('[learning] our model could not answer, the big model will:', err.message);
    return null;
  }
}

// ---------- Our model on this computer ----------

let known = null; // { at, model }: the model llama-server has loaded, or null when it isn't running

export async function localModel({ fresh = false } = {}) {
  if (!fresh && known && Date.now() - known.at < MODEL_CHECK_MS) return known.model;
  let model = null;
  try {
    const res = await fetch(`${prefs().localUrl.replace(/\/+$/, '')}/models`, { signal: AbortSignal.timeout(3000) });
    const id = res.ok ? (await res.json()).data?.[0]?.id : null;
    if (id) model = { id: String(id).split(/[\\/]/).pop().replace(/\.gguf$/i, '') };
  } catch {
    // not running
  }
  known = { at: Date.now(), model };
  return model;
}

// The trainer names what it makes "lightmoon-YYYY-MM-DD..." (see trainer/); anything else is an untrained baseline.
export const trainedOn = modelId => /^lightmoon.*?(\d{4}-\d{2}-\d{2})/i.exec(modelId)?.[1] ?? null;

async function askLocal(model, convo, tools, timeout) {
  const body = {
    model: model.id,
    messages: convo,
    temperature: 0.2,
    max_tokens: 400,
    stream: false,
    chat_template_kwargs: { enable_thinking: false }, // Qwen3: answer straight away
    ...(tools && { tools, tool_choice: 'auto' }),
  };
  const res = await fetch(`${prefs().localUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`our model: ${res.status} ${(await res.text()).slice(0, 200)}`);
  const message = (await res.json()).choices?.[0]?.message;
  if (!message) throw new Error('our model returned no message');
  const content = String(message.content ?? '').replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
  const calls = (message.tool_calls ?? []).map((call, i) => ({
    id: call.id || `local_${Date.now().toString(36)}_${i}`,
    type: 'function',
    function: { name: call.function?.name ?? '', arguments: typeof call.function?.arguments === 'string' ? call.function.arguments : JSON.stringify(call.function?.arguments ?? {}) },
  }));
  return { role: 'assistant', content, ...(calls.length && { tool_calls: calls }) };
}

// ---------- Shadow comparison ----------

const queue = [];
let comparing = false;

// Each answer the big model gave in this exchange is one case: our model gets everything that came before it
// (unless it already answered that while being tried for the job).
function shadow(exchange, tools, attempts) {
  const lastUser = exchange.findLastIndex(m => m.role === 'user');
  const steps = exchange.flatMap((m, i) => (i > lastUser && m.role === 'assistant' ? [i] : [])).slice(0, MAX_STEPS);
  for (const i of steps) queue.push({ prefix: exchange.slice(0, i), expected: exchange[i], tools, attempt: attempts.get(i) });
  queue.splice(0, Math.max(0, queue.length - MAX_QUEUE)); // a backlog is dropped, oldest first
  compareQueued();
}

async function compareQueued() {
  if (comparing) return;
  comparing = true;
  try {
    while (queue.length) {
      const model = await localModel();
      if (!model) {
        queue.length = 0;
        break;
      }
      const { prefix, expected, tools, attempt } = queue.shift();
      try {
        const reuse = attempt?.modelId === model.id;
        const started = Date.now();
        const answer = reuse ? attempt.answer : await askLocal(model, prefix, tools, SHADOW_TIMEOUT_MS);
        const seconds = reuse ? attempt.seconds : (Date.now() - started) / 1000;
        score(model.id, compare(expected, answer, { tools, afterTool: prefix.at(-1)?.role === 'tool', convo: prefix }), seconds);
      } catch (err) {
        console.warn('[learning] shadow comparison skipped:', err.message);
        known = null; // check again whether it's running
      }
    }
  } finally {
    comparing = false;
  }
}

const toolNames = message => (message.tool_calls ?? []).map(call => call.function?.name ?? '').sort();

// What kind of answer this is: the tools it called, or else talking (after a tool: confirming what it did).
// Requests without tools are automatic ones from brain.js: the spoken briefing, or other writing (the weekly
// letter) that is never collected, so never scored and never handed to our model.
function kindsOf(message, { tools, afterTool, convo }) {
  const names = toolNames(message);
  if (names.length) return [...new Set(names.map(name => `tool:${name}`))];
  if (!tools) return [BRIEFING_REQUEST.test(convo.findLast(m => m.role === 'user')?.content) ? 'briefing' : 'writing'];
  return [afterTool ? 'after-tool' : 'talk'];
}

const words = text => new Set(String(text ?? '').toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []);

// How much two texts say the same thing: shared words over all words (Dice), from 0 to 1.
export function similarity(a, b) {
  const x = words(a);
  const y = words(b);
  if (!x.size && !y.size) return 1;
  let shared = 0;
  for (const word of x) if (y.has(word)) shared++;
  return (2 * shared) / (x.size + y.size);
}

const parseArgs = json => {
  try {
    return typeof json === 'string' ? JSON.parse(json || '{}') : json ?? {};
  } catch {
    return {};
  }
};

// The arguments that matter: the required ones and any time. Ids, numbers and choices must match exactly,
// times must mean the same minute, and text must say much the same.
function argumentsAgree(name, expectedJson, answerJson, tools) {
  const schema = tools?.find(t => t.function?.name === name)?.function?.parameters ?? {};
  const properties = schema.properties ?? {};
  const keys = new Set([...(schema.required ?? []), ...Object.keys(properties).filter(key => /(_at|_date|^start|^date)$/.test(key))]);
  const expected = parseArgs(expectedJson);
  const answer = parseArgs(answerJson);
  return [...keys].every(key => {
    const a = expected[key];
    const b = answer[key];
    if (a == null || a === '') return b == null || b === '';
    if (b == null) return false;
    const spec = properties[key] ?? {};
    if (/(_at|_date|^start|^date)$/.test(key)) return normalizeTime(String(a)) === normalizeTime(String(b));
    if (key === 'id' || key.endsWith('_id') || key === 'reply_to') return String(a).replace(/^\[?#/, '').replace(/\]$/, '') === String(b).replace(/^\[?#/, '').replace(/\]$/, '');
    if (spec.type === 'string' && !spec.enum) return similarity(a, b) >= SIMILAR_TEXT;
    return String(a).toLowerCase() === String(b).toLowerCase();
  });
}

// One case: did our model do what the big model did? Counted under every kind either of them chose, so a kind's
// score also drops when our model wrongly does that kind.
function compare(expected, answer, context) {
  const kinds = [...new Set([...kindsOf(expected, context), ...kindsOf(answer, context)])];
  const want = toolNames(expected);
  const got = toolNames(answer);
  let agree;
  let similar = null;
  if (want.length || got.length) {
    agree = want.join() === got.join() && want.every(name => {
      const a = expected.tool_calls.find(call => call.function?.name === name);
      const b = answer.tool_calls.find(call => call.function?.name === name);
      return argumentsAgree(name, a.function.arguments, b.function.arguments, context.tools);
    });
  } else {
    similar = similarity(expected.content, answer.content);
    agree = similar >= SIMILAR_REPLY;
  }
  return { kinds, agree, similar };
}

function score(modelId, { kinds, agree, similar }, seconds) {
  const { scores } = prefs();
  // Scores start again for each new model: a new model's reliability is unknown.
  const mine = scores[modelId] ?? { since: today(), kinds: {} };
  for (const kind of kinds) {
    const tally = (mine.kinds[kind] ??= { cases: 0, agreed: 0, similar: 0, talks: 0, seconds: 0 });
    tally.cases++;
    tally.seconds = (tally.seconds ?? 0) + seconds;
    if (agree) tally.agreed++;
    if (similar !== null) {
      tally.similar += similar;
      tally.talks++;
    }
  }
  savePrefs({ scores: { [modelId]: mine } }); // only the current model's are kept
  paintIfOpen();
}

const averageSeconds = tally => (tally.seconds ?? Infinity) / tally.cases;
const isReliable = tally => tally.cases >= TRUST_CASES && tally.agreed / tally.cases >= TRUST_AGREEMENT;
// Handed over only when it is right and also quick enough for someone waiting (a slow computer never qualifies).
const isTrusted = tally => isReliable(tally) && averageSeconds(tally) <= FAST_ENOUGH_SECONDS;

export function trustedKinds(modelId) {
  const kinds = prefs().scores[modelId]?.kinds ?? {};
  return Object.keys(kinds).filter(kind => isTrusted(kinds[kind]));
}

// ---------- Settings: AI brain -> Our own model ----------

const $ = selector => document.querySelector(selector);

function kindName(kind) {
  const name = KIND_NAMES[kind] ?? kind.replace(/^tool:/, '').replaceAll('_', ' ');
  return name.charAt(0).toUpperCase() + name.slice(1);
}

const prettyDate = stamp => new Date(`${stamp}T12:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

function paintIfOpen() {
  if ($('#settings')?.open && !$('.settings-page[data-page="ai"]')?.hidden) paint();
}

async function paint(message = '') {
  const settings = prefs();
  $('#learnCollect').checked = settings.collect;
  $('#learnStatus').textContent = message;
  let count = 0;
  try {
    count = await exampleCount();
  } catch (err) {
    $('#learnStatus').textContent = `Can't read the examples: ${err.message}`;
  }
  $('#learnCount').textContent = count
    ? `${count.toLocaleString('en-GB')} example${count === 1 ? '' : 's'} collected on this device (it keeps the latest ${MAX_EXAMPLES.toLocaleString('en-GB')}).`
    : settings.collect ? 'No examples yet: they arrive as you talk to LightMoon.' : 'Nothing collected.';
  $('#learnExport').disabled = !count;
  $('#learnDelete').disabled = !count;

  $('#ownModelBox').hidden = isNativeApp; // the comparison runs on a computer
  if (isNativeApp) return;
  $('#learnRoute').checked = settings.route;
  $('#ownModelUrl').value = settings.localUrl;
  const model = await localModel({ fresh: true });
  const trained = model && trainedOn(model.id);
  $('#ownModelInUse').textContent = !model
    ? 'Not running on this computer. Start it with "Start our model" in the LightMoon folder (see trainer/README.md).'
    : trained ? `In use: ${model.id}, last trained ${prettyDate(trained)}.` : `In use: ${model.id}, not trained on your answers yet (the starting point).`;
  const mine = model ? settings.scores[model.id] : null;
  const kinds = Object.entries(mine?.kinds ?? {}).sort(([, a], [, b]) => b.cases - a.cases);
  const list = $('#ownModelKinds');
  list.replaceChildren(...kinds.map(([kind, tally]) => {
    const row = document.createElement('div');
    row.className = 'perm-row';
    const text = document.createElement('span');
    text.className = 'perm-text';
    const name = document.createElement('span');
    name.className = 'perm-name';
    name.textContent = kindName(kind);
    const detail = document.createElement('small');
    const handles = !isReliable(tally) ? '' : !isTrusted(tally) ? '; reliable, but too slow to hand over'
      : settings.route ? '; it answers these itself' : '; reliable';
    const wording = tally.talks ? `; replies ${Math.round((100 * tally.similar) / tally.talks)}% alike` : '';
    const speed = Number.isFinite(averageSeconds(tally)) ? `; about ${Math.round(averageSeconds(tally))} s each` : '';
    detail.textContent = `agreed ${tally.agreed} of ${tally.cases}${wording}${speed}${handles}`;
    text.append(name, detail);
    const share = document.createElement('span');
    share.className = 'card-status';
    share.textContent = `${Math.round((100 * tally.agreed) / tally.cases)}%`;
    row.append(text, share);
    return row;
  }));
  list.hidden = !kinds.length;
  $('#ownModelScores').textContent = !model ? ''
    : kinds.length ? `How often it did what the big model did, since ${prettyDate(mine.since)}:`
      : settings.collect ? 'No comparisons yet: they appear after your next few questions.' : 'Turn on "Teach our own model" to start comparing.';
}

async function downloadTrainingData() {
  const name = `lightmoon-training-${today()}.jsonl`;
  try {
    const text = await trainingFile();
    if (fileSaver) {
      // The Android app: Android's own "Save to" screen.
      const { saved } = await fileSaver.save({ name, mimeType: 'application/jsonl', text });
      if (saved) paint('Saved.');
      return;
    }
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([text], { type: 'application/jsonl' }));
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
  } catch (err) {
    paint(`Couldn't make the file: ${err.message}`);
  }
}

async function deleteAll() {
  if (!confirm('Delete every example collected on this device? Your conversations and everything else stay.')) return;
  try {
    await deleteExamples();
    paint('Deleted.');
  } catch (err) {
    paint(`Couldn't delete: ${err.message}`);
  }
}

export function wireLearning() {
  if (!$('#ownModelCard')) return;
  $('.menu-item[data-page="ai"]')?.addEventListener('click', () => paint());
  $('#learnCollect').addEventListener('change', event => {
    savePrefs({ collect: event.target.checked });
    paint();
  });
  $('#learnRoute').addEventListener('change', event => {
    savePrefs({ route: event.target.checked });
    paint();
  });
  $('#ownModelUrl').addEventListener('change', event => {
    savePrefs({ localUrl: event.target.value.trim().replace(/\/+$/, '') || LOCAL_URL });
    known = null;
    paint();
  });
  $('#learnExport').addEventListener('click', downloadTrainingData);
  $('#learnDelete').addEventListener('click', deleteAll);
}
