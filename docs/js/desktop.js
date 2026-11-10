// LightMoon on the Windows desktop: the LightMoon Listener's orb shows the next reminder, and Done and Snooze
// buttons when one goes off. The Listener can't look inside the app, so the app tells it what's coming up, over a
// small server the Listener runs on this computer only, and collects what was pressed on the orb
// (windows/DesktopOrb.cs). Nothing happens, quietly, while the Listener isn't running.
// Not in the Android app (its own alarms do this) or off Windows (there's no Listener there).
import { isNativeApp } from './native.js';
import * as store from './store.js';
import * as lock from './lock.js';
import { parseAlertId } from './announce.js';

const LISTENER_URL = 'http://127.0.0.1:47611';
const POLL_MS = 10_000;
const AWAY_POLL_MS = 60_000; // while the Listener isn't running
const RESEND_MS = 60_000; // told again now and then, in case the Listener was restarted
const RECENT_MS = 30 * 60_000; // ones that went off this recently stay on the orb until answered
const SNOOZE_MS = 10 * 60_000; // the orb's "Snooze 10 min"

const onWindows = /Windows/.test(navigator.userAgentData?.platform ?? navigator.userAgent);
// A copy served on this computer for testing leaves the real orb alone (it would take its Done and Snooze
// presses), unless the address asks for it with ?orb.
const testCopy = ['localhost', '127.0.0.1'].includes(globalThis.location?.hostname) && !new URLSearchParams(globalThis.location?.search).has('orb');

let onAnswer = () => {};
let timer = 0;
let running = false;
let again = false;
let connected = false;
let sent = '';
let sentAt = 0;
let wakeSent = null; // the own wake word last passed on to the Listener

// `onAnswer(taskId, action, { until })` applies Done or Snooze pressed on the orb.
let begun = false;
export function start(handlers) {
  if (isNativeApp || !onWindows || testCopy || begun) return;
  begun = true;
  onAnswer = handlers.onAnswer;
  onWake = handlers.onWake ?? (() => {});
  onStop = handlers.onStop ?? (() => {});
  waitForWakes();
  setInterval(() => { stateSent = ''; reportState(lastState); }, 30_000); // so the Listener knows it's still here
  store.onLocalChange(() => {
    if (!connected) return;
    if (running) {
      again = true; // e.g. an answer from the orb was just applied: tell it straight after
      return;
    }
    clearTimeout(timer);
    timer = setTimeout(talk, 300);
  });
  talk();
}

async function talk() {
  if (running) {
    again = true; // a change while talking: tell the orb straight after
    return;
  }
  running = true;
  clearTimeout(timer);
  try {
    await sendAlerts();
    await sendWake();
    await takeAnswers();
    connected = true;
  } catch {
    connected = false;
    sent = ''; // tell it everything once it's back
    wakeSent = null;
  }
  running = false;
  timer = setTimeout(talk, again ? 0 : connected ? POLL_MS : AWAY_POLL_MS);
  again = false;
}

async function call(method, path, body) {
  const res = await fetch(`${LISTENER_URL}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error(`LightMoon Listener: ${res.status}`);
  return res.status === 204 ? null : res.json();
}

// Reminders and check-ins from half an hour ago up to an hour ahead, when they've changed: the orb stays a small
// moon until something is near (a reminder further off would sit there all day as a long bar). This page keeps
// sending, so each one reaches the orb as its hour comes. With the app lock on, the orb says "Reminder" instead
// of what it is, as notifications do.
const ORB_AHEAD_MS = 60 * 60 * 1000;
async function sendAlerts() {
  const hide = lock.isEnabled();
  const until = Date.now() + ORB_AHEAD_MS;
  const alerts = store.tasks.alertsSince(Date.now() - RECENT_MS)
    .filter(({ at }) => at <= until)
    .map(({ id, title, at, say }) => (hide ? { id, title: 'Reminder', at, say: 'You have a reminder.' } : { id, title, at, say }));
  const json = JSON.stringify(alerts);
  if (json === sent && Date.now() - sentAt < RESEND_MS) return;
  await call('POST', '/alerts', alerts);
  sent = json;
  sentAt = Date.now();
}

// The user's own wake word ("Sunshine", set in Settings → Voice, synced): the Listener listens for it too.
// An older Listener without it answers 404, which is fine.
async function sendWake() {
  const phrase = store.settings.get('own_wake');
  if (phrase === wakeSent) return;
  await call('POST', '/wake', { phrase }).catch(() => {});
  wakeSent = phrase;
}

export const listenerConnected = () => connected;

// A snooze counts from when it was pressed, even if LightMoon only hears of it later.
async function takeAnswers() {
  const answers = await call('GET', '/answers');
  for (const { id, action, at } of Array.isArray(answers) ? answers : []) {
    if (!['done', 'snooze'].includes(action)) continue;
    onAnswer(parseAlertId(id).taskId, action, { until: action === 'snooze' ? Number(at) + SNOOZE_MS : null });
  }
}

// ---------- Reading this computer's open apps and notifications (windows/ScreenReader.cs) ----------

// What's showing in an open app ("teams", "outlook", "whatsapp", "browser", or a window title):
// { found, window, text } or { found: false, windows: [titles] }.
export async function readScreen(app) {
  if (!connected) throw new Error('The LightMoon Listener is not running on this computer.');
  const res = await fetch(`${LISTENER_URL}/read?app=${encodeURIComponent(app)}`, { signal: AbortSignal.timeout(15000) });
  if (res.status === 404) throw new Error('The LightMoon Listener on this computer is too old to read apps: it needs updating.');
  if (!res.ok) throw new Error(`LightMoon Listener: ${res.status}`);
  return res.json();
}

// Windows notifications that popped up since the Listener started: [{ at, text }], oldest first.
export async function notifications() {
  if (!connected) throw new Error('The LightMoon Listener is not running on this computer.');
  const res = await fetch(`${LISTENER_URL}/notifications`, { signal: AbortSignal.timeout(5000) });
  if (res.status === 404) throw new Error('The LightMoon Listener on this computer is too old to read notifications: it needs updating.');
  if (!res.ok) throw new Error(`LightMoon Listener: ${res.status}`);
  return res.json();
}

// ---------- Kept in the tray (windows/TrayMode.cs) ----------
// The Listener keeps LightMoon's window out of sight; "LightMoon" heard there arrives here, and what LightMoon is
// doing goes back so a thin line can glow at the top of the screen.

let onWake = () => {};
let onStop = () => {}; // the volume-down key while LightMoon speaks
let stateSent = '';

// Waits on the Listener for a wake, again and again (a long request, answered when "LightMoon" is heard).
async function waitForWakes() {
  for (;;) {
    try {
      const res = await fetch(`${LISTENER_URL}/events`, { signal: AbortSignal.timeout(30000) });
      if (res.status === 404) return; // an older Listener: it wakes LightMoon by bringing it to the front
      const event = res.ok ? await res.json() : {};
      if (event.stop) onStop();
      else if (event.wake) onWake(String(event.said ?? '')); // with what was said in the same breath, if anything
      else if (!res.ok) await new Promise(resolve => setTimeout(resolve, 15000));
    } catch {
      await new Promise(resolve => setTimeout(resolve, connected ? 2000 : 15000)); // the Listener isn't running
    }
  }
}

// 'idle', 'listening', 'thinking' or 'speaking', when it changes (and now and then, so the Listener knows it's here).
export function reportState(state) {
  if (isNativeApp || !onWindows || testCopy) return;
  const activated = Boolean(navigator.userActivation?.hasBeenActive);
  const key = `${state}|${activated}`;
  if (key === stateSent) return;
  stateSent = key;
  fetch(`${LISTENER_URL}/state`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state, activated, problem }), signal: AbortSignal.timeout(3000),
  }).catch(() => { stateSent = ''; });
}
let lastState = 'idle';
let problem = ''; // the page's latest trouble (a voice error), for the Listener's log

export function notePageProblem(text) {
  if (text === problem) return;
  problem = text;
  stateSent = '';
  reportState(lastState);
}
export const noteState = state => {
  lastState = state;
  reportState(state);
};

// Who else has this computer's microphone right now (a call in Teams, WhatsApp, Zoom or a browser): { busy, by }.
// Not busy when the Listener isn't running or is too old to tell.
export async function busy() {
  if (!connected) return { busy: false, by: '' };
  try {
    const res = await fetch(`${LISTENER_URL}/busy`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return { busy: false, by: '' };
    const { busy: inUse, by } = await res.json();
    return { busy: Boolean(inUse), by: String(by ?? '') };
  } catch {
    return { busy: false, by: '' };
  }
}

// ---------- Apps and typing (windows/DesktopApps.cs) ----------

async function ask(method, path, body, ms = 12000) {
  if (!connected) throw new Error('The LightMoon Listener is not running on this computer. Ask them to start it.');
  const res = await fetch(`${LISTENER_URL}${path}`, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(ms),
  });
  if (res.status === 404) throw new Error('The LightMoon Listener on this computer is too old for that: it needs updating.');
  if (!res.ok) throw new Error(`LightMoon Listener: ${res.status}`);
  return res.json();
}

// Opens an app from the Start menu by name: { opened } or { opened: '', like: [names] }.
export const launchApp = name => ask('POST', '/launch', { name });
// What's written in the box they were typing in when they said the wake word: { found, app, text, why }.
export const typedText = () => ask('GET', '/typed');
// Puts a new version in that box: { result: 'replaced' | 'gone' | 'not in front' | 'work' }.
export const replaceTyped = text => ask('POST', '/typed', { text });

// Its window, for what needs the user (the lock screen).
export function showWindow() {
  fetch(`${LISTENER_URL}/show`, { method: 'POST', signal: AbortSignal.timeout(3000) }).catch(() => {});
}

// ---------- Opening websites and the media keys (windows/DesktopOrb.cs POST /open, /media) ----------

// Opens a web address in the default browser, in a new tab.
export async function openUrl(url) {
  if (!connected) throw new Error('The LightMoon Listener is not running on this computer.');
  const res = await fetch(`${LISTENER_URL}/open`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }), signal: AbortSignal.timeout(5000),
  });
  if (res.status === 404) throw new Error('The LightMoon Listener on this computer is too old to open websites: it needs updating.');
  if (!res.ok) throw new Error("That address couldn't be opened.");
}

// 'play_pause', 'next', 'previous' or 'stop': the keyboard's media key, for whatever is playing (a YouTube video in
// the browser, Spotify, a film).
export async function mediaKey(action) {
  if (!connected) throw new Error('The LightMoon Listener is not running on this computer.');
  const res = await fetch(`${LISTENER_URL}/media`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }), signal: AbortSignal.timeout(5000),
  });
  if (res.status === 404) throw new Error('The LightMoon Listener on this computer is too old for media keys: it needs updating.');
  if (!res.ok) throw new Error("The media key didn't go.");
}

// "Send it" for a draft LightMoon opened in Teams or Outlook on this computer: the Listener presses that app's own Send
// button, only if the draft is in its window. -> 'sent', 'no window', 'no draft' or 'no send button'.
export async function pressSend(app, text) {
  if (!connected) throw new Error('The LightMoon Listener is not running on this computer.');
  const res = await fetch(`${LISTENER_URL}/send`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ app, text }), signal: AbortSignal.timeout(15000),
  });
  if (res.status === 404) throw new Error('The LightMoon Listener on this computer is too old to press Send: it needs updating.');
  if (!res.ok) throw new Error("Couldn't press Send.");
  return (await res.json()).result;
}

// "Hide yourself": the Listener puts LightMoon's window out of sight (until the wake word or "show yourself").
export function hideWindow() {
  fetch(`${LISTENER_URL}/hide`, { method: 'POST', signal: AbortSignal.timeout(3000) }).catch(() => {});
}

// "Turn off the wake word" on the computer: the Listener stops (or starts) listening for it.
export async function setListening(on) {
  const res = await fetch(`${LISTENER_URL}/listen`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on }), signal: AbortSignal.timeout(3000),
  });
  if (res.status === 404) throw new Error('the LightMoon Listener on this computer is too old for that; use its tray icon');
  if (!res.ok) throw new Error('the Listener did not take it');
}
