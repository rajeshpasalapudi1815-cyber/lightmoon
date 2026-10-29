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

let onAnswer = () => {};
let timer = 0;
let running = false;
let again = false;
let connected = false;
let sent = '';
let sentAt = 0;

// `onAnswer(taskId, action, { until })` applies Done or Snooze pressed on the orb.
export function start(handlers) {
  if (isNativeApp || !onWindows || timer) return;
  onAnswer = handlers.onAnswer;
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
    await takeAnswers();
    connected = true;
  } catch {
    connected = false;
    sent = ''; // tell it everything once it's back
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

// Reminders and check-ins from half an hour ago on, when they've changed. With the app lock on, the orb says
// "Reminder" instead of what it is, as notifications do.
async function sendAlerts() {
  const hide = lock.isEnabled();
  const alerts = store.tasks.alertsSince(Date.now() - RECENT_MS)
    .map(({ id, title, at, say }) => (hide ? { id, title: 'Reminder', at, say: 'You have a reminder.' } : { id, title, at, say }));
  const json = JSON.stringify(alerts);
  if (json === sent && Date.now() - sentAt < RESEND_MS) return;
  await call('POST', '/alerts', alerts);
  sent = json;
  sentAt = Date.now();
}

// A snooze counts from when it was pressed, even if LightMoon only hears of it later.
async function takeAnswers() {
  const answers = await call('GET', '/answers');
  for (const { id, action, at } of Array.isArray(answers) ? answers : []) {
    if (!['done', 'snooze'].includes(action)) continue;
    onAnswer(parseAlertId(id).taskId, action, { until: action === 'snooze' ? Number(at) + SNOOZE_MS : null });
  }
}
