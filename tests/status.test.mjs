// Checks docs/js/status.js: the systems check, what "status report" says, and what the watch tells unasked.
// Run: npm test
import assert from 'node:assert/strict';
const { pathToFileURL, fileURLToPath } = await import('node:url');
const repo = fileURLToPath(new URL('..', import.meta.url)).replace(/[\/]$/, '');
const s = await import(pathToFileURL(`${repo}/docs/js/status.js`));
let failed = 0;
const test = (name, fn) => {
  try { fn(); console.log('ok  ', name); } catch (err) { failed++; console.log('FAIL', name, '\n     ', err.message); }
};
const now = Date.UTC(2026, 10, 13, 9, 0);
const good = {
  device: 'phone', name: 'LightMoon', ai: { ready: true, model: 'gpt-oss-120b', okAt: now - 1000 }, online: true, voices: 5, voice: 'English (India)', mic: 'granted',
  alarms: { notifications: true, exactAlarms: true, batteryUnrestricted: true, backgroundSync: true, upcoming: 3 }, wake: { modelReady: true, enabled: true, listening: true },
  phone: { readMessages: 'sender', messages: true, announceCalls: true, calls: true }, sendHelper: { enabled: true }, sync: { on: true, lastSync: now - 120_000 },
  battery: { level: 0.62, charging: true }, problems: 0, version: { current: 'v99' },
};
const broken = {
  ...good, ai: { ready: true, model: 'm', problem: 'auth', problemAt: now - 60_000, okAt: now - 3_600_000 }, sendHelper: { enabled: false },
  sync: { on: true, lastSync: now - 3 * 86_400_000 }, battery: { level: 0.12, charging: false }, app: { installed: '1.34', latest: '1.36' },
};

test('all well', () => {
  const rows = s.systemChecks(good, now);
  assert.ok(rows.every(r => r.kind === 'ok'), rows.filter(r => r.kind !== 'ok').map(r => r.id).join());
  assert.equal(s.statusReport(rows, { address: 'boss', battery: good.battery, device: 'phone', day: { open: 3, overdue: 1, next: 'call the bank at 5 PM' } }),
    'All systems are working, boss. The phone is at 62 percent, charging. Three tasks open, one overdue. Next: call the bank at 5 PM.');
});

test('what is broken is said first, then the catches', () => {
  const rows = s.systemChecks(broken, now);
  const kinds = Object.fromEntries(rows.map(r => [r.id, r.kind]));
  assert.equal(kinds.ai, 'bad');
  assert.equal(kinds['send-helper'], 'warn');
  assert.equal(kinds.sync, 'warn');
  assert.equal(kinds.battery, 'warn');
  assert.equal(kinds.app, 'warn');
  const said = s.statusReport(rows, { address: 'boss', battery: broken.battery, device: 'phone', modes: ['Hindi practice is on.'] });
  assert.match(said, /^One thing is not working, boss\. The AI service is refusing the API key/);
  assert.match(said, /Also: The Send helper is off/);
  assert.match(said, /1\.34, and 1\.36 is out/);
  assert.match(said, /12 percent, and needs its charger/);
  assert.match(said, /Hindi practice is on\./);
  assert.ok(s.statusChips(rows).includes('AI ✗'));
});

test('an old AI failure, or one with a good answer since, is not reported', () => {
  const rows = s.systemChecks({ ai: { ready: true, model: 'm', problem: 'limit', problemAt: now - 60_000, okAt: now - 1000 } }, now);
  assert.equal(rows[0].kind, 'ok');
  const stale = s.systemChecks({ ai: { ready: true, model: 'm', problem: 'auth', problemAt: now - 2 * 3_600_000, okAt: 0 } }, now);
  assert.equal(stale[0].kind, 'ok');
});

test('the computer: the wake-word helper', () => {
  const rows = s.systemChecks({ device: 'computer', ai: { ready: true, model: 'm' }, online: true, listener: { wanted: true, connected: false }, sync: { on: false } }, now);
  assert.match(s.statusReport(rows, { address: 'sir' }), /^One thing is not working, sir\. The wake-word helper on this computer isn't running/);
  assert.equal(s.systemChecks({ listener: { wanted: false, connected: false } }, now).length, 0, 'never used here: not a fault');
});

test('the watch tells each trouble once, and again only after it was put right', () => {
  const troubled = s.systemChecks(broken, now);
  const first = s.newTroubles(troubled, {}, now);
  assert.deepEqual(first.tell.map(r => r.id), ['ai', 'send-helper', 'battery', 'app']);
  const second = s.newTroubles(troubled, first.told, now + 300_000);
  assert.deepEqual(second.tell, [], 'still broken: said already');
  const fixed = s.newTroubles(s.systemChecks(good, now), second.told, now + 600_000);
  assert.deepEqual(fixed.tell, []);
  const flapping = s.newTroubles(troubled, fixed.told, now + 900_000);
  assert.deepEqual(flapping.tell, [], 'broke again within the day: not announced twice');
  const nextDay = s.newTroubles(troubled, fixed.told, now + 21 * 3_600_000);
  assert.deepEqual(nextDay.tell.map(r => r.id), ['ai', 'send-helper', 'battery', 'app']);
});

if (failed) { console.log(`${failed} failed`); process.exit(1); }
