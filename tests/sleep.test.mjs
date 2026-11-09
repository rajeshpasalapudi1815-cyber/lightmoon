// Checks docs/js/sleep.js (sleep mode, urgent list, the catch-up) and docs/js/meetings.js (the calendar link).
// Run: npm test
import assert from 'node:assert/strict';
const store = new Map();
globalThis.localStorage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
const { pathToFileURL, fileURLToPath } = await import('node:url');
const repo = fileURLToPath(new URL('..', import.meta.url)).replace(/[\/]$/, '');
const sleep = await import(pathToFileURL(`${repo}/docs/js/sleep.js`));
const { meetingUrl } = await import(pathToFileURL(`${repo}/docs/js/meetings.js`));
let failed = 0;
const test = (name, fn) => {
  try { fn(); console.log('ok  ', name); } catch (err) { failed++; console.log('FAIL', name, '\n     ', err.message); }
};

const values = {};
sleep.useSettings({ get: (k, f = '') => values[k] ?? f, set: (k, v) => { values[k] = String(v); } });
const reset = () => { for (const k of Object.keys(values)) delete values[k]; store.clear(); };
const at = (h, m = 0, day = 9) => new Date(2026, 10, day, h, m).getTime();

test('sleep hours overnight', () => {
  reset();
  sleep.setSleepHours('23:00', '06:30');
  assert.equal(sleep.isAsleep(at(22, 59)), false);
  assert.equal(sleep.isAsleep(at(23, 30)), true);
  assert.equal(sleep.sleepingSince(at(2, 0, 10)), at(23, 0, 9));
  assert.equal(sleep.isAsleep(at(6, 30)), false);
  assert.equal(sleep.isAsleep(at(14, 0)), false);
});

test('woken early stays awake until the next night', () => {
  reset();
  sleep.setSleepHours('23:00', '06:30');
  assert.equal(sleep.wakeUp(at(5, 0, 10)), at(23, 0, 9));
  assert.equal(sleep.isAsleep(at(5, 30, 10)), false);
  assert.equal(sleep.isAsleep(at(23, 10, 10)), true);
});

test('good night by voice, for a while or until woken', () => {
  reset();
  sleep.goToSleep(at(15, 0), at(13, 0));
  assert.equal(sleep.isAsleep(at(14, 0)), true);
  assert.equal(sleep.isAsleep(at(15, 1)), false);
  sleep.goToSleep(0, at(16, 0));
  assert.equal(sleep.isAsleep(at(20, 0)), true);
  assert.equal(sleep.wakeUp(at(20, 5)), at(16, 0));
  assert.equal(sleep.isAsleep(at(20, 6)), false);
  assert.equal(sleep.wakeUp(at(20, 7)), null);
});

test('urgent people and tasks', () => {
  reset();
  sleep.markUrgentPerson('Mom');
  sleep.markUrgentPerson('Asha Rani');
  sleep.markUrgentPerson('mom');
  assert.deepEqual(sleep.urgentPeople(), ['Asha Rani', 'mom']);
  assert.ok(sleep.isUrgentPerson('Asha'));
  assert.ok(sleep.isUrgentPerson('Mom'));
  assert.ok(!sleep.isUrgentPerson('Ravi'));
  sleep.markUrgentPerson('Mom', false);
  assert.ok(!sleep.isUrgentPerson('Mom'));
  assert.ok(sleep.isUrgentTask({ title: 'Emergency: pay the hospital' }));
  assert.ok(sleep.isUrgentTask({ title: 'x', urgent: true }));
  assert.ok(!sleep.isUrgentTask({ title: 'Buy milk' }));
});

test('held lines for the catch-up', () => {
  reset();
  sleep.hold('Sir, time to take tablets.', at(23, 30));
  sleep.hold('Sir, heads up: gym in 30 minutes.', at(5, 0, 10));
  const held = sleep.takeHeld(at(23, 0));
  assert.equal(held.length, 2);
  assert.equal(sleep.takeHeld(0).length, 0);
  const ask = sleep.catchUpRequest(at(23, 0), held);
  assert.match(ask, /tablets/);
  assert.match(ask, /urgent/);
});

test('meeting link', () => {
  const url = new URL(meetingUrl({ title: 'Plan with Ravi', at: '2026-11-10T16:00', minutes: 45, guests: ['ravi@example.com'], details: 'Pricing', account: 'me@gmail.com', timeZone: 'Asia/Kolkata' }));
  assert.equal(url.hostname, 'calendar.google.com');
  assert.equal(url.searchParams.get('dates'), '20261110T160000/20261110T164500');
  assert.equal(url.searchParams.get('add'), 'ravi@example.com');
  assert.equal(url.searchParams.get('authuser'), 'me@gmail.com');
  assert.equal(url.searchParams.get('ctz'), 'Asia/Kolkata');
  const late = new URL(meetingUrl({ title: 'x', at: '2026-11-10T23:45', minutes: 30, timeZone: 'Asia/Kolkata' }));
  assert.equal(late.searchParams.get('dates'), '20261110T234500/20261111T001500');
});

process.exit(failed ? 1 : 0);
