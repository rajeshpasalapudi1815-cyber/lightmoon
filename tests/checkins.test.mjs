// Logic test for LightMoon's reminder check-ins (docs/js/announce.js, store.js). Run: npm test
import assert from 'node:assert/strict';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';

const repo = fileURLToPath(new URL('..', import.meta.url)).replace(/[\/]$/, '');
// Pretend it's tomorrow at 12:30, so the check-ins don't fall in the quiet hours.
const RealDate = Date;
const noon = new RealDate(); noon.setDate(noon.getDate() + 1); noon.setHours(12, 30, 0, 0);
const SHIFT = noon.getTime() - RealDate.now();
globalThis.Date = class extends RealDate {
  constructor(...args) { if (args.length) super(...args); else super(RealDate.now() + SHIFT); }
  static now() { return RealDate.now() + SHIFT; }
};
const mem = new Map();
globalThis.localStorage = {
  getItem: k => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: k => mem.delete(k),
  key: i => [...mem.keys()][i],
  get length() { return mem.size; },
};
const load = file => import(pathToFileURL(path.join(repo, 'docs', 'js', file)).href);
const store = await load('store.js');
const { checkInsOf, checkInLine, parseAlertId, isQuietTime } = await load('announce.js');
const { localStamp } = await load('time.js');

const results = [];
const check = (name, fn) => { try { fn(); results.push(`ok   ${name}`); } catch (err) { results.push(`FAIL ${name}: ${err.message}`); } };
const at = minutesAgo => localStamp(new Date(Date.now() - minutesAgo * 60_000));
const daytime = !isQuietTime(Date.now()) && !isQuietTime(Date.now() + 2 * 3600_000) && !isQuietTime(Date.now() - 2 * 3600_000);

store.saveProfile({ userName: 'Rajesh', address: 'boss', assistantName: 'LightMoon' });

check('ids', () => {
  assert.deepEqual(parseAlertId('abc123-c2'), { taskId: 'abc123', n: 2 });
  assert.deepEqual(parseAlertId('abc123'), { taskId: 'abc123', n: 0 });
  assert.deepEqual(parseAlertId('test-1793290640187'), { taskId: 'test-1793290640187', n: 0 });
});

check('quiet hours', () => {
  const night = new Date(); night.setHours(23, 30, 0, 0);
  const morning = new Date(); morning.setHours(7, 0, 0, 0);
  assert.equal(isQuietTime(night.getTime()), true);
  assert.equal(isQuietTime(morning.getTime()), false);
});

check('lines', () => {
  const task = { title: 'Take tablets', check_in: 'did you take your tablets?' };
  assert.equal(checkInLine(task, { address: 'boss' }, 1), 'Boss, just checking: did you take your tablets?');
  assert.equal(checkInLine({ title: 'Call mum' }, {}, 2), 'Sir, checking again: did you get to "Call mum"? Tell me when it\'s done, or say snooze.');
  assert.match(checkInLine(task, { address: 'name', user_name: 'rajesh' }, 3), /^Rajesh, one last check: .* I'll leave it with you after this\.$/);
});

check('schedule: three check-ins, none for heads-ups, done or answered', () => {
  const base = { id: 'aaa111', title: 'x', remind_at: localStamp(new Date(2026, 9, 30, 10, 0)) };
  assert.deepEqual(checkInsOf(base).map(c => c.id), ['aaa111-c1', 'aaa111-c2', 'aaa111-c3']);
  assert.equal(checkInsOf({ ...base, check_in: false }).length, 0);
  assert.equal(checkInsOf({ ...base, done: true }).length, 0);
  assert.equal(checkInsOf({ ...base, answered: true }).length, 0);
  assert.equal(checkInsOf(base, { reminder_checks: 'off' }).length, 0);
  assert.deepEqual(checkInsOf({ ...base, checked_in: 2 }).map(c => c.n), [3]);
  const late = { ...base, remind_at: localStamp(new Date(2026, 9, 30, 22, 30)) }; // 22:45 ok, 23:15 and 00:00 quiet
  assert.deepEqual(checkInsOf(late).map(c => c.n), [1]);
});

if (daytime) {
  check('a reminder that rang 16 min ago gets check-in 1, once', () => {
    store.tasks.add({ title: 'Take tablets', remindAt: at(16), checkIn: 'did you take your tablets?' });
    const task = store.tasks.open().find(t => t.title === 'Take tablets');
    const due = store.tasks.takeDueReminders(); // the reminder itself (the app was closed): check-in 1 counted as said
    assert.equal(due.length, 1);
    assert.equal(store.tasks.get(task.id).checked_in, 1);
    assert.equal(store.tasks.takeDueCheckIns().length, 0);
    store.tasks.get(task.id).checked_in = 0; // as if it had been announced on time
    const checks = store.tasks.takeDueCheckIns();
    assert.equal(checks.length, 1);
    assert.equal(checks[0].say, 'Boss, just checking: did you take your tablets?');
    assert.equal(store.tasks.takeDueCheckIns().length, 0, 'said once');
    assert.equal(store.tasks.waitingForAnswer().length, 1);
  });

  check('a long-missed check-in is skipped quietly', () => {
    store.tasks.add({ title: 'Old one', remindAt: at(80) });
    const task = store.tasks.open().find(t => t.title === 'Old one');
    store.tasks.markReminded(task.id);
    assert.equal(store.tasks.takeDueCheckIns().filter(c => c.task.id === task.id).length, 0); // c2 at -35 min: too late
    assert.equal(store.tasks.get(task.id).checked_in, 2);
  });

  check('snooze starts over; stop asking ends it; done ends it', () => {
    const task = store.tasks.open().find(t => t.title === 'Take tablets');
    const before = task.updated_at;
    store.tasks.snooze(task.id, at(-10));
    const snoozed = store.tasks.get(task.id);
    assert.equal(snoozed.reminded, false);
    assert.equal(snoozed.checked_in, 0);
    assert.ok(snoozed.updated_at > before);
    assert.equal(store.tasks.alertsSince(Date.now()).filter(a => parseAlertId(a.id).taskId === task.id).length, 4); // ring + 3
    store.tasks.stopCheckingIn(task.id);
    assert.equal(store.tasks.alertsSince(Date.now()).filter(a => parseAlertId(a.id).taskId === task.id).length, 1); // ring only
    store.tasks.complete(task.id);
    assert.equal(store.tasks.alertsSince(0).filter(a => parseAlertId(a.id).taskId === task.id).length, 0);
  });

  check('saying a check-in does not undo Done from another device', () => {
    store.tasks.add({ title: 'Pay the bill', remindAt: at(16) });
    const task = store.tasks.open().find(t => t.title === 'Pay the bill');
    store.tasks.markReminded(task.id);
    const phoneCopy = { ...store.tasks.get(task.id), done: true, done_at: at(0), updated_at: Date.now() + 5 }; // Done tapped on the phone
    store.tasks.takeDueCheckIns(); // this device says check-in 1 afterwards, before syncing
    const data = JSON.parse(localStorage.getItem('assistant.data.v1'));
    store.mergeIn({ ...data, tasks: data.tasks.map(t => (t.id === task.id ? phoneCopy : t)) });
    assert.equal(store.tasks.get(task.id).done, true);
    assert.equal(store.tasks.get(task.id).checked_in, 1, 'what was said is kept');
  });
} else {
  results.push('skip time-of-day tests (it is quiet hours now)');
}

console.log(results.join('\n'));
if (results.some(r => r.startsWith('FAIL'))) process.exitCode = 1;
