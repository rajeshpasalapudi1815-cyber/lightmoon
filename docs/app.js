// LightMoon app: runs entirely on this device. Chat, voice, memory, tasks, goals and reminders are all
// handled here; the only thing sent over the internet is the conversation, to the AI service.
import * as store from './js/store.js';
import * as lock from './js/lock.js';
import * as weather from './js/weather.js';
import { chat, briefing } from './js/brain.js';
import { localStamp, today, isPast, toDate } from './js/time.js';

const $ = selector => document.querySelector(selector);
const transcript = $('#transcript');
const input = $('#input');
const statusEl = $('#status');

const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
const isTouch = matchMedia('(pointer: coarse)').matches;
const LANGUAGES = [
  ['en-US', 'English (US)'],
  ['en-GB', 'English (UK)'],
  ['en-IN', 'English (India)'],
  ['en-AU', 'English (Australia)'],
  ['hi-IN', 'Hindi'],
  ['te-IN', 'Telugu'],
  ['ta-IN', 'Tamil'],
];
// Most natural-sounding voices first: Edge's natural British voices, then Chrome's and Apple's.
const PREFERRED_VOICES = ['Microsoft Ryan Online', 'Microsoft Thomas Online', 'Google UK English Male', 'Microsoft George', 'Daniel'];
const PREFS_KEY = 'assistant.prefs';
const REMINDER_POLL_MS = 15_000;
const LATE_REMINDER_MINUTES = 5;
const RELOCK_AFTER_MS = 3 * 60_000; // with the app lock on, ask again after this long in the background
const MAX_SHARED_CHARS = 6000;

const prefs = loadPrefs();
const launch = readLaunchParams();
let state = null; // latest snapshot from the store
let busy = false; // waiting for the AI
let started = false; // user has tapped Initialize
let locked = false; // the lock screen is showing
let hiddenAt = 0; // when the app last went into the background
let pendingShare = null; // shared content the next question is about
let audioCtx = null;

// ---------- Small helpers ----------

function loadPrefs() {
  const lang = LANGUAGES.find(([code]) => code === navigator.language)?.[0] ?? 'en-US';
  const defaults = { voice: '', rate: 1, speak: true, lang, handsFree: false };
  try {
    // Move preferences saved under the app's earlier names.
    for (const oldKey of ['vega.prefs', 'jarvis.prefs']) {
      const old = localStorage.getItem(oldKey);
      if (old !== null && localStorage.getItem(PREFS_KEY) === null) localStorage.setItem(PREFS_KEY, old);
      localStorage.removeItem(oldKey);
    }
    return { ...defaults, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') };
  } catch {
    return defaults;
  }
}

// What the app was opened for: a home-screen shortcut (?action=...) or something shared from another app.
function readLaunchParams() {
  const params = new URLSearchParams(location.search);
  const [title, text, url] = ['title', 'text', 'url'].map(name => params.get(name)?.trim() ?? '');
  // Apps often repeat the title as the text, or the link inside the text; keep each piece once.
  const shared = [title !== text && title, text, !text.includes(url) && url].filter(Boolean);
  if (location.search) history.replaceState(null, '', location.pathname);
  return { action: params.get('action'), shared: shared.join('\n').slice(0, MAX_SHARED_CHARS) };
}

function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Private browsing: preferences last for this visit only.
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

const assistantName = () => state?.profile.assistantName || 'LightMoon';

function addressWord() {
  const p = state?.profile;
  if (!p) return 'sir';
  return p.address === 'name' ? p.userName || 'friend' : p.address;
}

function formatWhen(stamp) {
  if (!stamp) return '';
  const date = toDate(stamp);
  if (Number.isNaN(date.getTime())) return stamp;
  const now = new Date();
  const days = Math.round((new Date(date).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / 86_400_000);
  const day =
    days === 0 ? 'today'
    : days === 1 ? 'tomorrow'
    : days === -1 ? 'yesterday'
    : date.toLocaleDateString(undefined, {
        weekday: 'short', day: 'numeric', month: 'short',
        ...(date.getFullYear() !== now.getFullYear() && { year: 'numeric' }),
      });
  return stamp.length === 10 ? day : `${day} ${date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}

// A Google Calendar link for a reminder, so the phone can alert you even when LightMoon is closed.
function calendarUrl(title, at) {
  const compact = stamp => `${stamp.replace(/[-:]/g, '')}00`;
  const end = localStamp(new Date(toDate(at).getTime() + 15 * 60_000));
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return 'https://calendar.google.com/calendar/render?action=TEMPLATE'
    + `&text=${encodeURIComponent(title)}&dates=${compact(at)}/${compact(end)}`
    + `&details=${encodeURIComponent('Reminder from LightMoon')}&ctz=${encodeURIComponent(timeZone)}`;
}

function calendarLink(className, label, title, at) {
  const link = el('a', className, label);
  link.href = calendarUrl(title, at);
  link.target = '_blank';
  link.rel = 'noopener';
  link.title = 'Add to Google Calendar';
  return link;
}

async function notify(title, body) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    // Android only allows notifications through the service worker.
    const registration = await navigator.serviceWorker?.getRegistration();
    if (registration) await registration.showNotification(title, { body, icon: 'icons/icon-192.png', tag: 'lightmoon-reminder' });
    else new Notification(title, { body, icon: 'icons/icon-192.png' });
  } catch {
    // Notifications are a bonus; the spoken reminder still happens.
  }
}

// ---------- Transcript and status ----------

function addMessage(kind, text, actions = []) {
  const node = el('div', `msg ${kind}`);
  if (kind.startsWith('assistant')) node.dataset.who = assistantName().toUpperCase();
  node.append(el('div', 'msg-text', text));
  addActions(node, actions);
  transcript.append(node);
  transcript.scrollTop = transcript.scrollHeight;
  return node;
}

function addActions(node, actions) {
  if (!actions.length) return;
  const row = el('div', 'actions');
  for (const action of actions) {
    row.append(el('span', 'action-chip', action.text));
    if (action.calendar) row.append(calendarLink('action-chip chip-link', 'Add to Google Calendar', action.calendar.title, action.calendar.at));
  }
  node.append(row);
}

const note = text => addMessage('system', text);

// Index just past the last finished sentence (or line), or -1 if there is none yet.
function lastSentenceEnd(text) {
  let end = -1;
  for (const match of text.matchAll(/[.!?]["')\]]*\s+|\n+/g)) end = match.index + match[0].length;
  return end;
}

// Shows a reply while it is still arriving and speaks each sentence as soon as it is complete.
function streamReply() {
  let node = null;
  let shown = '';
  let unspoken = '';
  const generation = speaker.generation; // if the user stops the speech, stay quiet for the rest of this reply
  const say = text => {
    if (speaker.generation === generation) speaker.speak(text);
  };
  const bubble = () => (node ??= addMessage('assistant', ''));
  return {
    push(delta) {
      shown += delta;
      bubble().querySelector('.msg-text').textContent = shown.trimStart();
      transcript.scrollTop = transcript.scrollHeight;
      unspoken += delta;
      const end = lastSentenceEnd(unspoken);
      if (end > 0) {
        say(unspoken.slice(0, end));
        unspoken = unspoken.slice(end);
      }
    },
    done(out) {
      if (out.error) {
        addMessage('assistant error', out.reply);
        say(out.reply);
        return;
      }
      const target = bubble();
      target.querySelector('.msg-text').textContent = out.reply;
      addActions(target, out.actions);
      say(shown.trim() ? unspoken : out.reply);
      transcript.scrollTop = transcript.scrollHeight;
    },
  };
}

// Something was shared to LightMoon from another app: offer quick things to do with it.
function offerShared(text) {
  const preview = text.length > 280 ? `${text.slice(0, 280)}…` : text;
  const node = addMessage('shared', `Shared with ${assistantName()}:\n${preview}`);
  const row = el('div', 'actions');
  const option = (label, onClick) => {
    const button = el('button', 'action-chip chip-button', label);
    button.type = 'button';
    button.addEventListener('click', () => {
      row.remove();
      onClick();
    });
    row.append(button);
  };
  option('Remember this', () => send('Please remember this.', { context: text }));
  option('Make it a task', () => send('Add this as a task.', { context: text }));
  if (text.length > 200) option('Summarize', () => send('Summarize this for me in a few sentences.', { context: text }));
  option('Ask about it', () => {
    pendingShare = text;
    input.placeholder = 'What would you like to know about it?';
    input.focus();
  });
  node.append(row);
  transcript.scrollTop = transcript.scrollHeight;
}

// Recomputes what the core shows, and starts or stops wake-word listening to match.
function refresh() {
  listener.sync();
  let mode = 'idle';
  if (listener.capturing) mode = 'listening';
  else if (speaker.active) mode = 'speaking';
  else if (busy) mode = 'thinking';
  document.body.dataset.state = mode;
  const idle = !state?.ai.ready
    ? 'Offline: add an API key in settings'
    : prefs.handsFree ? `Say "${assistantName()}" to wake me` : 'Standing by';
  statusEl.textContent = { idle, listening: 'Listening...', thinking: 'Thinking...', speaking: 'Speaking...' }[mode];
}

function chime() {
  try {
    audioCtx ??= new AudioContext();
    const t = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.setValueAtTime(880, t);
    osc.frequency.exponentialRampToValueAtTime(1320, t + 0.12);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.15, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + 0.3);
  } catch {
    // Sound is a nicety; ignore browsers that refuse.
  }
}

// ---------- Talking back (speech synthesis) ----------

function forSpeech(text) {
  return String(text)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'the link')
    .replace(/[*_`#>|~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const speaker = {
  active: false,
  pending: 0,
  generation: 0, // bumped by stop() so callbacks from cancelled speech are ignored
  voices: [],
  watchdog: null,

  pickVoice(name = prefs.voice) {
    const chosen = name && this.voices.find(v => v.name === name);
    if (chosen) return chosen;
    for (const preferred of PREFERRED_VOICES) {
      const hit = this.voices.find(v => v.name.startsWith(preferred));
      if (hit) return hit;
    }
    return this.voices.find(v => v.lang.replace('_', '-') === 'en-GB') || this.voices.find(v => v.lang.startsWith('en')) || null;
  },

  speak(text, { voice = prefs.voice, rate = prefs.rate, force = false } = {}) {
    if ((!prefs.speak && !force) || !('speechSynthesis' in window)) return;
    const clean = forSpeech(text);
    if (!clean) return;
    const chosen = this.pickVoice(voice);
    const generation = this.generation;
    // Chrome cuts off long utterances, so speak one sentence at a time.
    const sentences = (clean.match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g) ?? [clean]).map(s => s.trim()).filter(Boolean);
    for (const sentence of sentences) {
      const utterance = new SpeechSynthesisUtterance(sentence);
      if (chosen) {
        utterance.voice = chosen;
        utterance.lang = chosen.lang;
      }
      utterance.rate = rate;
      utterance.onend = utterance.onerror = () => {
        if (generation !== this.generation) return;
        this.pending = Math.max(0, this.pending - 1);
        if (!this.pending) this.finish();
      };
      this.pending++;
      speechSynthesis.speak(utterance);
    }
    this.active = true;
    // Some browsers occasionally skip the "end" event; don't stay stuck in speaking mode.
    clearInterval(this.watchdog);
    this.watchdog = setInterval(() => {
      if (!speechSynthesis.speaking && !speechSynthesis.pending) this.finish();
    }, 1500);
    refresh();
  },

  finish() {
    clearInterval(this.watchdog);
    this.pending = 0;
    if (!this.active) return;
    this.active = false;
    refresh();
  },

  stop() {
    this.generation++;
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    this.finish();
  },
};

if ('speechSynthesis' in window) {
  speaker.voices = speechSynthesis.getVoices();
  speechSynthesis.addEventListener('voiceschanged', () => {
    speaker.voices = speechSynthesis.getVoices();
  });
}

// ---------- Listening (speech recognition) ----------

// Speech recognition may write "LightMoon" as "light moon", "lightmoon" or "light-moon", so accept all of them.
function wakeWords() {
  const name = assistantName();
  const spaced = name.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  const words = new Set([name.toLowerCase(), spaced, spaced.replaceAll(' ', '-')]);
  if (spaced === 'light moon') words.add('lite moon');
  return [...words];
}

const listener = {
  rec: null,
  mode: null, // 'ptt' = tap to talk, 'wake' = always listening for the wake word
  capturing: false, // a command is being captured right now
  armTimer: null,

  start(mode) {
    this.stopRec();
    const rec = new SpeechRec();
    rec.lang = prefs.lang;
    rec.continuous = mode === 'wake';
    rec.interimResults = true;
    rec.onresult = event => this.onResult(event);
    rec.onerror = event => this.onError(event);
    rec.onend = () => this.onEnd(rec);
    this.rec = rec;
    this.mode = mode;
    this.capturing = mode === 'ptt';
    try {
      rec.start();
    } catch {
      this.rec = null;
      this.mode = null;
      this.capturing = false;
    }
  },

  stopRec() {
    const rec = this.rec;
    this.rec = null;
    this.mode = null;
    if (rec) {
      try { rec.abort(); } catch { /* already stopped */ }
    }
  },

  pushToTalk() {
    if (!SpeechRec) return note('Voice input needs Chrome or Edge. You can still type.');
    if (speaker.active) speaker.stop(); // a tap always silences, even while a reply is still arriving
    if (busy) return;
    if (this.mode === 'ptt') {
      this.stopRec();
      this.capturing = false;
    } else {
      this.start('ptt');
    }
    refresh();
  },

  onResult(event) {
    let interim = '';
    let final = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (result.isFinal) final += result[0].transcript;
      else interim += result[0].transcript;
    }
    if (this.mode === 'ptt') {
      input.value = (final || interim).trim();
      if (final.trim()) {
        this.capturing = false;
        input.value = '';
        send(final.trim());
      }
      return;
    }
    if (this.capturing && interim) statusEl.textContent = interim;
    if (final.trim()) this.heard(final.trim());
  },

  // Wake-word mode: "LightMoon, what's on today?" runs straight away; "LightMoon." alone waits for the next phrase.
  heard(text) {
    if (this.capturing) {
      this.capturing = false;
      clearTimeout(this.armTimer);
      send(text);
      return;
    }
    const lower = text.toLowerCase();
    const word = wakeWords().find(w => lower.includes(w));
    if (!word) return;
    const command = text.slice(lower.indexOf(word) + word.length).replace(/^[\s,.!?]+/, '').trim();
    if (command) return send(command);
    this.capturing = true;
    chime();
    refresh();
    clearTimeout(this.armTimer);
    this.armTimer = setTimeout(() => {
      if (this.capturing && this.mode === 'wake') {
        this.capturing = false;
        refresh();
      }
    }, 8000);
  },

  onError(event) {
    const problems = {
      'not-allowed': 'Microphone access is blocked. Allow the microphone for LightMoon in your browser or app settings, then try again.',
      'service-not-allowed': 'Speech recognition is not available in this browser. Try Chrome or Edge.',
      'audio-capture': 'No microphone was found.',
      network: 'Speech recognition needs an internet connection.',
    };
    const problem = problems[event.error];
    if (!problem) return; // 'no-speech' and 'aborted' are normal
    note(problem);
    if (prefs.handsFree) {
      prefs.handsFree = false;
      savePrefs();
      paintHandsFree();
    }
  },

  onEnd(rec) {
    if (rec !== this.rec) return; // we stopped it ourselves
    const wasWake = this.mode === 'wake';
    this.rec = null;
    this.mode = null;
    if (!wasWake) this.capturing = false;
    // Browsers end continuous recognition every so often; refresh() restarts it if it's still wanted.
    setTimeout(refresh, wasWake ? 300 : 0);
  },

  sync() {
    if (!started || !SpeechRec || this.mode === 'ptt') return;
    const wanted = prefs.handsFree && !busy && !speaker.active && !document.hidden && !locked;
    if (wanted && !this.rec) this.start('wake');
    if (!wanted && this.mode === 'wake') {
      this.stopRec();
      this.capturing = false;
    }
  },
};

// ---------- Conversation ----------

// `context` is shared content the message is about (from "Share to LightMoon").
async function send(text, { context = null } = {}) {
  text = text.trim();
  if (!text || busy) return;
  context ??= pendingShare;
  pendingShare = null;
  input.placeholder = 'Type a message, or tap the core to talk';
  if (speaker.active) speaker.stop();
  addMessage('user', text);
  busy = true;
  refresh();
  try {
    const live = streamReply();
    const out = await chat(context ? `${text}\n\nShared content:\n${context}` : text, { onText: live.push });
    live.done(out);
    applyState();
  } finally {
    busy = false;
    refresh();
  }
}

// One AI briefing per day (unless asked for); later launches get a short greeting instead.
async function runBriefing(force = false) {
  if (!state.ai.ready) return;
  if (!force && store.settings.get('last_briefing') === today()) {
    speaker.speak(`Welcome back, ${addressWord()}.`);
    return;
  }
  busy = true;
  refresh();
  try {
    const live = streamReply();
    const out = await briefing({ onText: live.push });
    if (!out.error) store.settings.set('last_briefing', today());
    live.done(out);
  } finally {
    busy = false;
    refresh();
  }
}

function pollReminders() {
  const due = store.tasks.takeDueReminders();
  if (!due.length) return;
  for (const reminder of due) {
    const minutesLate = (Date.now() - toDate(reminder.remind_at).getTime()) / 60_000;
    const late = minutesLate > LATE_REMINDER_MINUTES;
    addMessage('reminder', late ? `Missed reminder (${formatWhen(reminder.remind_at)}): ${reminder.title}` : `Reminder: ${reminder.title}`);
    speaker.speak(
      late
        ? `${addressWord()}, you had a reminder earlier: ${reminder.title}.`
        : `Pardon the interruption, ${addressWord()}. A reminder: ${reminder.title}.`,
      { force: true },
    );
    if (document.hidden) notify(`${assistantName()} reminder`, reminder.title);
  }
  applyState();
}

// ---------- Panels ----------

function applyState() {
  state = store.snapshot();
  $('#brandName').textContent = assistantName().toUpperCase();
  document.title = assistantName();
  document.body.classList.toggle('offline', !state.ai.ready);
  renderTasks();
  renderGoals();
  renderMemories();
  refresh();
}

function iconButton(className, symbol, label, onClick) {
  const button = el('button', className, symbol);
  button.title = label;
  button.setAttribute('aria-label', label);
  button.addEventListener('click', () => {
    onClick();
    applyState();
  });
  return button;
}

function renderTasks() {
  const list = $('#taskList');
  list.replaceChildren();
  const count = $('#taskCount');
  count.textContent = state.tasks.length;
  count.hidden = !state.tasks.length;
  if (!state.tasks.length) list.append(el('li', 'empty', 'No open tasks. Try: "Remind me to call Mom at 6 pm."'));

  for (const task of state.tasks) {
    const item = el('li', `item${isPast(task.due_at) || isPast(task.remind_at) ? ' overdue' : ''}`);
    const main = el('div', 'item-main');
    main.append(el('div', 'item-title', task.title));
    const meta = [task.due_at && `Due ${formatWhen(task.due_at)}`, task.remind_at && `Reminder ${formatWhen(task.remind_at)}`]
      .filter(Boolean)
      .join(' · ');
    if (meta) main.append(el('div', 'item-meta', meta));
    const actions = el('div', 'item-actions');
    if (task.remind_at && !isPast(task.remind_at)) actions.append(calendarLink('mini cal', '+ Cal', task.title, task.remind_at));
    actions.append(iconButton('del', '×', `Delete "${task.title}"`, () => store.tasks.remove(task.id)));
    item.append(iconButton('tick', '', `Mark "${task.title}" done`, () => store.tasks.complete(task.id)), main, actions);
    list.append(item);
  }

  const done = $('#doneList');
  done.replaceChildren();
  if (state.doneToday.length) {
    done.append(el('div', 'section-label', 'Done today'));
    for (const task of state.doneToday) done.append(el('div', 'done-item', task.title));
  }
}

function renderGoals() {
  const list = $('#goalList');
  list.replaceChildren();
  if (!state.goals.length) list.append(el('li', 'empty', 'No goals yet. Tell me one: "I want to run 5 km by December."'));

  for (const goal of state.goals) {
    const item = el('li', 'item');
    const main = el('div', 'item-main');
    main.append(el('div', 'item-title', goal.title));
    const meta = [goal.why && `Why: ${goal.why}`, goal.target_date && `Target ${formatWhen(goal.target_date)}`].filter(Boolean).join(' · ');
    if (meta) main.append(el('div', 'item-meta', meta));
    const progress = goal.checkin_count
      ? `${goal.checkin_count} check-in${goal.checkin_count > 1 ? 's' : ''} · last ${formatWhen(goal.last_checkin)}: ${goal.last_note}`
      : "No check-ins yet. Tell me how it's going.";
    main.append(el('div', 'item-meta', progress));

    const actions = el('div', 'item-actions');
    actions.append(
      iconButton('mini', '✓', `Mark "${goal.title}" achieved`, () => store.goals.setStatus(goal.id, 'achieved')),
      iconButton('del', '×', `Drop "${goal.title}"`, () => store.goals.setStatus(goal.id, 'dropped')),
    );
    item.append(main, actions);
    list.append(item);
  }
}

function renderMemories() {
  const list = $('#memoryList');
  list.replaceChildren();
  if (!state.memories.length) {
    list.append(el('li', 'empty', "Nothing yet. As we talk I'll remember what matters: your preferences, people, routines and ambitions."));
  }
  for (const memory of state.memories) {
    const item = el('li', 'item');
    const main = el('div', 'item-main');
    main.append(el('div', 'tag', memory.category), el('div', 'item-title', memory.content));
    item.append(main, iconButton('del', '×', 'Forget this', () => store.memories.remove(memory.id)));
    list.append(item);
  }
}

function renderHistory() {
  transcript.replaceChildren();
  for (const message of store.messages.recent(40)) addMessage(message.role, message.content);
}

// ---------- Settings ----------

function fillVoices(select) {
  select.replaceChildren(el('option', '', 'Automatic (best British voice)'));
  select.firstChild.value = '';
  const voices = [...speaker.voices].sort(
    (a, b) => Number(b.lang.startsWith('en')) - Number(a.lang.startsWith('en')) || a.name.localeCompare(b.name),
  );
  for (const voice of voices) {
    const option = el('option', '', `${voice.name} (${voice.lang})`);
    option.value = voice.name;
    select.append(option);
  }
  select.value = prefs.voice;
}

function fillAiFields(fields, ai) {
  fields.baseUrl.value = ai.baseUrl;
  fields.model.value = ai.model;
  fields.fallbackModel.value = ai.fallbackModel;
}

function openSettings() {
  const fields = $('#settingsForm').elements;
  fields.userName.value = state.profile.userName;
  fields.address.value = state.profile.address;
  fields.assistantName.value = state.profile.assistantName;
  fields.rate.value = prefs.rate;
  fields.speak.checked = prefs.speak;
  fields.lang.value = prefs.lang;
  fields.apiKey.value = '';
  fillAiFields(fields, store.aiConfig());
  fillVoices(fields.voice);
  $('#modelInfo').textContent = `Brain: ${state.ai.model} via ${state.ai.provider}${state.ai.hasKey ? '' : ' (no API key yet)'}.`;
  $('#settingsError').textContent = '';
  paintWeatherSettings();
  paintLockSettings();
  $('#settings').showModal();
}

// ---------- Weather settings ----------

function paintWeatherSettings(message) {
  const place = weather.savedPlace();
  $('#weatherCity').value = '';
  $('#weatherClear').hidden = !place;
  $('#weatherStatus').textContent = message
    ?? (place ? `Briefings include the weather for ${place.name}.` : 'Add your city to hear the weather in your daily briefing.');
}

async function setWeatherPlace(locate) {
  $('#weatherStatus').textContent = 'Looking that up...';
  try {
    const place = await locate();
    weather.savePlace(place);
    paintWeatherSettings(`Saved. ${await weather.weatherSummary(place)}`);
  } catch (err) {
    $('#weatherStatus').textContent = err.message;
  }
}

// ---------- App lock ----------

async function paintLockSettings() {
  const enabled = lock.isEnabled();
  $('#lockStatus').textContent = enabled ? `On: PIN${lock.hasBiometric() ? ' and fingerprint' : ''}` : 'Off';
  $('#lockPin').textContent = enabled ? 'Change PIN' : 'Turn on';
  $('#lockOff').hidden = !enabled;
  $('#pinSetup').hidden = true;
  $('#newPin').value = '';
  $('#newPin2').value = '';
  $('#lockBio').hidden = !enabled || lock.hasBiometric() || !(await lock.biometricAvailable());
}

async function saveNewPin() {
  const pin = $('#newPin').value.trim();
  const error = $('#settingsError');
  if (pin !== $('#newPin2').value.trim()) return void (error.textContent = "The two PINs don't match.");
  try {
    await lock.setPin(pin);
  } catch (err) {
    error.textContent = err.message;
    return;
  }
  error.textContent = '';
  await paintLockSettings();
  note(`App lock is on. ${assistantName()} will ask for your PIN when it opens and after a few minutes away.`);
}

async function addFingerprint() {
  try {
    await lock.enrollBiometric(state.profile.userName);
    $('#settingsError').textContent = '';
  } catch {
    $('#settingsError').textContent = "Couldn't set up fingerprint unlock. Your PIN still works.";
  }
  paintLockSettings();
}

function turnLockOff() {
  if (!confirm(`Turn off the app lock? Anyone using this phone could open ${assistantName()}.`)) return;
  lock.disable();
  paintLockSettings();
}

function showLock() {
  locked = true;
  speaker.stop();
  listener.stopRec();
  listener.capturing = false;
  const boot = $('#boot');
  boot.hidden = false;
  boot.classList.remove('leaving');
  $('#bootBtn').hidden = true;
  $('#lockForm').hidden = false;
  $('#lockForm').reset();
  $('#lockError').textContent = '';
  $('#bioUnlock').hidden = !lock.hasBiometric();
  if (!lock.hasBiometric()) $('#lockForm').elements.pin.focus();
}

function unlocked() {
  locked = false;
  $('#lockForm').hidden = true;
  if (!started) return start();
  $('#boot').classList.add('leaving');
  setTimeout(() => { $('#boot').hidden = true; }, 600);
  pollReminders();
  refresh();
}

async function unlockWithPin(event) {
  event.preventDefault();
  try {
    if (await lock.checkPin(event.target.elements.pin.value.trim())) return unlocked();
    $('#lockError').textContent = 'Wrong PIN.';
  } catch (err) {
    $('#lockError').textContent = err.message;
  }
  event.target.elements.pin.select();
}

async function unlockWithFingerprint() {
  try {
    await lock.unlockWithBiometric();
    unlocked();
  } catch {
    $('#lockError').textContent = "Fingerprint didn't work. Use your PIN.";
  }
}

function eraseAfterForgottenPin() {
  const name = assistantName();
  if (!confirm(`Forgot your PIN? The only way back in is to erase ${name} on this device: memories, tasks, goals and chats.`)) return;
  if (!confirm(`Erase everything ${name} knows on this device? This can't be undone. You can restore a backup afterwards.`)) return;
  store.eraseEverything();
  location.reload();
}

function saveSettings(event) {
  event.preventDefault();
  const fields = event.target.elements;
  const error = $('#settingsError');

  const apiKey = fields.apiKey.value.trim();
  if (/\s/.test(apiKey)) return void (error.textContent = "That API key doesn't look right. Copy it again.");
  const baseUrl = fields.baseUrl.value.trim();
  if (!/^https?:\/\/[^\s]+$/.test(baseUrl)) return void (error.textContent = 'The API address must start with https://');

  const langChanged = fields.lang.value !== prefs.lang;
  Object.assign(prefs, {
    voice: fields.voice.value,
    rate: Number(fields.rate.value),
    speak: fields.speak.checked,
    lang: fields.lang.value,
  });
  savePrefs();
  store.saveProfile({ userName: fields.userName.value, address: fields.address.value, assistantName: fields.assistantName.value });
  store.saveAiConfig({
    baseUrl,
    model: fields.model.value.trim(),
    fallbackModel: fields.fallbackModel.value.trim(),
    ...(apiKey && { apiKey }),
  });
  applyState();
  $('#settings').close();
  if (langChanged && listener.mode === 'wake') {
    listener.stopRec();
    refresh();
  }
}

function downloadBackup() {
  const link = el('a');
  link.href = URL.createObjectURL(new Blob([store.exportData()], { type: 'application/json' }));
  link.download = `lightmoon-backup-${today()}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
}

async function restoreBackup(event) {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file || !confirm('Replace everything LightMoon knows on this device with this backup?')) return;
  try {
    store.importData(await file.text());
  } catch (err) {
    $('#settingsError').textContent = err.message;
    return;
  }
  $('#settings').close();
  applyState();
  renderHistory();
  note('Backup restored.');
}

function paintHandsFree() {
  const button = $('#handsFreeBtn');
  button.setAttribute('aria-pressed', String(prefs.handsFree));
  button.replaceChildren('Wake', el('span', 'wide-only', ' word'), `: ${prefs.handsFree ? 'on' : 'off'}`);
}

function toggleHandsFree() {
  if (!SpeechRec) return note('Voice input needs Chrome or Edge.');
  prefs.handsFree = !prefs.handsFree;
  savePrefs();
  paintHandsFree();
  if (prefs.handsFree) {
    note(`Wake word on. Say "${assistantName()}" and then your request, e.g. "${assistantName()}, what's on my list today?"`);
    if (isTouch) note('On phones the microphone may beep each time it restarts and uses more battery. Tapping the core works best.');
  }
  refresh();
}

// ---------- Start-up ----------

function wireUp() {
  $('#composer').addEventListener('submit', event => {
    event.preventDefault();
    const text = input.value;
    input.value = '';
    send(text);
  });
  $('#core').addEventListener('click', () => listener.pushToTalk());
  $('#micBtn').addEventListener('click', () => listener.pushToTalk());
  $('#handsFreeBtn').addEventListener('click', toggleHandsFree);
  $('#settingsBtn').addEventListener('click', openSettings);
  $('#panelsBtn').addEventListener('click', () => $('#panels').classList.toggle('open'));
  $('#settingsForm').addEventListener('submit', saveSettings);
  $('#cancelSettings').addEventListener('click', () => $('#settings').close());
  $('#resetAi').addEventListener('click', () => fillAiFields($('#settingsForm').elements, store.DEFAULT_AI));
  $('#exportBtn').addEventListener('click', downloadBackup);
  $('#importBtn').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', restoreBackup);
  $('#testVoice').addEventListener('click', () => {
    const fields = $('#settingsForm').elements;
    speaker.speak(`At your service, ${addressWord()}.`, { voice: fields.voice.value, rate: Number(fields.rate.value), force: true });
  });
  $('#setupForm').addEventListener('submit', completeSetup);
  $('#bootBtn').addEventListener('click', start);
  $('#lockForm').addEventListener('submit', unlockWithPin);
  $('#bioUnlock').addEventListener('click', unlockWithFingerprint);
  $('#forgotPin').addEventListener('click', eraseAfterForgottenPin);
  $('#lockPin').addEventListener('click', () => {
    $('#pinSetup').hidden = false;
    $('#newPin').focus();
  });
  $('#savePin').addEventListener('click', saveNewPin);
  $('#lockBio').addEventListener('click', addFingerprint);
  $('#lockOff').addEventListener('click', turnLockOff);
  $('#weatherFind').addEventListener('click', () => setWeatherPlace(() => weather.findPlace($('#weatherCity').value)));
  $('#weatherCity').addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    $('#weatherFind').click();
  });
  $('#weatherHere').addEventListener('click', () => setWeatherPlace(weather.placeFromDevice));
  $('#weatherClear').addEventListener('click', () => {
    weather.savePlace(null);
    paintWeatherSettings();
  });

  for (const tab of document.querySelectorAll('[role="tab"]')) {
    tab.addEventListener('click', () => {
      for (const other of document.querySelectorAll('[role="tab"]')) other.setAttribute('aria-selected', String(other === tab));
      for (const panel of document.querySelectorAll('[data-panel]')) panel.hidden = panel.dataset.panel !== tab.dataset.tab;
    });
  }

  const langSelect = $('#langSelect');
  for (const [code, label] of LANGUAGES) {
    const option = el('option', '', label);
    option.value = code;
    langSelect.append(option);
  }

  // Space = tap to talk (when not typing); Escape = stop talking.
  document.addEventListener('keydown', event => {
    if (!started) return;
    if (event.key === 'Escape') speaker.stop();
    const focused = document.activeElement?.tagName;
    const typing = /^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(focused) || document.querySelector('dialog[open]');
    if (event.code === 'Space' && !typing && !event.repeat) {
      event.preventDefault();
      listener.pushToTalk();
    }
  });

  // Phones pause background apps, so catch up on reminders when LightMoon comes back to the front,
  // and ask for the PIN or fingerprint again after a while away.
  document.addEventListener('visibilitychange', () => {
    if (!started) return;
    if (document.hidden) {
      hiddenAt = Date.now();
    } else {
      if (lock.isEnabled() && !locked && hiddenAt && Date.now() - hiddenAt > RELOCK_AFTER_MS) showLock();
      pollReminders();
    }
    refresh();
  });

  store.onExternalChange(() => {
    applyState();
    renderHistory();
  });

  paintHandsFree();
  const tick = () => {
    $('#clock').textContent = new Date().toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  };
  tick();
  setInterval(tick, 15_000);
}

function completeSetup(event) {
  event.preventDefault();
  const fields = event.target.elements;
  const apiKey = fields.apiKey.value.trim();
  const error = $('#setupError');
  if (!state.ai.ready && !apiKey) return void (error.textContent = 'Please paste your API key.');
  if (/\s/.test(apiKey)) return void (error.textContent = "That API key doesn't look right. Copy it again.");
  store.saveProfile({ userName: fields.userName.value, address: fields.address.value });
  if (apiKey) store.saveAiConfig({ apiKey });
  applyState();
  event.target.hidden = true;
  start();
}

// Runs from a tap, which browsers require before they allow sound and the microphone.
function start() {
  if (started) return;
  started = true;
  try {
    audioCtx = new AudioContext();
  } catch {
    audioCtx = null;
  }
  if ('speechSynthesis' in window) speechSynthesis.speak(new SpeechSynthesisUtterance(''));
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});

  $('#boot').classList.add('leaving');
  $('#app').hidden = false;
  setTimeout(() => { $('#boot').hidden = true; }, 600);

  renderHistory();
  refresh();
  pollReminders();
  setInterval(pollReminders, REMINDER_POLL_MS);
  setInterval(renderTasks, 60_000); // keeps overdue highlighting current

  // Opened from a home-screen shortcut or the share sheet: do that instead of the usual briefing.
  if (launch.shared) {
    offerShared(launch.shared);
  } else if (launch.action === 'talk') {
    listener.pushToTalk();
  } else if (launch.action === 'task') {
    input.value = 'Add a task: ';
    input.focus();
  } else {
    runBriefing(launch.action === 'briefing');
  }
}

function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
  navigator.storage?.persist?.().catch(() => {});
  wireUp();
  applyState();
  if (!state.profile.userName || !state.ai.ready) {
    const form = $('#setupForm');
    form.hidden = false;
    form.elements.userName.value = state.profile.userName;
    form.elements.address.value = state.profile.address;
    $('#keyField').hidden = state.ai.ready;
    form.elements.userName.focus();
  } else if (lock.isEnabled()) {
    showLock();
  } else {
    $('#bootBtn').hidden = false;
    $('#bootBtn').focus();
  }
}

boot();
