// Systems check: one list of what LightMoon needs to do its job, each checked now. Settings → "Is everything
// working?" shows it, "status report" says it (an instant command, no AI), and a quiet watch (app.js) tells them
// when something important breaks, instead of it failing silently for days (the Send helper switched off, the
// AI key refused, the wake-word helper not running, an old phone app).
// This file turns the facts app.js gathers into the list and the words. It reads nothing itself, so
// tests/status.test.mjs can check every line.

// app.js says how the facts are gathered (it has the microphone, the voices, the phone and the Listener); tools.js
// asks for them when "status report" is said.
let source = null;
export const useFacts = gather => { source = gather; };
export const gatherFacts = async () => (source ? source() : {});

const count = n => ['no', 'one', 'two', 'three', 'four', 'five', 'six'][n] ?? String(n);
const percent = level => `${Math.round(level * 100)} percent`;

export function describeAgo(ms, now = Date.now()) {
  const minutes = Math.round((now - ms) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 36 * 60) return `${Math.round(minutes / 60)} hours ago`;
  return `${Math.round(minutes / 1440)} days ago`;
}

const DAY_MS = 86_400_000;
export const LOW_BATTERY = 0.15;
const AI_TROUBLE_FRESH_MS = 30 * 60_000; // an AI failure older than this, with nothing since, isn't reported as "now"

// facts -> rows: { id, kind: 'ok' | 'warn' | 'bad', title, detail (for the screen), say (one spoken sentence when it
// isn't ok), tell (worth telling them unasked, once: the watch) }. A fact that is missing leaves its row out.
export function systemChecks(f, now = Date.now()) {
  const rows = [];
  const row = (id, kind, title, detail, say = '', tell = false) => rows.push({ id, kind, title, detail, say: kind === 'ok' ? '' : say, tell: kind !== 'ok' && tell });
  const here = f.device === 'phone' ? 'phone' : 'computer';

  if (f.ai) {
    const trouble = f.ai.problem && now - (f.ai.problemAt ?? 0) < AI_TROUBLE_FRESH_MS && (f.ai.problemAt ?? 0) > (f.ai.okAt ?? 0) ? f.ai.problem : null;
    if (!f.ai.ready) row('ai', 'bad', 'AI', 'No API key yet', "My brain isn't connected: there is no API key. Instant commands still work.");
    else if (trouble === 'auth') row('ai', 'bad', 'AI', 'The AI service refused the API key', 'The AI service is refusing the API key, so I can only do instant commands until it is fixed in Settings.', true);
    else if (trouble === 'limit') row('ai', 'warn', 'AI', `At the free limit just now (${f.ai.model})`, 'The AI is at its free limit right now; it comes back in a few minutes.');
    else if (trouble === 'network') row('ai', 'warn', 'AI', "Couldn't reach the AI service just now", "I couldn't reach the AI service a moment ago.");
    else row('ai', 'ok', 'AI', `Ready (${f.ai.model})`);
  }
  if (f.online != null) {
    row('internet', f.online ? 'ok' : 'warn', 'Internet', f.online ? 'Connected' : 'Offline: reminders still ring, and instant commands work',
      'There is no internet connection, so only reminders and instant commands work.');
  }
  if (f.voices != null) row('voice', f.voices ? 'ok' : 'warn', 'Voice', f.voices ? f.voice || "The device's own voice" : 'No voices found yet', "I can't find a voice to speak with on this device.");
  if (f.mic) {
    row('mic', f.mic === 'denied' ? 'bad' : f.mic === 'granted' ? 'ok' : 'warn', 'Microphone',
      { granted: 'Allowed', denied: `Blocked: allow it in the ${here === 'phone' ? 'phone' : 'browser'} settings for LightMoon`, prompt: 'Asked for the first time you tap the eyes', unknown: 'Unknown' }[f.mic] ?? 'Unknown',
      f.mic === 'denied' ? "The microphone is blocked, so I can't hear you." : '', f.mic === 'denied');
  }

  if (f.alarms) {
    row('notifications', f.alarms.notifications ? 'ok' : 'bad', 'Notifications', f.alarms.notifications ? 'Allowed' : 'Blocked: reminders are only spoken',
      'Notifications are blocked on the phone, so reminders are only spoken.');
    row('alarms', f.alarms.exactAlarms ? 'ok' : 'warn', 'Reminder alarms',
      f.alarms.exactAlarms ? `On time, ${f.alarms.upcoming ?? 0} coming up` : 'May ring a few minutes late (exact alarms are off)', 'Reminders may ring a few minutes late: exact alarms are off.');
    row('background', f.alarms.batteryUnrestricted ? 'ok' : 'bad', 'Battery saving', f.alarms.batteryUnrestricted ? 'Unrestricted' : 'The phone may stop LightMoon in the background',
      'Battery saving may stop me in the background, so reminders and the wake word can fail.', true);
    row('background-sync', f.alarms.backgroundSync ? 'ok' : 'warn', 'Background sync', f.alarms.backgroundSync ? 'Every 15 minutes' : 'Off until sync is set up');
  } else if (f.notifications) {
    row('notifications', f.notifications === 'granted' ? 'ok' : f.notifications === 'denied' ? 'bad' : 'warn', 'Notifications',
      { granted: 'Allowed', denied: 'Blocked in the browser', default: 'Not asked yet', unsupported: 'Not available in this browser' }[f.notifications] ?? 'Unknown',
      f.notifications === 'denied' ? 'Notifications are blocked in the browser.' : '');
  }
  if (f.storage != null) row('storage', f.storage ? 'ok' : 'warn', 'Storage', f.storage ? 'Protected from browser clean-ups' : 'The browser may clear it when space runs low');

  if (f.wake?.modelReady) {
    const name = f.name || 'LightMoon';
    row('wake', f.wake.enabled && f.wake.listening ? 'ok' : f.wake.enabled ? 'warn' : 'bad', `Saying "${name}"`,
      f.wake.enabled ? (f.wake.listening ? 'Listening for its name' : 'On, starts listening when the app is in the background') : "Off: saying its name won't open the app",
      f.wake.enabled ? '' : "The wake word is off, so saying my name won't wake me on the phone.");
  }
  if (f.listener?.wanted) {
    row('listener', f.listener.connected ? 'ok' : 'bad', 'Wake-word helper', f.listener.connected ? 'Running on this computer' : 'Not running: saying its name does nothing here',
      "The wake-word helper on this computer isn't running, so saying my name does nothing here. Start LightMoon Listener from the Start menu.", true);
  }
  if (f.phone) {
    const wants = f.phone.readMessages && f.phone.readMessages !== 'off';
    row('messages', !wants || f.phone.messages ? 'ok' : 'bad', 'Message reading', !wants ? 'Off' : f.phone.messages ? 'Connected' : 'Notification access is off',
      "I can't read your messages: notification access is switched off on the phone.", true);
    row('calls', f.phone.announceCalls && !f.phone.calls ? 'warn' : 'ok', 'Calls',
      !f.phone.announceCalls ? 'Not announced' : f.phone.calls ? 'Announced' : "Announcing is on, but calls aren't allowed", "I can't announce calls: the phone permission is missing.");
  }
  if (f.sendHelper) {
    row('send-helper', f.sendHelper.enabled ? 'ok' : 'warn', 'Send helper', f.sendHelper.enabled ? 'On' : "Off: LightMoon can't press Send in WhatsApp",
      "The Send helper is off, so I can't press Send in WhatsApp for you. It is in the phone's Accessibility settings.", true);
  }

  if (f.sync) {
    if (!f.sync.on) row('sync', 'ok', 'Sync', 'Off (this device only)');
    else if (f.sync.error) row('sync', 'bad', 'Sync', f.sync.error, `Sync between your devices has a problem: ${f.sync.error}`, true);
    else {
      const stale = f.sync.lastSync && now - f.sync.lastSync > DAY_MS;
      row('sync', stale ? 'warn' : 'ok', 'Sync', f.sync.lastSync ? `Last synced ${describeAgo(f.sync.lastSync, now)}` : 'On',
        `This ${here} last synced ${describeAgo(f.sync.lastSync ?? now, now)}.`);
    }
  }
  if (f.battery?.level != null) {
    const low = f.battery.level <= LOW_BATTERY && !f.battery.charging;
    row('battery', low ? 'warn' : 'ok', 'Power', `${Math.round(f.battery.level * 100)}%${f.battery.charging ? ', charging' : ''}`,
      `This ${here} is at ${percent(f.battery.level)} and not charging.`, true);
  }
  if (f.app?.installed && f.app.latest && f.app.installed !== f.app.latest) {
    row('app', 'warn', 'Phone app', `${f.app.installed} installed; ${f.app.latest} is out`, `The phone app is out of date: it is ${f.app.installed}, and ${f.app.latest} is out.`, true);
  }
  if (f.offlineBrain) row('offline-brain', 'ok', 'Offline brain', { ready: 'Downloaded and ready', downloading: 'Downloading…' }[f.offlineBrain] ?? 'Not downloaded (optional)');
  if (f.problems != null) row('problems', f.problems ? 'warn' : 'ok', 'Problems in the last 24 hours', f.problems ? `${f.problems}, listed below` : 'None');
  if (f.version) {
    row('version', 'ok', 'Version', f.version.waiting ? `${f.version.current}; ${f.version.waiting} is ready` : f.version.current);
  }
  return rows;
}

// What LightMoon says for "status report": what is broken first, then the catches, then how it is set, power, and
// the day in a line. `day`: { open, overdue, next: 'call the bank at 5 PM' }; `modes`: lines such as "Sleep mode is on".
export function statusReport(rows, { address = 'boss', modes = [], day = null, battery = null, device = 'computer' } = {}) {
  const bad = rows.filter(r => r.kind === 'bad' && r.say);
  const catches = rows.filter(r => r.kind === 'warn' && r.say && r.id !== 'battery');
  const lines = [];
  if (!bad.length && !catches.length) lines.push(`All systems are working, ${address}.`);
  else if (bad.length) {
    const many = count(bad.length);
    lines.push(`${bad.length === 1 ? 'One thing is' : `${many.charAt(0).toUpperCase()}${many.slice(1)} things are`} not working, ${address}. ${bad.map(r => r.say).join(' ')}`);
    if (catches.length) lines.push(`Also: ${catches.map(r => r.say).join(' ')}`);
  } else {
    lines.push(`Everything is running, ${address}, with ${catches.length === 1 ? 'one catch' : `${count(catches.length)} catches`}. ${catches.map(r => r.say).join(' ')}`);
  }
  if (battery?.level != null) {
    lines.push(`The ${device === 'phone' ? 'phone' : 'computer'} is at ${percent(battery.level)}${battery.charging ? ', charging' : battery.level <= LOW_BATTERY ? ', and needs its charger' : ''}.`);
  }
  if (modes.length) lines.push(modes.join(' '));
  if (day) {
    const tasks = day.open ? `${count(day.open)} task${day.open === 1 ? '' : 's'} open${day.overdue ? `, ${count(day.overdue)} overdue` : ''}` : 'Nothing open on your list';
    lines.push(`${tasks.charAt(0).toUpperCase()}${tasks.slice(1)}.${day.next ? ` Next: ${day.next}.` : ''}`);
  }
  return lines.join(' ').replace(/\s+/g, ' ').trim();
}

// The short labels shown under the report: "AI ✓", "Send helper ✗".
export const statusChips = rows => rows.filter(r => r.kind !== 'ok' || ['ai', 'internet', 'sync', 'listener', 'wake'].includes(r.id))
  .map(r => `${r.title} ${r.kind === 'ok' ? '✓' : r.kind === 'warn' ? '!' : '✗'}`);

// The watch: which troubles to tell them about now. Each is told once while it lasts; after it was put right it can
// be told again, but never twice within TELL_AGAIN_MS (a battery hovering around the mark isn't announced all day).
// `told`: { id: { at, open } }, kept by app.js; returns the rows to say and the new `told`.
export const TELL_AGAIN_MS = 20 * 3600_000;
export function newTroubles(rows, told = {}, now = Date.now()) {
  const next = {};
  const tell = [];
  const troubled = new Set();
  for (const r of rows) {
    if (!r.tell) continue;
    troubled.add(r.id);
    const before = told[r.id];
    if (before && (before.open || now - before.at < TELL_AGAIN_MS)) next[r.id] = { at: before.at, open: true };
    else {
      next[r.id] = { at: now, open: true };
      tell.push(r);
    }
  }
  for (const [id, before] of Object.entries(told)) {
    if (!troubled.has(id) && now - before.at < TELL_AGAIN_MS) next[id] = { at: before.at, open: false }; // put right: remembered a while
  }
  return { tell, told: next };
}
