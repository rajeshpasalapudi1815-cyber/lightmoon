// LightMoon app: runs entirely on this device. Chat, voice, memory, tasks, goals and reminders are all
// handled here; the only thing sent over the internet is the conversation, to the AI service.
import { isNativeApp, nativeAlarms, wakeWord, fileSaver, phone } from './js/native.js'; // first: sets up voice in the Android app
import { refresh as refreshPhone } from './js/phone.js';
import * as store from './js/store.js';
import * as lock from './js/lock.js';
import * as weather from './js/weather.js';
import * as cloud from './js/cloud.js';
import * as lifeLevelling from './js/lifelevelling.js';
import * as desktop from './js/desktop.js';
import { reminderLine, checkInLine, parseAlertId } from './js/announce.js';
import { drawQr, pairingText, canScan, scanQr, codeFromScan } from './js/qr.js';
import { offlineAvailable, offlineStatus, downloadOffline, removeOffline } from './js/offline.js';
import { chat, briefing, weeklyLetter } from './js/brain.js';
import { wireLearning } from './js/learning.js';
import { localStamp, today, isPast, toDate } from './js/time.js';
import { speechChunks, lastSentenceEnd } from './js/speech.js';
import { genderOf, wantedGender, bestVoice } from './js/voices.js';
import * as updates from './js/updates.js';
import * as problems from './js/problems.js';

const $ = selector => document.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const transcript = $('#transcript');
const input = $('#input');
const statusEl = $('#status');

const speechRecognizer = () => window.SpeechRecognition || window.webkitSpeechRecognition;
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
// The phone speaks with a female voice and the computer with a male one (js/voices.js), unless one is chosen.
const VOICE_GENDER = wantedGender(isNativeApp);
const ONLINE_VOICE_REST_MS = 10 * 60_000; // after an online voice fails, use an offline one for this long
const PREFS_KEY = 'assistant.prefs';
const ASKED_NOTIFICATIONS_KEY = 'assistant.askedNotifications';
const REMINDER_POLL_MS = 15_000;
const LATE_REMINDER_MINUTES = 5;
const SNOOZE_MINUTES = 10;
const RELOCK_AFTER_MS = 3 * 60_000; // with the app lock on, ask again after this long in the background
const MAX_SHARED_CHARS = 6000;
const FIRST_WORDS_WAIT_MS = 8000; // stop listening if nothing is said for this long
const MAX_MIC_RESTARTS = 30; // some phones stop the mic after every pause; keep it going, within reason

const prefs = loadPrefs();
const launch = readLaunchParams();
let state = null; // latest snapshot from the store
let busy = false; // waiting for the AI
let started = false; // user has tapped Initialize
let locked = false; // the lock screen is showing
let hiddenAt = 0; // when the app last went into the background
let pendingShare = null; // shared content the next question is about
let listenWhenFree = false; // start listening once the briefing, greeting or reply has been spoken ('follow-up': with a chime)
let audioCtx = null;

// ---------- Small helpers ----------

function loadPrefs() {
  const inIndia = /^Asia\/(Kolkata|Calcutta)$/.test(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const lang = LANGUAGES.find(([code]) => code === navigator.language && !(inIndia && code === 'en-US'))?.[0] ?? (inIndia ? 'en-IN' : 'en-US');
  // sendAfterMs: how long a pause ends a spoken request (0 = only when the moon is tapped again).
  // followUp: after a spoken request, listen for the answer once the reply is said: 'questions' (when the
  // reply asks something), 'always', or 'off' (wait for a tap).
  const defaults = { voice: '', rate: 1, speak: true, lang, handsFree: false, sendAfterMs: 2500, listenOnOpen: true, followUp: 'questions', look: 'hud', reviewSpeech: false };
  try {
    // Move preferences saved under the app's earlier names.
    for (const oldKey of ['vega.prefs', 'jarvis.prefs']) {
      const old = localStorage.getItem(oldKey);
      if (old !== null && localStorage.getItem(PREFS_KEY) === null) localStorage.setItem(PREFS_KEY, old);
      localStorage.removeItem(oldKey);
    }
    const saved = { ...defaults, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') };
    // Once, when voices were split into male and female: a voice of the other kind goes back to Automatic.
    // Once: in India, listen as Indian English rather than US English.
    if (!saved.langIndiaSet) {
      if (inIndia && saved.lang === 'en-US') saved.lang = 'en-IN';
      saved.langIndiaSet = true;
      localStorage.setItem(PREFS_KEY, JSON.stringify(saved));
    }
    if (!saved.voiceGenderSet) {
      if (saved.voice && genderOf(saved.voice) && genderOf(saved.voice) !== VOICE_GENDER) saved.voice = '';
      saved.voiceGenderSet = true;
      localStorage.setItem(PREFS_KEY, JSON.stringify(saved));
    }
    return saved;
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
  return {
    action: params.get('action'),
    reminder: params.get('reminder'), // opened by tapping a reminder notification
    shared: shared.join('\n').slice(0, MAX_SHARED_CHARS),
  };
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
// The conversation is always kept, but by default only the moon shows: the chat button opens it.
// Meanwhile reminders, notes and problems appear briefly as a caption under the moon.

const CAPTION_MS = 9000;
let captionTimer = null;

const chatOpen = () => document.body.classList.contains('show-chat');

function setChatOpen(open) {
  document.body.classList.toggle('show-chat', open);
  const button = $('#chatBtn');
  button.setAttribute('aria-pressed', String(open));
  button.title = open ? 'Hide the conversation' : 'Show the conversation';
  button.setAttribute('aria-label', button.title);
  if (open) {
    $('#chatUnread').hidden = true;
    transcript.scrollTop = transcript.scrollHeight;
  }
}

function showCaption(text, kind = '') {
  const caption = $('#caption');
  caption.textContent = text;
  caption.className = `caption ${kind}`;
  clearTimeout(captionTimer);
  captionTimer = setTimeout(() => { caption.textContent = ''; }, CAPTION_MS);
}

// `fromHistory`: shown again on start-up, not something new.
function addMessage(kind, text, actions = [], { fromHistory = false } = {}) {
  const node = el('div', `msg ${kind}`);
  if (kind.startsWith('assistant')) node.dataset.who = assistantName().toUpperCase();
  node.append(el('div', 'msg-text', text));
  addActions(node, actions);
  if (kind === 'user') {
    node.title = 'Tap to edit and send again';
    node.addEventListener('click', () => {
      if (busy) return note('Wait for this answer, then tap your message to fix it.');
      input.value = text;
      input.focus();
    });
  }
  transcript.append(node);
  transcript.scrollTop = transcript.scrollHeight;
  if (!fromHistory && !chatOpen()) {
    $('#chatUnread').hidden = false;
    if (kind === 'system' || kind === 'reminder') showCaption(text, kind);
    if (kind.includes('error')) showCaption(text, 'error');
  }
  return node;
}

function addActions(node, actions) {
  actions = actions.filter(action => action.text); // e.g. "asked to confirm" steps have nothing to show
  if (!actions.length) return;
  const row = el('div', 'actions');
  for (const action of actions) {
    row.append(el('span', 'action-chip', action.text));
    if (action.calendar) row.append(calendarLink('action-chip chip-link', 'Add to Google Calendar', action.calendar.title, action.calendar.at));
  }
  node.append(row);
}

const note = text => addMessage('system', text);

// While the voice is still talking, finished sentences wait until there are about this many characters, so they
// go to the voice as one phrase: fewer, longer phrases sound smoother than many short ones.
const PHRASE_CHARS = 90;

// Shows a reply while it is still arriving and speaks each sentence as soon as it is complete
// (`quiet`: shown only, e.g. the weekly letter, which is for reading).
function streamReply({ quiet = false } = {}) {
  let node = null;
  let shown = '';
  let unspoken = '';
  const generation = speaker.generation; // if the user stops the speech, stay quiet for the rest of this reply
  const say = text => {
    if (!quiet && speaker.generation === generation) speaker.speak(text);
  };
  const bubble = () => (node ??= addMessage('assistant', ''));
  return {
    push(delta) {
      shown += delta;
      bubble().querySelector('.msg-text').textContent = shown.trimStart();
      transcript.scrollTop = transcript.scrollHeight;
      unspoken += delta;
      const end = lastSentenceEnd(unspoken);
      if (end > 0 && (!speaker.active || end >= PHRASE_CHARS)) {
        say(unspoken.slice(0, end));
        unspoken = unspoken.slice(end);
      }
    },
    done(out) {
      if (out.error) {
        const errorNode = addMessage('assistant error', out.reply);
        if (out.detail) {
          // The service's own words, to make problems easy to report.
          const details = el('details', 'error-detail');
          details.append(el('summary', '', 'Details'), el('code', '', out.detail));
          errorNode.append(details);
        }
        const end = lastSentenceEnd(unspoken);
        if (end > 0) say(unspoken.slice(0, end)); // finished sentences that were waiting to be said
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
  setChatOpen(true); // the choices are in the conversation
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
  if (listenWhenFree && started && !busy && !speaker.active && !locked && listener.mode !== 'command') {
    if (listenWhenFree === 'follow-up') chime(); // "your turn"
    listenWhenFree = false;
    listener.start('command');
  }
  let mode = 'idle';
  if (listener.capturing) mode = 'listening';
  else if (speaker.active) mode = 'speaking';
  else if (busy) mode = 'thinking';
  document.body.dataset.state = mode;
  const idle = !state?.ai.ready
    ? 'Offline: add an API key in settings'
    : prefs.handsFree ? `Say "${assistantName()}" to wake me` : 'Standing by';
  const listening = prefs.sendAfterMs ? 'Listening... tap to send now' : 'Listening... tap when done';
  statusEl.textContent = { idle, listening, thinking: 'Thinking...', speaking: 'Speaking...' }[mode];
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

const isOnlineVoice = voice => voice?.localService === false;
// What an online voice reports when it can't reach its service (other errors aren't the connection's fault).
const CONNECTION_ERRORS = ['network', 'synthesis-failed', 'synthesis-unavailable', 'voice-unavailable'];

// The browser lists its voices a moment after the page opens (the phone, once Android's voice has started).
// Speaking before then would use whatever voice comes first, and switch voices mid-reply.
const voicesLoaded = new Promise(resolve => {
  if (!('speechSynthesis' in window)) return resolve();
  speechSynthesis.addEventListener('voiceschanged', resolve);
  setTimeout(resolve, isNativeApp ? 4000 : 1500);
});

const speaker = {
  active: false,
  queue: [], // phrases handed to the voice and not finished yet, in order
  generation: 0, // bumped by stop() so callbacks from cancelled speech are ignored
  voices: [],
  watchdog: null,
  onlineFailedAt: 0,

  // The chosen voice, else the most natural one available. An online voice only while it can work: not without
  // a connection, nor for a while after one failed.
  pickVoice(name = prefs.voice) {
    const usable = this.voices.filter(v => !isOnlineVoice(v) || (navigator.onLine && Date.now() - this.onlineFailedAt > ONLINE_VOICE_REST_MS));
    const chosen = name && usable.find(v => v.name === name);
    if (chosen) return chosen;
    const best = bestVoice(usable, VOICE_GENDER);
    if (best) return best;
    const steady = usable.filter(v => !/-language$/.test(v.name)); // Android's "any voice for the language"
    return steady.find(v => v.lang.replace('_', '-') === 'en-GB') || steady.find(v => v.lang.startsWith('en')) || null;
  },

  speak(text, { voice = prefs.voice, rate = prefs.rate, force = false } = {}) {
    if ((!prefs.speak && !force) || !('speechSynthesis' in window)) return;
    const sayAs = store.pronunciations.all();
    // Taught a new word (by the AI, or on another device): the phone's own announcements learn it too.
    if (JSON.stringify(sayAs) !== this.sharedSayAs) this.shareVoice();
    const phrases = speechChunks(text, { sayAs });
    if (!phrases.length) return;
    const generation = this.generation;
    this.active = true;
    refresh();
    const go = () => {
      if (generation !== this.generation) return;
      if (!this.voices.length) this.voices = speechSynthesis.getVoices(); // they've only just arrived
      for (const phrase of phrases) this.say({ phrase, voiceName: voice, rate, generation });
      // Some browsers occasionally skip the "end" event; don't stay stuck in speaking mode.
      clearInterval(this.watchdog);
      this.watchdog = setInterval(() => {
        if (!speechSynthesis.speaking && !speechSynthesis.pending) this.finish();
      }, 1500);
    };
    if (this.voices.length) go();
    else voicesLoaded.then(go);
  },

  // One phrase: { phrase, voiceName, rate, generation }. If an online voice fails (the connection dropped), this
  // phrase and the ones after it are said again, in order, with an offline voice.
  say(entry) {
    const chosen = this.pickVoice(entry.voiceName);
    const utterance = new SpeechSynthesisUtterance(entry.phrase);
    if (chosen) {
      utterance.voice = chosen;
      utterance.lang = chosen.lang;
    } else if (isNativeApp) {
      // The phone's own voice: British English, unless another language is chosen for listening.
      utterance.lang = prefs.lang.startsWith('en') ? 'en-GB' : prefs.lang;
    }
    utterance.rate = entry.rate;
    utterance.onend = utterance.onerror = event => {
      if (entry.dropped || entry.generation !== this.generation) return;
      if (event?.type === 'error' && !['interrupted', 'canceled'].includes(event.error)) problems.report('voice', `${chosen?.name ?? 'the voice'}: ${event.error}`);
      this.queue = this.queue.filter(other => other !== entry);
      if (CONNECTION_ERRORS.includes(event?.error) && isOnlineVoice(chosen)) return this.sayOffline(entry);
      if (!this.queue.length) this.finish();
    };
    this.queue.push(entry);
    speechSynthesis.speak(utterance);
  },

  sayOffline(failed) {
    this.onlineFailedAt = Date.now(); // pickVoice leaves online voices out for a while
    const again = [failed, ...this.queue];
    this.drop();
    speechSynthesis.cancel();
    // A phrase handed over in the same moment as a cancel can be skipped, so wait a moment.
    setTimeout(() => {
      const current = again.filter(entry => entry.generation === this.generation);
      if (!current.length) return;
      this.active = true;
      for (const entry of current) this.say({ ...entry, dropped: false });
      refresh();
    }, 50);
  },

  // What was handed to the voice no longer counts: its end (or the cancel's error) is ignored.
  drop() {
    for (const entry of this.queue) entry.dropped = true;
    this.queue = [];
  },

  finish() {
    clearInterval(this.watchdog);
    this.drop();
    if (!this.active) return;
    this.active = false;
    refresh();
  },

  stop() {
    this.generation++;
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    this.finish();
  },

  // The phone says some things by itself (reminders, callers): in the same voice, at the same speed, and saying
  // the user's words their way. The phone may be offline when a reminder goes off, so an online voice is replaced
  // by its offline twin.
  sharedSayAs: '',
  shareVoice() {
    if (!nativeAlarms?.setVoice || !this.voices.length) return;
    const voice = this.pickVoice();
    const steady = isOnlineVoice(voice) ? this.voices.find(v => v.name === voice.name.replace(/-network$/, '-local')) : voice;
    const sayAs = store.pronunciations.all();
    this.sharedSayAs = JSON.stringify(sayAs);
    nativeAlarms.setVoice({ name: steady?.name ?? '', rate: prefs.rate, sayAs }).catch(() => {});
  },
};

if ('speechSynthesis' in window) {
  speaker.voices = speechSynthesis.getVoices();
  speechSynthesis.addEventListener('voiceschanged', () => {
    speaker.voices = speechSynthesis.getVoices();
    speaker.shareVoice();
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

// Shows what has been heard so far in the text box, scrolled so the latest words are in view.
function showHeard(text) {
  input.value = text;
  input.scrollLeft = input.scrollWidth;
}

// Joins recognized phrases into one request. Chrome on Android repeats earlier words in later results
// ("what", then "what is the weather"), so a phrase that starts with the previous one replaces it.
function joinPhrases(phrases) {
  const joined = [];
  for (const phrase of phrases.map(p => p.trim()).filter(Boolean)) {
    const last = joined.at(-1);
    if (last && phrase.toLowerCase().startsWith(last.toLowerCase())) joined[joined.length - 1] = phrase;
    else joined.push(phrase);
  }
  return joined.join(' ');
}

const listener = {
  rec: null,
  mode: null, // 'command' = taking a request (after a tap or the wake word), 'wake' = waiting for the wake word
  capturing: false, // a request is being taken right now
  opening: '', // words heard before this recognizer started (after the wake word, or before a mic restart)
  silenceTimer: null,
  restarts: 0,
  failed: false,
  autoStarted: false, // listening began without a tap (app opened by voice); a refusal then just means "tap to talk"

  get supported() {
    return Boolean(speechRecognizer());
  },

  // Keeps listening through pauses; the request ends after prefs.sendAfterMs of quiet, or when the moon is tapped.
  start(mode, { opening = '', resume = false } = {}) {
    this.stopRec();
    if (!this.supported) return;
    const Recognizer = speechRecognizer();
    const rec = new Recognizer();
    rec.lang = prefs.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 3;
    this.heardAlso = [];
    rec.onresult = event => this.onResult(event);
    rec.onerror = event => this.onError(event);
    rec.onend = () => this.onEnd(rec);
    this.rec = rec;
    this.mode = mode;
    this.capturing = mode === 'command';
    this.opening = opening;
    if (!resume) {
      this.restarts = 0;
      this.failed = false;
    }
    try {
      rec.start();
    } catch {
      this.rec = null;
      this.mode = null;
      this.capturing = false;
      return;
    }
    if (this.capturing) {
      showHeard(opening);
      if (!resume) this.waitForSilence();
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

  // Tap the moon or the mic: start listening; tap again to send straight away.
  pushToTalk() {
    if (!this.supported) return note('Voice input needs Chrome or Edge. You can still type.');
    if (speaker.active) speaker.stop(); // a tap always silences, even while a reply is still arriving
    if (busy) return;
    this.autoStarted = false;
    if (this.mode === 'command') return this.finish();
    this.start('command');
    refresh();
  },

  onResult(event) {
    const results = Array.from(event.results);
    if (this.mode === 'command') {
      const finals = results.filter(r => r.isFinal).map(r => r[0].transcript);
      // The recogniser's other guesses at the latest words, for the AI (brain.js).
      const latest = results.at(-1);
      this.heardAlso = Array.from(latest ?? []).slice(1, 3).map(a => a.transcript).filter(Boolean);
      const interim = results.filter(r => !r.isFinal).map(r => r[0].transcript).join(' ');
      showHeard(`${joinPhrases([this.opening, ...finals])} ${interim}`.trim());
      this.waitForSilence(); // still talking: restart the pause timer
      return;
    }
    for (let i = event.resultIndex; i < results.length; i++) {
      if (results[i].isFinal && this.checkWakeWord(results[i][0].transcript)) break;
    }
  },

  waitForSilence() {
    clearTimeout(this.silenceTimer);
    const wait = input.value.trim() ? prefs.sendAfterMs : FIRST_WORDS_WAIT_MS;
    if (wait) this.silenceTimer = setTimeout(() => this.finish(), wait);
  },

  // The request is complete: stop listening and send what was said (if anything).
  finish() {
    clearTimeout(this.silenceTimer);
    const text = input.value.trim();
    const heardAlso = this.heardAlso ?? [];
    this.capturing = false;
    this.stopRec();
    input.value = '';
    refresh();
    if (!text) return;
    // "Let me check the words first": the words wait in the box to be corrected, and go when Send is tapped.
    if (prefs.reviewSpeech && !panelMode.on) {
      input.value = text;
      showCaption('Check the words, then tap send', 'system');
      return;
    }
    send(text, { byVoice: true, heardAlso });
  },

  cancel() {
    clearTimeout(this.silenceTimer);
    this.capturing = false;
    this.stopRec();
    input.value = '';
    refresh();
  },

  // Wake-word mode: "LightMoon, what's on today?" or "LightMoon." then the request.
  checkWakeWord(text) {
    const lower = text.toLowerCase();
    const word = wakeWords().find(w => lower.includes(w));
    if (!word) return false;
    chime();
    this.start('command', { opening: text.slice(lower.indexOf(word) + word.length).replace(/^[\s,.!?]+/, '').trim() });
    refresh();
    return true;
  },

  onError(event) {
    if (event.error === 'no-speech' || event.error === 'aborted') return; // normal
    this.failed = true;
    if (event.error === 'not-allowed' && this.autoStarted) return note('Tap the moon whenever you want to talk.');
    const problems = {
      'not-allowed': 'Microphone access is blocked. Allow the microphone for LightMoon in your browser or app settings, then try again.',
      'service-not-allowed': 'Speech recognition is not available in this browser. Try Chrome or Edge.',
      'audio-capture': 'No microphone was found.',
      network: 'Speech recognition needs an internet connection.',
    };
    note(problems[event.error] ?? `Voice input stopped (${event.error}).`);
    if (prefs.handsFree) {
      prefs.handsFree = false;
      savePrefs();
      paintHandsFree();
    }
  },

  onEnd(rec) {
    if (rec !== this.rec) return; // we stopped it ourselves
    this.rec = null;
    if (this.mode === 'command') {
      // Some phones stop the mic after every pause: carry on until the user has been quiet long enough.
      if (this.capturing && !this.failed && this.restarts++ < MAX_MIC_RESTARTS) {
        return this.start('command', { opening: input.value.trim(), resume: true });
      }
      return this.finish();
    }
    this.mode = null;
    // Browsers end continuous recognition every so often; refresh() restarts it if it's still wanted.
    setTimeout(refresh, 300);
  },

  sync() {
    if (!started || !this.supported || this.mode === 'command') return;
    const wanted = prefs.handsFree && !busy && !speaker.active && !document.hidden && !locked;
    if (wanted && !this.rec) this.start('wake');
    if (!wanted && this.mode === 'wake') {
      this.stopRec();
      this.capturing = false;
    }
  },
};

// ---------- Conversation ----------

// Conversation mode: after a spoken request, listen for the answer once the reply has been said, without a
// tap or the wake word ("Call Mom?" "Yes."). If nothing is said, listening stops on its own after a moment.
function shouldFollowUp(reply) {
  if (!prefs.speak || prefs.followUp === 'off') return false;
  return prefs.followUp === 'always' || /\?["')\]]*\s*$/.test(String(reply ?? '').trim());
}

// `context` is shared content the message is about (from "Share to LightMoon"); `byVoice`: it was spoken.
async function send(text, { context = null, byVoice = false, heardAlso = [] } = {}) {
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
    const out = await chat(context ? `${text}\n\nShared content:\n${context}` : text, { onText: live.push, heardAlso });
    live.done(out);
    applyState();
    if (byVoice && !out.error && shouldFollowUp(out.reply)) listenWhenFree = 'follow-up';
  } finally {
    busy = false;
    refresh();
  }
}

// One AI briefing per day (unless asked for); later launches get a short greeting instead.
async function runBriefing(force = false) {
  if (!state.ai.ready) return;
  if (!force && store.settings.get('last_briefing') === today()) {
    speaker.speak(prefs.listenOnOpen ? `Yes, ${addressWord()}?` : `Welcome back, ${addressWord()}.`);
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

// The weekly letter: Sunday from 6 pm, once a week. The week is marked in the synced settings first, so another
// open device doesn't write one too. `force` writes it now (from Settings).
const LETTER_FROM_HOUR = 18;
const LETTER_RETRY_MS = 30 * 60_000;
let letterFailedAt = 0; // an automatic letter that failed (offline, limit hit) is tried again a while later
async function maybeWeeklyLetter(force = false) {
  if (!started || locked || !state.ai.ready || busy || listener.capturing) return;
  const week = store.weekKey();
  if (!force) {
    const now = new Date();
    if (store.settings.get('weekly_letter', 'on') === 'off' || now.getDay() !== 0 || now.getHours() < LETTER_FROM_HOUR) return;
    if (store.settings.get('last_letter') === week || Date.now() - letterFailedAt < LETTER_RETRY_MS) return;
  }
  const previous = store.settings.get('last_letter');
  store.settings.set('last_letter', week);
  busy = true;
  refresh();
  try {
    const live = streamReply({ quiet: true });
    const out = await weeklyLetter({ facts: store.weekFacts(), buddy: store.settings.get('buddy_name'), onText: live.push });
    if (out.error) {
      store.settings.set('last_letter', previous); // not written: try again
      letterFailedAt = Date.now();
      if (force) live.done(out); // asked for now: say why; written on its own: quietly, later
      return;
    }
    live.done(out);
    speaker.speak(`${addressWord()}, your weekly letter is ready.`);
    if (document.hidden) notify(`${assistantName()}: your weekly letter`, 'Your week in a few paragraphs, and a suggestion for next week. Tap to read it.');
  } finally {
    busy = false;
    refresh();
  }
}

async function pollReminders() {
  await takeAnswers();
  if (nativeAlarms) {
    // In the Android app, the phone's alarms say reminders (and check-ins) while LightMoon is in the
    // background or closed.
    const { ids, visible } = await nativeAlarms.takeSpoken().catch(() => ({ ids: [], visible: true }));
    for (const id of ids) {
      const { taskId, n } = parseAlertId(id);
      const task = store.tasks.get(taskId);
      if (!task || task.done) continue;
      if (n) {
        if ((task.checked_in ?? 0) >= n) continue;
        store.tasks.markCheckedIn(taskId, n);
        addReminderMessage(task, checkInLine(task, store.settings.all(), n));
      } else if (!task.reminded) {
        store.tasks.markReminded(taskId);
        addReminderMessage(task, sayReminder(task));
      }
    }
    if (!visible) return;
  }
  // Never talk over the user: the microphone would take the reminder for part of their request.
  // It is announced at the next check, a few seconds after they finish.
  if (listener.capturing) return;
  const due = store.tasks.takeDueReminders();
  const checkIns = store.tasks.takeDueCheckIns();
  if (!due.length && !checkIns.length) return;
  const notified = await cloud.notifiedReminders(); // already shown as a notification while closed
  for (const reminder of due.filter(r => !notified[r.id])) {
    const minutesLate = (Date.now() - toDate(reminder.remind_at).getTime()) / 60_000;
    const line = sayReminder(reminder);
    if (minutesLate > LATE_REMINDER_MINUTES) {
      addReminderMessage(reminder, `Missed reminder (${formatWhen(reminder.remind_at)}): ${reminder.title}`);
      speaker.speak(`${addressWord()}, you missed a reminder from ${formatWhen(reminder.remind_at)}. ${line}`, { force: true });
    } else {
      addReminderMessage(reminder, line);
      speaker.speak(line, { force: true });
    }
    if (document.hidden) notify(`${assistantName()} reminder`, line);
  }
  for (const check of checkIns.filter(c => !notified[c.id])) {
    addReminderMessage(check.task, check.say);
    speaker.speak(check.say, { force: true });
    if (document.hidden) notify(`${assistantName()} is checking in`, check.say);
  }
  applyState();
}

const sayReminder = task => reminderLine(task, { address: state.profile.address, user_name: state.profile.userName });

// A reminder or check-in in the conversation, with buttons to answer it there and then.
function addReminderMessage(task, line) {
  const node = addMessage('reminder', line);
  const row = el('div', 'actions reminder-answers');
  const answer = (action, label) => {
    const button = el('button', 'action-chip chip-button', label);
    button.type = 'button';
    button.addEventListener('click', () => {
      for (const other of row.querySelectorAll('button')) other.disabled = true;
      const reply = answerReminder(task.id, action);
      if (reply) row.replaceChildren(el('span', 'action-chip', reply));
    });
    row.append(button);
  };
  answer('done', 'Done');
  answer('snooze', `Snooze ${SNOOZE_MINUTES} min`);
  answer('stop', 'Stop asking');
  node.append(row);
}

// Done, snooze or "stop asking" for a reminder: from its buttons, a notification or the phone. Returns what
// happened, for the conversation, or null if the task is gone or already done.
function answerReminder(taskId, action, { until = null } = {}) {
  const task = store.tasks.get(taskId);
  if (!task || task.done) return null;
  let reply = null;
  if (action === 'done' && store.tasks.complete(taskId)) reply = `Done: ${task.title}`;
  if (action === 'snooze') {
    const at = localStamp(new Date(until ?? Date.now() + SNOOZE_MINUTES * 60_000));
    if (store.tasks.snooze(taskId, at)) reply = `Snoozed until ${formatWhen(at)}: ${task.title}`;
  }
  if (action === 'stop' && store.tasks.stopCheckingIn(taskId)) reply = `Won't ask again: ${task.title}`;
  applyState();
  return reply;
}

// Answers given on notifications (this computer's, or the phone's) while LightMoon wasn't looking.
async function takeAnswers() {
  const answers = [
    ...(await cloud.takeReminderActions()),
    ...(nativeAlarms ? (await nativeAlarms.takeActions().catch(() => ({ actions: [] }))).actions ?? [] : []),
  ];
  for (const { id, action, until } of answers) {
    const reply = answerReminder(parseAlertId(id).taskId, action, { until });
    if (reply) note(reply);
  }
}

// Opened from a reminder notification (or one of its check-ins): say it out loud.
async function announceReminder(id) {
  const { taskId, n } = parseAlertId(id);
  let task = store.tasks.get(taskId);
  if (!task) {
    await cloud.syncNow(); // it may have been set on another device
    task = store.tasks.get(taskId);
  }
  if (!task) {
    const line = `${addressWord()}, you have a reminder.`;
    addMessage('reminder', line);
    return speaker.speak(line, { force: true });
  }
  const line = n ? checkInLine(task, store.settings.all(), n) : sayReminder(task);
  if (n) store.tasks.markCheckedIn(task.id, n);
  else store.tasks.markReminded(task.id);
  addReminderMessage(task, line);
  speaker.speak(line, { force: true });
  applyState();
}

// A reminder's alarm went off while LightMoon is on screen: announce it here, in the conversation.
async function onReminderAlarm({ id, say }) {
  const { taskId } = parseAlertId(id);
  if (!store.tasks.get(taskId)) await cloud.syncNow(); // set on another device and not synced here yet
  if (store.tasks.get(taskId)) return pollReminders();
  addMessage('reminder', say); // e.g. the test from Settings
  speaker.speak(say, { force: true });
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
  if (!state.memories.length && !state.routines.length) {
    list.append(el('li', 'empty', "Nothing yet. As we talk I'll remember what matters: your preferences, people, routines and ambitions."));
  }
  for (const memory of state.memories) {
    const item = el('li', 'item');
    const main = el('div', 'item-main');
    main.append(el('div', 'tag', memory.category), el('div', 'item-title', memory.content));
    item.append(main, iconButton('del', '×', 'Forget this', () => store.memories.remove(memory.id)));
    list.append(item);
  }
  // Routines live here too: "when I say good night, ..."
  for (const routine of state.routines) {
    const item = el('li', 'item');
    const main = el('div', 'item-main');
    main.append(el('div', 'tag', 'routine'), el('div', 'item-title', `"${routine.trigger}"`), el('div', 'item-meta', routine.steps));
    item.append(main, iconButton('del', '×', `Delete the routine "${routine.trigger}"`, () => store.routines.remove(routine.id)));
    list.append(item);
  }
}

function renderHistory() {
  transcript.replaceChildren();
  for (const message of store.messages.recent(40)) addMessage(message.role, message.content, [], { fromHistory: true });
}

// ---------- Settings ----------

// Android names its voices like "en-gb-x-rjs-local": say which language, which voice, and whether it needs the
// internet. Its "en-GB-language" entries (any voice for the language) aren't offered: they swap voices mid-reply.
function voiceLabel(voice) {
  const android = voice.name.match(/^[a-z]{2,3}-[a-z]{2}-x-([a-z]+)-(local|network)$/);
  const language = LANGUAGES.find(([code]) => code.toLowerCase() === voice.lang.replace('_', '-').toLowerCase())?.[1] ?? voice.lang;
  if (!android) return `${voice.name} (${voice.lang})`;
  const kind = genderOf(voice);
  return `${language}, ${kind ? `${kind} ` : ''}voice ${android[1].toUpperCase()}${android[2] === 'network' ? ', online' : ''}`;
}

function fillVoices(select) {
  select.replaceChildren(el('option', '', `Automatic (best ${VOICE_GENDER} voice)`));
  select.firstChild.value = '';
  const groups = { female: el('optgroup'), male: el('optgroup'), other: el('optgroup') };
  groups.female.label = 'Female voices';
  groups.male.label = 'Male voices';
  groups.other.label = 'Other voices';
  const ownLanguage = prefs.lang.split('-')[0];
  const voices = [...speaker.voices]
    .filter(v => !isNativeApp || ((v.lang.startsWith('en') || v.lang.startsWith(ownLanguage)) && !/-language$/.test(v.name)))
    .sort((a, b) => Number(b.lang.startsWith('en')) - Number(a.lang.startsWith('en')) || a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));
  for (const voice of voices) {
    const option = el('option', '', voiceLabel(voice));
    option.value = voice.name;
    groups[genderOf(voice) ?? 'other'].append(option);
  }
  // This device's kind first.
  const order = VOICE_GENDER === 'female' ? ['female', 'male', 'other'] : ['male', 'female', 'other'];
  select.append(...order.map(kind => groups[kind]).filter(group => group.children.length));
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
  fields.look.value = prefs.look;
  fields.assistantName.value = state.profile.assistantName;
  fields.rate.value = prefs.rate;
  fields.speak.checked = prefs.speak;
  fields.sendAfter.value = String(prefs.sendAfterMs);
  fields.reviewSpeech.checked = prefs.reviewSpeech;
  fields.listenOnOpen.checked = prefs.listenOnOpen;
  fields.followUp.value = prefs.followUp;
  fields.reminderChecks.value = store.settings.get('reminder_checks', 'on');
  fields.weeklyLetter.value = store.settings.get('weekly_letter', 'on');
  fields.buddyName.value = store.settings.get('buddy_name');
  fields.buddyContact.value = store.settings.get('buddy_contact');
  fields.lang.value = prefs.lang;
  fields.apiKey.value = '';
  fillAiFields(fields, store.aiConfig());
  fillVoices(fields.voice);
  $('#modelInfo').textContent = `Brain: ${state.ai.model} via ${state.ai.provider}${state.ai.hasKey ? '' : ' (no API key yet)'}.`;
  $('#settingsError').textContent = '';
  paintWeatherSettings();
  paintLockSettings();
  paintCloudSettings();
  paintRhythm();
  paintSayAs();
  paintNicknames();
  paintHealth();
  paintOfflineBrain();
  paintPhoneSettings();
  paintWakeSettings();
  paintPhonePowers();
  paintReading();
  showSettingsPage(null);
  hideEmptySettings();
  $('#settings').showModal();
  // A history step for Settings (and one for each page opened), so the phone's back button steps back.
  history.pushState({ settings: 'menu' }, '');
  settingsSteps = 1;
}

// ---------- Settings pages: the menu, and each section on its own page ----------
let settingsSteps = 0; // history entries added while Settings is open

function showSettingsPage(name) {
  const page = name ? $(`.settings-page[data-page="${name}"]`) : null;
  for (const section of $$('.settings-page')) section.hidden = section !== page;
  $('#settingsMenu').hidden = Boolean(page);
  $('#settingsBack').hidden = !page;
  $('#settingsTitle').textContent = page?.dataset.title ?? 'Settings';
  $('.settings-body').scrollTop = 0;
}

function openSettingsPage(name) {
  const onPage = $('#settingsMenu').hidden;
  showSettingsPage(name);
  if (onPage) history.replaceState({ settings: name }, '');
  else {
    history.pushState({ settings: name }, '');
    settingsSteps++;
  }
  $('#settingsBack').focus({ preventScroll: true });
}

// Sections with nothing for this device (Phone in a browser, say) are left out of the menu.
function hideEmptySettings() {
  for (const item of $$('.menu-item')) {
    const cards = $$(`.settings-page[data-page="${item.dataset.page}"] .set-card`);
    item.hidden = cards.every(card => card.hidden);
  }
  for (const section of $$('.menu-section')) section.hidden = $$('.menu-item', section).every(item => item.hidden);
}

// Back (the arrow, Esc, or the phone's back button) goes from a page to the menu, and from the menu out.
function onSettingsHistory(event) {
  if (!$('#settings').open) return;
  const where = event.state?.settings;
  if (where) {
    settingsSteps = where === 'menu' ? 1 : 2;
    showSettingsPage(where === 'menu' ? null : where);
  } else {
    settingsSteps = 0;
    $('#settings').close();
  }
}

// However Settings closed (Save, Cancel, back), take its history steps back off.
function onSettingsClosed() {
  if (settingsSteps > 0) history.go(-settingsSteps);
  settingsSteps = 0;
  window.applyLook?.(prefs.look); // a look tried but not saved goes back
}

// A problem with something on another page: show that page, and the problem.
function settingsProblem(page, text) {
  if ($(`.settings-page[data-page="${page}"]`).hidden) openSettingsPage(page);
  $('#settingsError').textContent = text;
}

// ---------- Reminder notifications and sync ----------

function describeAgo(ms) {
  const minutes = Math.round((Date.now() - ms) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  return new Date(ms).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

function paintSyncStatus(status = cloud.syncStatus()) {
  if (!cloud.syncCode()) return void ($('#syncStatus').textContent = 'Off');
  $('#syncStatus').textContent = status.syncing ? 'Syncing...'
    : status.error ? `Problem: ${status.error}`
    : status.lastSync ? `On, last synced ${describeAgo(status.lastSync)}` : 'On';
}

// The Android app speaks reminders with the phone's own alarms instead of web notifications.
// ---------- Is everything working? (Settings → Health) ----------

const DAY_MS = 86_400_000;

// One list of what LightMoon needs to do its job, each checked now: green, amber (works, with a catch) or red
// (broken), with a button where a tap can put it right.
async function paintHealth() {
  const list = $('#healthList');
  list.replaceChildren(el('li', 'health-row checking', 'Checking…'));
  const rows = [];
  const row = (kind, title, detail, fix = null) => rows.push({ kind, title, detail, fix });
  const alarms = nativeAlarms ? await nativeAlarms.status().catch(() => null) : null;
  const phoneState = phone ? await phone.status().catch(() => null) : null;

  row(state.ai.ready ? 'ok' : 'bad', 'AI', state.ai.ready ? `Ready (${state.ai.model})` : 'No API key yet',
    state.ai.ready ? null : ['Add key', () => openSettingsPage('ai')]);
  row(navigator.onLine === false ? 'warn' : 'ok', 'Internet',
    navigator.onLine === false ? 'Offline: reminders still ring, and the offline brain answers if downloaded' : 'Connected');

  const voice = speaker.pickVoice();
  row(speaker.voices.length ? 'ok' : 'warn', 'Voice', speaker.voices.length ? (voice ? voiceLabel(voice) : 'The device\'s own voice') : 'No voices found yet',
    ['Test', () => sayInChosenVoice(`This is ${assistantName()}.`)]);
  const mic = await microphoneState();
  row(mic === 'denied' ? 'bad' : mic === 'granted' ? 'ok' : 'warn', 'Microphone',
    { granted: 'Allowed', denied: 'Blocked: allow it in the phone or browser settings for LightMoon', prompt: 'Asked for the first time you tap the moon', unknown: 'Unknown' }[mic]);

  if (isNativeApp) {
    if (alarms) {
      row(alarms.notifications ? 'ok' : 'bad', 'Notifications', alarms.notifications ? 'Allowed' : 'Blocked: reminders are only spoken',
        alarms.notifications ? null : ['Allow', allowPhoneNotifications]);
      row(alarms.exactAlarms ? 'ok' : 'warn', 'Reminder alarms',
        alarms.exactAlarms ? `On time, ${alarms.upcoming} coming up` : 'May ring a few minutes late (exact alarms are off)');
      row(alarms.batteryUnrestricted ? 'ok' : 'bad', 'Battery',
        alarms.batteryUnrestricted ? 'Unrestricted' : 'The phone may stop LightMoon in the background',
        alarms.batteryUnrestricted ? null : ['Fix', () => nativeAlarms.openBatterySettings().catch(() => {})]);
      row(alarms.backgroundSync ? 'ok' : 'warn', 'Background sync', alarms.backgroundSync ? 'Every 15 minutes' : 'Off until sync is set up');
    }
    const wake = wakeWord ? await wakeWord.status().catch(() => null) : null;
    if (wake?.modelReady) {
      row(wake.enabled && wake.listening ? 'ok' : wake.enabled ? 'warn' : 'bad', `Saying "${assistantName()}"`,
        wake.enabled ? (wake.listening ? 'Listening for its name' : 'On, starts listening when the app is in the background') : 'Off: saying its name won\'t open the app',
        wake.enabled ? null : ['Turn on', () => wakeWord.start().then(paintHealth).catch(() => openSettingsPage('voice'))]);
    }
    if (phoneState) {
      const wantsMessages = phoneState.readMessages !== 'off';
      row(!wantsMessages || phoneState.messages ? 'ok' : 'bad', 'Message reading',
        !wantsMessages ? 'Off' : phoneState.messages ? 'Connected' : 'Notification access is off',
        wantsMessages && !phoneState.messages ? ['Fix', () => phone.openMessageAccess().catch(() => {})] : null);
      row(phoneState.announceCalls && !phoneState.calls ? 'warn' : 'ok', 'Calls',
        !phoneState.announceCalls ? 'Not announced' : phoneState.calls ? 'Announced' : 'Announcing is on, but calls aren\'t allowed',
        phoneState.announceCalls && !phoneState.calls ? ['Allow', () => phone.requestCalls().then(paintHealth).catch(() => {})] : null);
    }
  } else {
    const permission = 'Notification' in window ? Notification.permission : 'unsupported';
    row(permission === 'granted' ? 'ok' : permission === 'denied' ? 'bad' : 'warn', 'Notifications',
      { granted: 'Allowed', denied: 'Blocked in the browser', default: 'Not asked yet', unsupported: 'Not available in this browser' }[permission],
      permission === 'default' ? ['Allow', () => Notification.requestPermission().then(paintHealth)] : null);
    const persisted = await navigator.storage?.persisted?.().catch(() => false);
    row(persisted ? 'ok' : 'warn', 'Storage', persisted ? 'Protected from browser clean-ups' : 'The browser may clear it when space runs low',
      persisted ? null : ['Protect', () => navigator.storage.persist().then(paintHealth)]);
  }

  const sync = cloud.syncStatus();
  if (!cloud.syncCode()) row('ok', 'Sync', 'Off (this device only)');
  else if (sync.error) row('bad', 'Sync', sync.error, ['Sync now', () => cloudAction(() => cloud.syncNow({ required: true })).then(paintHealth)]);
  else row(sync.lastSync && Date.now() - sync.lastSync > DAY_MS ? 'warn' : 'ok', 'Sync', sync.lastSync ? `Last synced ${describeAgo(sync.lastSync)}` : 'On');

  if (isNativeApp && offlineAvailable()) {
    const brain = await offlineStatus().catch(() => null);
    if (brain) row('ok', 'Offline brain', { ready: 'Downloaded and ready', downloading: 'Downloading…' }[brain.state] ?? 'Not downloaded (optional)');
  }

  const recent = problems.since(Date.now() - DAY_MS);
  row(recent ? 'warn' : 'ok', 'Problems in the last 24 hours', recent ? `${recent}, listed below` : 'None');
  const newer = updates.waitingVersion();
  row('ok', 'Version', newer ? `${updates.current}; ${newer} is ready` : updates.current, newer ? ['Restart', () => updates.restart()] : null);

  list.replaceChildren(...rows.map(({ kind, title, detail, fix }) => {
    const item = el('li', `health-row ${kind}`);
    item.append(el('span', 'health-dot'), el('span', 'health-title', title), el('span', 'health-detail', detail));
    if (fix) {
      const button = el('button', 'btn-ghost', fix[0]);
      button.type = 'button';
      button.addEventListener('click', fix[1]);
      item.append(button);
    }
    return item;
  }));
  paintProblems();
}

async function microphoneState() {
  try {
    if (isNativeApp) {
      const { speechRecognition } = await window.Capacitor.Plugins.SpeechRecognition.checkPermissions();
      return speechRecognition === 'granted' ? 'granted' : speechRecognition === 'denied' ? 'denied' : 'prompt';
    }
    return (await navigator.permissions.query({ name: 'microphone' })).state;
  } catch {
    return 'unknown';
  }
}

function paintProblems() {
  const items = problems.list();
  const when = at => new Date(at).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  $('#problemList').replaceChildren(...(items.length
    ? items.slice(0, 20).map(p => el('li', '', `${when(p.at)} · ${p.area}: ${p.message}${p.count > 1 ? ` (×${p.count})` : ''}`))
    : [el('li', 'say-as-empty', 'Nothing has gone wrong lately.')]));
  $('#problemsCopy').hidden = !items.length;
  $('#problemsClear').hidden = !items.length;
}

async function paintPhoneSettings() {
  $('#phoneBox').hidden = !nativeAlarms;
  $('#notifyBox').hidden = isNativeApp;
  if (!nativeAlarms) return;
  const status = await nativeAlarms.status().catch(() => null);
  if (!status) return void ($('#phoneStatus').textContent = 'Not available');
  const upcoming = status.upcoming ? `${status.upcoming} coming up` : 'none coming up';
  $('#phoneStatus').textContent = `On, ${upcoming}${status.exactAlarms ? '' : ' (may be a few minutes late)'}`;
  $('#phoneNotify').hidden = status.notifications;
  $('#phoneBattery').hidden = status.batteryUnrestricted;
}

async function allowPhoneNotifications() {
  const status = await nativeAlarms.requestNotifications().catch(() => null);
  if (!status?.notifications) {
    $('#settingsError').textContent = 'Notifications are blocked. Allow them in your phone settings: Apps → LightMoon → Notifications.';
  }
  paintPhoneSettings();
}

async function testSpokenReminder() {
  const word = addressWord();
  const say = `${word.charAt(0).toUpperCase()}${word.slice(1)}, this is ${assistantName()}. Spoken reminders are working.`;
  await nativeAlarms.test({ say, seconds: 60 });
  note('Test set for one minute from now. Lock the phone or close the app; you should hear it.');
  paintPhoneSettings();
}

// ---------- Wake word (Android app): "LightMoon" opens the app ready to listen ----------

async function paintWakeSettings(message) {
  $('#wakeBox').hidden = !wakeWord;
  if (!wakeWord) return;
  const status = await wakeWord.status().catch(() => null);
  if (!status) return void ($('#wakeStatus').textContent = 'Not available');
  const states = { listening: 'On, listening now', paused: 'On, paused while the app is open', heard: 'On, just heard you', starting: 'On, getting ready' };
  $('#wakeStatus').textContent = message ?? (status.enabled ? states[status.state] ?? 'On' : 'Off');
  $('#wakeOn').hidden = status.enabled;
  paintWakePhrases();
  const panelState = await wakeWord.panel?.().catch(() => null); // app 1.12 and later
  $('#panelRow').hidden = !panelState?.possible;
  if (panelState) $('#panelPref').checked = panelState.usePanel;
  $('#wakeOff').hidden = !status.enabled;
  $('#wakeOpenSelf').hidden = !status.enabled || status.canOpenItself;
}

// Which phrases wake it (LightMoon 1.10 and later; older apps keep listening for "LightMoon" alone).
async function paintWakePhrases() {
  const list = await wakeWord.phrases?.().then(r => r.phrases, () => null);
  $('#wakePhrases').hidden = !list;
  if (!list) return;
  const box = $('#wakePhraseList');
  box.replaceChildren(...list.map(({ id, phrase, on }) => {
    const row = document.createElement('label');
    row.className = 'switch-row';
    const input = Object.assign(document.createElement('input'), { type: 'checkbox', checked: on, value: id });
    input.addEventListener('change', async () => {
      const ids = [...box.querySelectorAll('input:checked')].map(i => i.value);
      if (!ids.length) {
        input.checked = true;
        return note('Keep at least one wake phrase on.');
      }
      await wakeWord.setPhrases({ ids }).catch(err => note(err.message));
    });
    row.append(id === 'name' ? `${phrase} on its own (wakes more easily, also by mistake)` : phrase, input);
    return row;
  }));
}

async function turnOnWakeWord() {
  $('#settingsError').textContent = '';
  $('#wakeOn').disabled = true;
  try {
    let status = await wakeWord.status();
    if (!status.modelReady) {
      paintWakeSettings('Downloading the voice model...');
      const progress = await wakeWord.addListener('modelProgress', ({ percent }) => {
        $('#wakeStatus').textContent = `Downloading the voice model... ${percent}%`;
      });
      try {
        await wakeWord.prepare();
      } finally {
        progress.remove();
      }
    }
    status = await wakeWord.start();
    note('Wake phrases on. Leave the app, say "Hey LightMoon", wait for the chime, then speak.');
    if (!status.canOpenItself) {
      note('One more step: in Settings, tap "Allow LightMoon to open itself" so it can open when it hears you. Until then it shows a notification to tap.');
    }
  } catch (err) {
    $('#settingsError').textContent = err.message;
  } finally {
    $('#wakeOn').disabled = false;
    paintWakeSettings();
  }
}

// ---------- Phone (Android app): calendar, calls, texts and messages, apps, alarms (js/phone.js) ----------

async function paintPhonePowers(message) {
  for (const box of ['#phonePowersBox', '#phoneAnnounceBox', '#briefingBox']) $(box).hidden = !phone;
  if (!phone) return;
  const status = await phone.status().catch(() => null);
  if (!status) return void ($('#phonePowersStatus').textContent = 'Not available');
  // Each permission's row shows "Allow", or "Allowed" once its button is hidden. Calls and texts need a SIM.
  const offered = ['calendar', 'messages', ...(status.telephony ? ['calls', 'texts'] : [])];
  const allowed = offered.filter(kind => status[kind]).length;
  $('#phonePowersStatus').textContent = message
    ?? (allowed === offered.length ? 'All allowed' : allowed ? `${allowed} of ${offered.length} allowed` : 'Nothing allowed yet');
  $('#allowCalendar').hidden = status.calendar;
  $('#allowCalls').hidden = status.calls;
  $('#allowTexts').hidden = status.texts;
  $('#allowMessages').hidden = status.messages;
  $('#allowSilence').hidden = status.silence !== false;
  $('#allowSteps').hidden = status.steps !== false;
  $('#allowSteps').closest('.perm-row').hidden = status.steps === undefined || !status.stepCounter; // 1.11 and later, phones with a counter
  $('#streakGuardRow').hidden = typeof status.streakGuard !== 'string';
  if (typeof status.streakGuard === 'string') $('#streakGuard').value = status.streakGuard;
  paintDriving();
  $('#allowCalls').closest('.perm-row').hidden = !status.telephony;
  $('#allowTexts').closest('.perm-row').hidden = !status.telephony;
  $('#allowSilence').closest('.perm-row').hidden = status.silence === undefined; // app versions before 1.4 can't silence
  $('#meetingLead').value = String(status.meetingLead);
  $('#announceCalls').value = String(status.announceCalls);
  $('#readMessages').value = status.readMessages;
  // Briefings need app version 1.4; earlier versions don't report them.
  const briefings = typeof status.briefingMorning === 'string';
  $('#briefingBox').hidden = !briefings;
  if (briefings) for (const kind of ['briefingMorning', 'briefingEvening']) $(`#${kind}`).value = status[kind];
}

// ---------- Messages and email: what LightMoon may read (the rules live on the phone, in ReadRules.java) ----------

async function paintReading() {
  const supported = Boolean(phone?.readingSources); // app 1.5 and later
  for (const box of ['#readingBox', '#readAppsBox', '#readAccountsBox', '#readChatsBox']) $(box).hidden = !supported;
  if (!supported) return;
  const [status, sources] = await Promise.all([phone.status().catch(() => null), phone.readingSources().catch(() => null)]);
  $('#readingNote').textContent = status?.messages
    ? 'Switch off anything LightMoon should never read. Email accounts start off until you switch them on.'
    : "LightMoon can't read messages or email yet: first allow Reading messages on the Phone page.";
  if (sources) renderReading(sources);
}

function renderReading({ apps, accounts, chats }) {
  const kinds = { chat: 'messages', email: 'email', 'chat,email': 'messages and email' };
  fillReading('#readApps', apps, a => ({ name: a.label, note: kinds[a.kind] ?? a.kind, rule: { app: a.app } }),
    'Apps appear here after their first message or email.');
  fillReading('#readAccounts', accounts, a => ({ name: a.account || `${a.label} (account not shown)`, note: a.label, rule: { app: a.app, account: a.account } }),
    'Email accounts appear here after their first new email.');
  fillReading('#readChats', chats, c => ({ name: c.chat, note: c.label, rule: { app: c.app, chat: c.chat } }),
    'Chats appear here as messages arrive.');
}

// One switch per app, account or chat; each change applies at once (no Save needed).
function fillReading(selector, items, describe, empty) {
  const list = $(selector);
  list.replaceChildren();
  if (!items.length) return void list.append(el('p', 'card-note', empty));
  for (const item of items) {
    const { name, note, rule } = describe(item);
    const text = el('span', 'perm-text');
    text.append(el('span', 'perm-name', name), el('small', '', note));
    const toggle = el('input');
    toggle.type = 'checkbox';
    toggle.checked = item.allowed;
    toggle.setAttribute('aria-label', `Read ${name}`);
    toggle.addEventListener('change', () => setReading(rule, toggle));
    const row = el('label', 'switch-row perm-row');
    row.append(text, toggle);
    list.append(row);
  }
}

async function setReading(rule, toggle) {
  $('#settingsError').textContent = '';
  toggle.disabled = true;
  try {
    renderReading(await phone.setReading({ ...rule, allowed: toggle.checked }));
    refreshPhone({ force: true }); // what the AI sees follows straight away
  } catch (err) {
    toggle.checked = !toggle.checked;
    toggle.disabled = false;
    $('#settingsError').textContent = err.message;
  }
}

// Asks Android for one of the phone permissions; a "no" there can only be undone in the phone's settings.
async function allowPhone(request, what) {
  $('#settingsError').textContent = '';
  try {
    const status = await request();
    if (status && !status[what]) {
      $('#settingsError').textContent = 'Android said no. To allow it later: phone Settings → Apps → LightMoon → Permissions.';
    }
  } catch (err) {
    $('#settingsError').textContent = err.message;
  }
  paintPhonePowers();
  refreshPhone({ force: true });
}

// Driving mode (1.11 and later): which car turns it on, and whether it's on now.
async function paintDriving(message) {
  const state = await phone.driving?.().catch(() => null);
  $('#drivingBox').hidden = !state;
  if (!state) return;
  const why = { manual: 'On now', car: `On: in ${state.car}` }[state.driving];
  $('#drivingStatus').textContent = message ?? why ?? (state.car ? `Your car: ${state.car}` : 'No car yet');
  $('#drivingForget').hidden = !state.car;
  $('#drivingEnd').hidden = state.driving !== 'manual';
}

function savePhoneChoices() {
  phone.configure({
    ...($('#streakGuardRow').hidden ? {} : { streakGuard: $('#streakGuard').value }),
    meetingLead: Number($('#meetingLead').value),
    announceCalls: $('#announceCalls').value === 'true',
    readMessages: $('#readMessages').value,
    briefingMorning: $('#briefingMorning').value,
    briefingEvening: $('#briefingEvening').value,
  }).catch(err => { $('#settingsError').textContent = err.message; }).finally(() => paintPhonePowers());
}

// The phone says meetings, callers, messages and briefings itself, so it needs to know how to address the
// user, and where they are for the briefing's weather.
function tellPhoneAddress() {
  if (!phone) return;
  const word = addressWord();
  const place = weather.savedPlace();
  phone.configure({
    address: `${word.charAt(0).toUpperCase()}${word.slice(1)}`,
    ...(place && { place: { name: place.name, latitude: place.latitude, longitude: place.longitude } }),
  }).catch(() => {});
}

// A meeting is starting soon, or a message came in, while LightMoon is on screen: say it here.
function onPhoneSay({ say }) {
  addMessage('reminder', say);
  if (!listener.capturing) speaker.speak(say, { force: true }); // never talk over the user
}

// True when the app was opened (or brought back) because the phone heard "LightMoon". Opened as the quick
// panel, it shows as the panel.
const takeWake = async () => {
  const woke = wakeWord ? await wakeWord.takeWake().catch(() => null) : null;
  if (woke?.panel) setPanelMode(true);
  return Boolean(woke?.wake);
};

// ---------- Quick panel (Android 1.12): a small panel over the app the user is in ----------
// The phone shows LightMoon see-through (MainActivity); here only the moon, what was heard and the reply show.
// When it has been quiet for a few seconds after answering (or nothing was said), it goes back to that app.
const PANEL_IDLE_MS = 5000;
const panelMode = { on: false, timer: null };

function setPanelMode(on) {
  if (on && (!started || locked)) {
    wakeWord?.leavePanel?.({ full: true }).catch(() => {}); // the lock or set-up needs the whole screen
    on = false;
  }
  panelMode.on = on;
  document.documentElement.classList.toggle('panel', on);
  clearTimeout(panelMode.timer);
  if (on) {
    $('#panelText').textContent = '';
    watchPanelIdle();
  }
}

// Back to the app they were in (or, with full, the whole of LightMoon).
function leavePanel({ full = false } = {}) {
  if (!panelMode.on) return;
  if (!full) {
    speaker.stop();
    listenWhenFree = false;
    if (listener.capturing) listener.cancel();
  }
  setPanelMode(false);
  wakeWord?.leavePanel?.({ full }).catch(() => {});
}

function watchPanelIdle() {
  clearTimeout(panelMode.timer);
  if (panelMode.on && document.body.dataset.state === 'idle' && !listenWhenFree) {
    panelMode.timer = setTimeout(() => leavePanel(), PANEL_IDLE_MS);
  }
}

new MutationObserver(watchPanelIdle).observe(document.body, { attributes: true, attributeFilter: ['data-state'] });
// The panel shows what was said last: their words, then the reply as it comes.
new MutationObserver(() => {
  if (!panelMode.on) return;
  const last = transcript.lastElementChild?.querySelector('.msg-text')?.textContent ?? '';
  $('#panelText').textContent = last.length > 400 ? `…${last.slice(-400)}` : last;
}).observe(transcript, { childList: true, subtree: true, characterData: true });

function listenAfterWake() {
  takeWake().then(woke => {
    if (!woke || !started || locked) return;
    speaker.stop();
    listener.autoStarted = true;
    listenWhenFree = true;
    refresh();
  });
}

// Android 13 and later ask before an app may show notifications. Ask once, on first start;
// after that it's a button in Settings.
async function askForNotificationsOnce() {
  try {
    if (localStorage.getItem(ASKED_NOTIFICATIONS_KEY)) return;
    localStorage.setItem(ASKED_NOTIFICATIONS_KEY, '1');
  } catch {
    return;
  }
  await nativeAlarms.requestNotifications().catch(() => {});
}

function paintCloudSettings() {
  const supported = cloud.notificationsSupported();
  const on = cloud.notificationsOn();
  $('#notifyStatus').textContent = !supported ? "Not available in this browser" : on ? 'On for this device' : 'Off';
  $('#notifyOn').hidden = !supported || on;
  $('#notifyOff').hidden = !on;

  const code = cloud.syncCode();
  $('#syncOffBox').hidden = Boolean(code);
  $('#syncOnBox').hidden = !code;
  $('#syncJoinRow').hidden = true;
  $('#syncQrBox').hidden = true;
  $('#syncScan').hidden = !canScan();
  $('#syncScanToo').hidden = !canScan();
  $('#syncCodeInput').value = '';
  $('#syncCodeShow').textContent = code ?? '';
  $('#syncCopy').textContent = 'Copy code';
  paintSyncStatus();
  $('#lifeStatus').textContent = lifeLevelling.describe();
  lifeLevelling.refresh({ force: true }).then(() => { $('#lifeStatus').textContent = lifeLevelling.describe(); });
}

// Runs a cloud step from a Settings button, showing progress and any problem in the dialog.
async function cloudAction(action, doneMessage) {
  const error = $('#settingsError');
  error.textContent = '';
  for (const button of document.querySelectorAll('.cloud-box button')) button.disabled = true;
  try {
    await action();
    if (doneMessage) note(doneMessage);
  } catch (err) {
    error.textContent = err.message;
  } finally {
    for (const button of document.querySelectorAll('.cloud-box button')) button.disabled = false;
    paintCloudSettings();
  }
}

// The offline brain (Android app, js/offline.js): its download and whether it's ready. While it downloads (or is
// checked), the card refreshes every few seconds as long as Settings is open.
let offlineTimer = null;
async function paintOfflineBrain() {
  clearTimeout(offlineTimer);
  $('#offlineBox').hidden = !offlineAvailable();
  if (!offlineAvailable()) return;
  const status = await offlineStatus();
  const mb = bytes => Math.round(bytes / 1_048_576);
  const busyNow = status?.state === 'downloading';
  $('#offlineStatus').textContent = !status ? 'Not available'
    : !status.supported ? "This phone can't run it"
    : { ready: 'Ready', downloading: `Downloading ${Math.floor((100 * status.done) / status.total)}%`, failed: 'Download failed', none: 'Not downloaded' }[status.state] ?? '';
  $('#offlineNote').textContent = !status?.supported ? ''
    : status.state === 'ready' ? `${status.model} is on this phone: ${assistantName()} answers simple things even with no internet.`
    : busyNow ? `${mb(status.done)} of ${mb(status.total)} MB. It carries on if you close ${assistantName()}; it's checked when it finishes.`
    : status.problem || `${status.model}, about ${mb(status.total)} MB, downloaded once.`;
  $('#offlineDownload').hidden = !status?.supported || status.state === 'ready' || busyNow;
  $('#offlineRemove').hidden = !status || status.state === 'none' || status.state === 'failed';
  $('#offlineRemove').textContent = busyNow ? 'Cancel' : 'Remove';
  if (busyNow && $('#settings').open) offlineTimer = setTimeout(paintOfflineBrain, 3000);
}

// What the rhythm learner has worked out from how reminders went (store.rhythm, js/rhythm.js).
// Says something in the voice and at the speed picked in Settings, even before they're saved.
function sayInChosenVoice(text) {
  const fields = $('#settingsForm').elements;
  speaker.speak(text, { voice: fields.voice.value, rate: Number(fields.rate.value), force: true });
}

// What the user calls people, and who that is: each with Remove.
function paintNicknames() {
  const saved = Object.entries(store.nicknames.all()).sort(([a], [b]) => a.localeCompare(b));
  const list = $('#nickList');
  if (!saved.length) return void list.replaceChildren(el('li', 'say-as-empty', 'None yet.'));
  list.replaceChildren(...saved.map(([nick, who]) => {
    const remove = el('button', 'btn-ghost', 'Remove');
    remove.type = 'button';
    remove.addEventListener('click', () => {
      store.nicknames.set(nick, '');
      paintNicknames();
    });
    const row = el('li', 'say-as-row');
    row.append(el('span', '', `${nick} → ${who}`), remove);
    return row;
  }));
}

// Words the user taught LightMoon to say their way, each with Test and Remove.
function paintSayAs() {
  const saved = Object.entries(store.pronunciations.all()).sort(([a], [b]) => a.localeCompare(b));
  const list = $('#sayAsList');
  if (!saved.length) return void list.replaceChildren(el('li', 'say-as-empty', 'None yet.'));
  list.replaceChildren(...saved.map(([word, sound]) => {
    const test = el('button', 'btn-ghost', 'Test');
    test.type = 'button';
    test.addEventListener('click', () => sayInChosenVoice(word));
    const remove = el('button', 'btn-ghost', 'Remove');
    remove.type = 'button';
    remove.addEventListener('click', () => {
      store.pronunciations.set(word, '');
      speaker.shareVoice();
      paintSayAs();
    });
    const row = el('li', 'say-as-row');
    row.append(el('span', '', `${word} → ${sound}`), test, remove);
    return row;
  }));
}

function paintRhythm() {
  const { insights } = store.rhythm();
  const list = $('#rhythmList');
  list.replaceChildren(...(insights.length ? insights : ['Nothing yet. It learns as you finish, snooze or skip reminders.']).map(line => el('li', '', line)));
  $('#rhythmForget').hidden = !insights.length;
}

// Joins a sync code (typed or scanned). A device already syncing with another code switches over, keeping what it has.
function joinCode(input) {
  const tidy = value => String(value ?? '').toUpperCase().replace(/[\s-]/g, '');
  const current = cloud.syncCode();
  if (current && tidy(current) !== tidy(input)
    && !confirm('Switch this device to the other sync code? What it has is kept and combined with the devices on that code.')) return;
  cloudAction(() => cloud.joinSync(input), 'Synced. This device now shares memories, tasks and goals with your other devices.');
}

// Scans the other device's QR code with the camera, then joins its code.
let scanning = null;
async function scanToJoin() {
  scanning?.abort();
  const stop = new AbortController();
  scanning = stop;
  $('#scanBox').hidden = false;
  $('#settingsError').textContent = '';
  try {
    const text = await scanQr($('#scanVideo'), stop.signal);
    if (!text) return;
    const code = codeFromScan(text);
    if (!code) throw new Error("That QR code isn't a LightMoon sync code.");
    $('#syncCodeInput').value = code;
    joinCode(code);
  } catch (err) {
    $('#settingsError').textContent = err.message;
  } finally {
    if (scanning === stop) scanning = null;
    $('#scanBox').hidden = true;
  }
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
  cloud.refreshNotificationPrivacy();
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
  cloud.refreshNotificationPrivacy();
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
  else if (isNativeApp) unlockWithFingerprint(); // the Android app asks for the fingerprint straight away
}

function unlocked() {
  locked = false;
  $('#lockForm').hidden = true;
  if (!started) return start();
  $('#boot').classList.add('leaving');
  setTimeout(() => { $('#boot').hidden = true; }, 600);
  listenAfterWake();
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
  if (/\s/.test(apiKey)) return void settingsProblem('ai', "That API key doesn't look right. Copy it again.");
  const baseUrl = fields.baseUrl.value.trim();
  if (!/^https?:\/\/[^\s]+$/.test(baseUrl)) return void settingsProblem('ai', 'The API address must start with https://');

  const langChanged = fields.lang.value !== prefs.lang;
  Object.assign(prefs, {
    voice: fields.voice.value,
    rate: Number(fields.rate.value),
    speak: fields.speak.checked,
    sendAfterMs: Number(fields.sendAfter.value),
    reviewSpeech: fields.reviewSpeech.checked,
    listenOnOpen: fields.listenOnOpen.checked,
    followUp: fields.followUp.value,
    look: fields.look.value,
    lang: fields.lang.value,
  });
  savePrefs();
  speaker.shareVoice();
  // Synced, so every device (and the phone's alarms) checks in the same way.
  const synced = (key, value, fallback = '') => {
    if (value !== store.settings.get(key, fallback)) store.settings.set(key, value);
  };
  synced('reminder_checks', fields.reminderChecks.value, 'on');
  synced('weekly_letter', fields.weeklyLetter.value, 'on');
  synced('buddy_name', fields.buddyName.value.trim());
  synced('buddy_contact', fields.buddyContact.value.trim());
  store.saveProfile({ userName: fields.userName.value, address: fields.address.value, assistantName: fields.assistantName.value });
  tellPhoneAddress();
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

async function downloadBackup() {
  const name = `lightmoon-backup-${today()}.json`;
  if (fileSaver) {
    // The Android app: Android's own "Save to" screen (its web view can't download files).
    try {
      const { saved } = await fileSaver.save({ name, mimeType: 'application/json', text: store.exportData() });
      if (saved) note('Backup saved.');
    } catch (err) {
      $('#settingsError').textContent = err.message;
    }
    return;
  }
  const link = el('a');
  link.href = URL.createObjectURL(new Blob([store.exportData()], { type: 'application/json' }));
  link.download = name;
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
  if (!listener.supported) return note('Voice input needs Chrome or Edge.');
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
    if (text.trim()) setChatOpen(true); // typed messages are read, not heard: show the reply
    send(text);
  });
  $('#chatBtn').addEventListener('click', () => setChatOpen(!chatOpen()));
  $('#core').addEventListener('click', () => listener.pushToTalk());
  $('#micBtn').addEventListener('click', () => listener.pushToTalk());
  $('#handsFreeBtn').addEventListener('click', toggleHandsFree);
  $('#settingsBtn').addEventListener('click', openSettings);
  $('#panelsBtn').addEventListener('click', () => $('#panels').classList.toggle('open'));
  $('#settingsForm').addEventListener('submit', saveSettings);
  $('#cancelSettings').addEventListener('click', () => $('#settings').close());
  for (const item of $$('.menu-item')) item.addEventListener('click', () => openSettingsPage(item.dataset.page));
  $('#settingsBack').addEventListener('click', () => history.back());
  $('#settings').addEventListener('cancel', event => {
    if ($('#settingsMenu').hidden) { // Esc on a page: back to the menu, not out of Settings
      event.preventDefault();
      history.back();
    }
  });
  $('#settings').addEventListener('close', onSettingsClosed);
  addEventListener('popstate', onSettingsHistory);
  $('#resetAi').addEventListener('click', () => fillAiFields($('#settingsForm').elements, store.DEFAULT_AI));
  wireLearning(); // Settings -> AI brain -> Our own model
  $('#exportBtn').addEventListener('click', downloadBackup);
  $('#importBtn').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', restoreBackup);
  $('#testVoice').addEventListener('click', () => sayInChosenVoice(`At your service, ${addressWord()}.`));
  $('#updateNow').addEventListener('click', () => updates.restart());
  $('#lookSelect').addEventListener('change', event => window.applyLook?.(event.target.value));
  $('#healthAgain').addEventListener('click', paintHealth);
  $('#problemsCopy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(problems.describe());
      note('Copied. Paste it to whoever is helping you.');
    } catch {
      $('#settingsError').textContent = "Couldn't copy here. Take a screenshot of the list instead.";
    }
  });
  $('#problemsClear').addEventListener('click', () => {
    problems.clear();
    paintProblems();
  });
  $('#sayAsAdd').addEventListener('click', () => {
    const word = $('#sayAsWord').value.trim();
    const sound = $('#sayAsSound').value.trim();
    if (!word || !sound) return;
    store.pronunciations.set(word, sound);
    speaker.shareVoice();
    $('#sayAsWord').value = '';
    $('#sayAsSound').value = '';
    paintSayAs();
    sayInChosenVoice(word);
  });
  $('#nickAdd').addEventListener('click', () => {
    const nick = $('#nickName').value.trim();
    const who = $('#nickWho').value.trim();
    if (!nick || !who) return;
    store.nicknames.set(nick, who);
    $('#nickName').value = '';
    $('#nickWho').value = '';
    paintNicknames();
  });
  for (const field of ['#nickName', '#nickWho']) {
    $(field).addEventListener('keydown', event => {
      if (event.key !== 'Enter') return;
      event.preventDefault(); // not the settings form's Save
      $('#nickAdd').click();
    });
  }
  for (const field of ['#sayAsWord', '#sayAsSound']) {
    $(field).addEventListener('keydown', event => {
      if (event.key !== 'Enter') return;
      event.preventDefault(); // not the settings form's Save
      $('#sayAsAdd').click();
    });
  }
  $('#setupForm').addEventListener('submit', completeSetup);
  $('#bootBtn').addEventListener('click', () => start());
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
  $('#notifyOn').addEventListener('click', () => cloudAction(cloud.enableNotifications, 'Reminder notifications are on for this device.'));
  $('#notifyOff').addEventListener('click', () => cloudAction(cloud.disableNotifications));
  $('#syncStart').addEventListener('click', () => cloudAction(cloud.startSync));
  $('#syncJoinShow').addEventListener('click', () => {
    $('#syncJoinRow').hidden = false;
    $('#syncCodeInput').focus();
  });
  $('#syncJoin').addEventListener('click', () => joinCode($('#syncCodeInput').value));
  $('#syncSwitch').addEventListener('click', () => {
    $('#syncJoinRow').hidden = false;
    $('#syncCodeInput').focus();
  });
  $('#syncQrShow').addEventListener('click', () => {
    const box = $('#syncQrBox');
    box.hidden = !box.hidden;
    if (!box.hidden) drawQr($('#syncQr'), pairingText(cloud.syncCode()));
  });
  $('#syncScan').addEventListener('click', scanToJoin);
  $('#syncScanToo').addEventListener('click', scanToJoin);
  $('#scanCancel').addEventListener('click', () => scanning?.abort());
  $('#settings').addEventListener('close', () => scanning?.abort());
  $('#offlineDownload').addEventListener('click', async () => {
    try {
      await downloadOffline(true);
    } catch (err) {
      $('#settingsError').textContent = String(err?.message ?? err);
    }
    paintOfflineBrain();
  });
  $('#offlineRemove').addEventListener('click', async () => {
    if (!confirm(`Remove the offline brain from this phone? ${assistantName()} then needs the internet to answer.`)) return;
    await removeOffline().catch(() => {});
    paintOfflineBrain();
  });
  $('#letterNow').addEventListener('click', () => {
    $('#settings').close();
    setChatOpen(true);
    maybeWeeklyLetter(true);
  });
  $('#rhythmForget').addEventListener('click', () => {
    if (!confirm(`Forget what ${assistantName()} has learned from your reminders? It starts learning again from now.`)) return;
    store.forgetRhythm();
    paintRhythm();
  });
  $('#syncCodeInput').addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    $('#syncJoin').click();
  });
  $('#syncNowBtn').addEventListener('click', () => cloudAction(() => cloud.syncNow({ required: true })));
  $('#syncCopy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(cloud.syncCode());
      $('#syncCopy').textContent = 'Copied';
    } catch {
      $('#settingsError').textContent = 'Copy failed. Write the code down instead.';
    }
  });
  $('#syncStop').addEventListener('click', () => {
    if (!confirm('Stop syncing on this device? It keeps what it has; changes stop flowing to and from your other devices.')) return;
    cloudAction(cloud.stopSync);
  });
  $('#phoneNotify').addEventListener('click', allowPhoneNotifications);
  $('#phoneBattery').addEventListener('click', () => nativeAlarms.openBatterySettings().catch(() => {}));
  $('#phoneTest').addEventListener('click', testSpokenReminder);
  $('#wakeOn').addEventListener('click', turnOnWakeWord);
  $('#wakeOff').addEventListener('click', () => wakeWord.stop().finally(() => paintWakeSettings()));
  $('#panelPref').addEventListener('change', () => wakeWord.panel({ on: $('#panelPref').checked }).catch(() => {}));
  $('#panelOpen').addEventListener('click', () => leavePanel({ full: true }));
  $('#panelClose').addEventListener('click', () => leavePanel());
  // A tap outside the panel goes back to the app behind it.
  document.addEventListener('click', event => {
    if (panelMode.on && !event.target.closest('.core-wrap')) leavePanel();
  });
  $('#wakeOpenSelf').addEventListener('click', () => wakeWord.openOverlaySettings().catch(() => {}));
  if (phone) {
    $('#allowCalendar').addEventListener('click', () => allowPhone(() => phone.requestCalendar(), 'calendar'));
    $('#allowCalls').addEventListener('click', () => allowPhone(() => phone.requestCalls(), 'calls'));
    $('#allowTexts').addEventListener('click', () => allowPhone(() => phone.requestTexts(), 'texts'));
    $('#allowSteps').addEventListener('click', () => allowPhone(() => phone.requestSteps(), 'steps'));
    $('#drivingCar').addEventListener('click', () => phone.driving({ rememberCar: true })
      .then(s => paintDriving(`Your car: ${s.car}`), err => paintDriving(err.message)));
    $('#drivingForget').addEventListener('click', () => phone.driving({ carName: '' }).finally(() => paintDriving()));
    $('#drivingEnd').addEventListener('click', () => phone.driving({ end: true }).finally(() => paintDriving()));
    // Notification access is granted on Android's own screen; the box repaints when the user comes back.
    $('#allowMessages').addEventListener('click', () => phone.openMessageAccess().catch(err => { $('#settingsError').textContent = err.message; }));
    $('#allowSilence').addEventListener('click', () => phone.openSilenceAccess().catch(err => { $('#settingsError').textContent = err.message; }));
    for (const id of ['#meetingLead', '#announceCalls', '#readMessages', '#briefingMorning', '#briefingEvening', '#streakGuard']) {
      $(id).addEventListener('change', savePhoneChoices);
    }
    for (const kind of ['morning', 'evening']) {
      $(`#briefing${kind === 'morning' ? 'Morning' : 'Evening'}Test`).addEventListener('click', () => {
        tellPhoneAddress(); // the latest weather place
        phone.briefingNow({ kind }).catch(err => { $('#settingsError').textContent = err.message; });
      });
    }
  }

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
    if (event.key === 'Escape') {
      speaker.stop();
      if (listener.capturing) listener.cancel();
    }
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
    if (!document.hidden && $('#settings').open) {
      // back from the phone's battery, "display over other apps" or notification access settings
      paintPhoneSettings();
      paintWakeSettings();
      paintPhonePowers();
      paintReading();
      refreshPhone({ force: true });
    }
    if (!document.hidden) listenAfterWake();
    if (document.hidden && panelMode.on) setPanelMode(false), wakeWord?.leavePanel?.({ full: true }).catch(() => {});
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

// Usually runs from a tap, which browsers require before they allow sound and the microphone.
// `auto` means the installed app was allowed to start without one (see soundAllowedWithoutTap).
function start({ auto = false } = {}) {
  if (started) return;
  started = true;
  if (updates.justUpdated()) setTimeout(() => note(`Updated to the newest version (${updates.current}).`), 1500);
  try {
    audioCtx ??= new AudioContext();
  } catch {
    audioCtx = null;
  }
  if ('speechSynthesis' in window) speechSynthesis.speak(new SpeechSynthesisUtterance(''));
  if (!auto && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});

  $('#boot').classList.add('leaving');
  $('#app').hidden = false;
  setTimeout(() => { $('#boot').hidden = true; }, 600);

  renderHistory();
  refresh();
  pollReminders();
  setInterval(pollReminders, REMINDER_POLL_MS);
  setInterval(() => maybeWeeklyLetter(), 60_000);
  setInterval(renderTasks, 60_000); // keeps overdue highlighting current
  cloud.init({
    // Another device's changes arrived: show them (the chat only if new messages came in).
    onSynced({ messagesAdded }) {
      applyState();
      if (messagesAdded && !busy) renderHistory();
    },
    onStatus: paintSyncStatus,
  });
  // Done and Snooze pressed on the Windows desktop orb.
  desktop.start({ onAnswer: (taskId, action, options) => { const reply = answerReminder(taskId, action, options); if (reply) note(reply); } });

  if (phone) {
    phone.addListener('meetingDue', onPhoneSay);
    phone.addListener('messageArrived', onPhoneSay);
    phone.addListener('focusEnded', onPhoneSay); // focus mode's "while you focused…" (Focus.java)
    tellPhoneAddress();
    refreshPhone({ force: true });
  }
  if (nativeAlarms) {
    nativeAlarms.addListener('reminderDue', onReminderAlarm);
    (async () => {
      await askForNotificationsOnce(); // the microphone question comes after this one
      if (await takeWake()) launch.action = 'talk'; // opened by "LightMoon": skip the briefing and listen
      greet(auto);
    })();
  } else {
    greet(auto);
  }
}

// Opened from a home-screen shortcut or the share sheet: do that instead of the usual briefing.
// Otherwise brief (or greet), then start listening if that setting is on.
function greet(auto) {
  listener.autoStarted = auto;
  if (launch.reminder) {
    listenWhenFree = prefs.listenOnOpen; // say the reminder, then listen in case there's a reply
    announceReminder(launch.reminder);
  } else if (launch.shared) {
    offerShared(launch.shared);
  } else if (launch.action === 'task') {
    input.value = 'Add a task: ';
    input.focus();
  } else if (launch.action === 'talk') {
    listenWhenFree = true;
  } else {
    listenWhenFree = prefs.listenOnOpen;
    runBriefing(launch.action === 'briefing');
  }
  refresh();
}

// Installed apps may play sound without a tap first (Chrome's autoplay rules for home-screen apps).
// Then the start screen can be skipped, so "Hey Google, open LightMoon" goes straight to listening.
function soundAllowedWithoutTap() {
  try {
    const context = new AudioContext();
    if (context.state === 'running') {
      audioCtx = context;
      return true;
    }
    context.close();
  } catch {
    // No Web Audio: keep the start screen.
  }
  return false;
}

// ---------- Staying up to date (js/updates.js) ----------

let lastTouch = Date.now();
for (const type of ['pointerdown', 'keydown']) {
  addEventListener(type, () => { lastTouch = Date.now(); }, { passive: true, capture: true });
}

// Nothing a restart would cut off: no reply coming or being spoken, nothing half-typed, Settings closed, and the
// app untouched for a minute (or in the background).
function quietForRestart() {
  const field = document.activeElement;
  const typing = ['INPUT', 'TEXTAREA'].includes(field?.tagName) && field.value;
  return !busy && !speaker.active && !listener.capturing && !typing && !$('#settings').open
    && (document.hidden || Date.now() - lastTouch > 60_000);
}

// A new version is ready while the app is in use: a small bar with a Restart button, until the quiet moment comes.
function offerRestart() {
  $('#updateBar .update-text').textContent = `A new version of ${assistantName()} is ready.`;
  $('#updateBar').hidden = false;
}

function boot() {
  // The Android app has its own alarms and voice, so it skips the web's notification worker and the
  // always-on wake word (the phone's microphone beeps every few seconds when kept listening).
  if (isNativeApp) {
    prefs.handsFree = false;
    $('#handsFreeBtn').hidden = true;
  }
  if ('serviceWorker' in navigator && !isNativeApp) {
    // updateViaCache none: a new version is noticed as soon as it's published, not after the browser's cache expires.
    navigator.serviceWorker.register('./sw.js', { type: 'module', updateViaCache: 'none' }).catch(() => {});
    // A cloud reminder arrived while the app is open: announce it here instead of as a notification.
    navigator.serviceWorker.addEventListener('message', event => {
      // ...or "Done" or "Snooze" was tapped on a notification: apply it now.
      if (['reminders-due', 'reminder-action'].includes(event.data?.type) && started) pollReminders();
      // A reminder notification was tapped while the app was already running in the background.
      if (event.data?.type === 'speak-reminder' && started && !locked) announceReminder(event.data.id);
      // The worker has installed a new version: restart into it at a quiet moment.
      if (event.data?.type === 'updated') updates.noticed(event.data.version);
    });
  }
  navigator.storage?.persist?.().catch(() => {});
  problems.install();
  updates.start({ isQuiet: quietForRestart, onReady: offerRestart });
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
  } else if (isNativeApp || soundAllowedWithoutTap()) {
    start({ auto: true });
  } else {
    if (launch.reminder) $('#bootBtn').textContent = 'Hear reminder';
    $('#bootBtn').hidden = false;
    $('#bootBtn').focus();
  }
}

boot();
