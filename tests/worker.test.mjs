// Checks cloud/src/worker.js, the cloud service, against a real SQLite database standing in for Cloudflare's D1:
// that sync, reminders, connected apps and backups work as the apps expect, and that the service protects itself
// (sizes, new spaces per caller, ceilings, a lock-out that only hits the guesser, fair pushes, tidying up).
// Nothing here touches the real service. Run: npm test
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
const { pathToFileURL, fileURLToPath } = await import('node:url');
const repo = fileURLToPath(new URL('..', import.meta.url)).replace(/[\/]$/, '');

// ---------- A stand-in for D1 ----------
const db = new DatabaseSync(':memory:');
const statement = (sql, params = []) => ({
  bind: (...values) => statement(sql, values),
  async first() {
    const row = db.prepare(sql).get(...params);
    return row === undefined ? null : { ...row };
  },
  async all() {
    return { results: db.prepare(sql).all(...params).map(row => ({ ...row })) };
  },
  async run() {
    return { meta: { changes: Number(db.prepare(sql).run(...params).changes) } };
  },
});
const DB = {
  prepare: sql => statement(sql),
  async batch(list) {
    db.exec('BEGIN');
    try {
      const out = [];
      for (const item of list) out.push(await item.run());
      db.exec('COMMIT');
      return out;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  },
};
const rows = (sql, ...params) => db.prepare(sql).all(...params);
const count = (sql, ...params) => Number(Object.values(db.prepare(sql).get(...params))[0]);

// ---------- The world around it: the clock, the push services ----------
const realNow = Date.now;
let clock = Date.UTC(2026, 10, 13, 9, 3, 0); // 09:03: not a "tidy up" minute
Date.now = () => clock;
const pushed = [];
let pushStatus = () => 201;
globalThis.fetch = async (url, options) => {
  pushed.push(String(url));
  return new Response('', { status: pushStatus(String(url), options) });
};
const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const env = {
  DB,
  ALLOWED_ORIGINS: 'https://app.example',
  VAPID_SUBJECT: 'https://app.example/',
  VAPID_PUBLIC_KEY: 'test-public-key',
  VAPID_PRIVATE_JWK: JSON.stringify(await crypto.subtle.exportKey('jwk', pair.privateKey)),
};

// ---------- Before this version ever ran: spaces that were already in use ----------
const hex = (seed, length = 64) => seed.repeat(Math.ceil(length / seed.length)).slice(0, length);
const OLD_SYNCED = hex('a1');
const OLD_PUSH_ONLY = hex('b2');
const OLD_STORED_ONCE = hex('b3'); // an old sync code of theirs, stored once long ago and left
db.exec(`CREATE TABLE spaces (id TEXT PRIMARY KEY, version INTEGER NOT NULL, blob TEXT NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE devices (space_id TEXT NOT NULL, device_id TEXT NOT NULL, subscription TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (space_id, device_id));`);
db.prepare('INSERT INTO spaces VALUES (?, 57, ?, ?)').run(OLD_SYNCED, 'their-encrypted-data', clock - 1000);
db.prepare('INSERT INTO spaces VALUES (?, 1, ?, ?)').run(OLD_STORED_ONCE, 'an-old-copy', clock - 90 * 86_400_000);
db.prepare('INSERT INTO devices VALUES (?, ?, ?, ?)').run(OLD_PUSH_ONLY, 'device-old-1', JSON.stringify({ endpoint: 'https://fcm.googleapis.com/fcm/send/old' }), clock - 1000);

const worker = (await import(pathToFileURL(`${repo}/cloud/src/worker.js`))).default;

let failed = 0;
const test = async (name, fn) => {
  try { await fn(); console.log('ok  ', name); } catch (err) { failed++; console.log('FAIL', name, '\n     ', err.message); }
};
// One request, from `ip`: -> { status, body }.
async function call(method, path, body, { ip = '203.0.113.1', headers = {}, raw = null } = {}) {
  const request = new Request(`https://cloud.example${path}`, {
    method,
    headers: { 'CF-Connecting-IP': ip, ...(body !== undefined && { 'Content-Type': 'application/json' }), ...headers },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    ...(raw && typeof raw !== 'string' && { duplex: 'half' }),
  });
  const response = await worker.fetch(request, env);
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: response.status, body: data };
}
const runMinute = async () => {
  let work = null;
  await worker.scheduled({}, env, { waitUntil: promise => { work = promise; } });
  await work;
};
let spaceCounter = 0;
const newSpace = () => (++spaceCounter).toString(16).padStart(4, '0').repeat(16);
const KEY = 'k'.repeat(43);
const WRONG = 'w'.repeat(43);

await test('what was in use before is on the list from the first request, and never counts as new', async () => {
  assert.equal((await call('GET', '/vapid-public-key')).body.key, 'test-public-key');
  assert.deepEqual(rows('SELECT id, created_at FROM seen_spaces ORDER BY id').map(r => ({ ...r })), [
    { id: OLD_SYNCED, created_at: 0 }, { id: OLD_PUSH_ONLY, created_at: 0 }, { id: OLD_STORED_ONCE, created_at: 0 },
  ]);
  const saved = await call('PUT', `/spaces/${OLD_SYNCED}/data`, { version: 57, blob: 'newer' });
  assert.deepEqual(saved, { status: 200, body: { version: 58 } });
  assert.equal(count('SELECT COUNT(*) FROM creations'), 0, 'not a new space');
});

await test('sync: store, read, and a stale write gets the newer copy back', async () => {
  const space = newSpace();
  assert.equal((await call('GET', `/spaces/${space}/data`)).status, 404);
  assert.deepEqual((await call('PUT', `/spaces/${space}/data`, { version: 0, blob: 'one' })).body, { version: 1 });
  assert.deepEqual((await call('GET', `/spaces/${space}/data`)).body, { version: 1, blob: 'one' });
  assert.deepEqual((await call('PUT', `/spaces/${space}/data`, { version: 1, blob: 'two' })).body, { version: 2 });
  const stale = await call('PUT', `/spaces/${space}/data`, { version: 1, blob: 'late' });
  assert.equal(stale.status, 409);
  assert.deepEqual(stale.body, { version: 2, blob: 'two' });
  assert.equal((await call('PUT', `/spaces/${space}/data`, { version: -1, blob: 'x' })).status, 400);
});

await test('connected apps: feed, inbox (claimed once) and whose turn it is', async () => {
  const space = newSpace();
  assert.equal((await call('PUT', `/spaces/${space}/feeds/lifelevelling`, { blob: 'summary' })).status, 204);
  assert.equal((await call('GET', `/spaces/${space}/feeds/lifelevelling`)).body.blob, 'summary');
  assert.equal((await call('POST', `/spaces/${space}/inbox/lifelevelling`, { id: 'item-0001', blob: 'do this' })).status, 204);
  assert.deepEqual((await call('GET', `/spaces/${space}/inbox/lifelevelling`)).body.items.map(i => i.id), ['item-0001']);
  assert.deepEqual((await call('DELETE', `/spaces/${space}/inbox/lifelevelling/item-0001`)).body, { removed: true });
  assert.deepEqual((await call('DELETE', `/spaces/${space}/inbox/lifelevelling/item-0001`)).body, { removed: false });
  const first = await call('PUT', `/spaces/${space}/turns/lifelevelling`, { device: 'phone-device-1' });
  assert.equal(first.body.device, 'phone-device-1');
  assert.equal((await call('PUT', `/spaces/${space}/turns/lifelevelling`, { device: 'laptop-device-2' })).body.device, 'phone-device-1', 'the phone still has it');
  clock += 4 * 60_000;
  assert.equal((await call('PUT', `/spaces/${space}/turns/lifelevelling`, { device: 'laptop-device-2' })).body.device, 'laptop-device-2', 'it stopped asking: the laptop takes over');
});

await test('a due reminder wakes the device with a push that carries nothing', async () => {
  const space = newSpace();
  await call('PUT', `/spaces/${space}/devices/device-push-1`, { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { auth: 'never-kept' } } });
  assert.equal((await call('PUT', `/spaces/${space}/devices/device-push-2`, { subscription: { endpoint: 'https://evil.example/collect' } })).status, 400, 'only real push services');
  assert.equal(rows('SELECT subscription FROM devices WHERE space_id = ?', space)[0].subscription, JSON.stringify({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc' }));
  await call('PUT', `/spaces/${space}/reminders`, { reminders: [{ id: 'r1', at: clock - 1000 }, { id: 'r2', at: clock + 3_600_000 }] });
  pushed.length = 0;
  await runMinute();
  assert.deepEqual(pushed, ['https://fcm.googleapis.com/fcm/send/abc']);
  assert.deepEqual(rows('SELECT reminder_id, sent FROM reminders WHERE space_id = ? ORDER BY reminder_id', space).map(r => ({ ...r })), [
    { reminder_id: 'r1', sent: 1 }, { reminder_id: 'r2', sent: 0 },
  ]);
  pushed.length = 0;
  await runMinute();
  assert.deepEqual(pushed, [], 'sent once');
});

await test('backups: made by the first upload, opened only with the key', async () => {
  const id = hex('c3');
  assert.equal((await call('GET', `/backups/${id}`, undefined, { headers: { 'X-Backup-Key': KEY } })).status, 404);
  assert.equal((await call('PUT', `/backups/${id}`, { blob: 'sealed' })).status, 401, 'no key, no backup');
  const made = await call('PUT', `/backups/${id}`, { blob: 'sealed', ifUpdatedAt: 0 }, { headers: { 'X-Backup-Key': KEY } });
  assert.equal(made.status, 200);
  assert.equal((await call('GET', `/backups/${id}`, undefined, { headers: { 'X-Backup-Key': KEY } })).body.blob, 'sealed');
  assert.equal((await call('GET', `/backups/${id}/meta`, undefined, { headers: { 'X-Backup-Key': KEY } })).body.size, 6);
  assert.equal((await call('GET', `/backups/${id}`, undefined, { headers: { 'X-Backup-Key': WRONG } })).status, 403);
  assert.equal((await call('PUT', `/backups/${id}`, { blob: 'other', ifUpdatedAt: 0 }, { headers: { 'X-Backup-Key': KEY } })).status, 409, 'it changed since they last saw it');
  assert.equal((await call('DELETE', `/backups/${id}`, undefined, { headers: { 'X-Backup-Key': KEY } })).status, 204);
  assert.equal(count('SELECT COUNT(*) FROM backups WHERE id = ?', id), 0);
});

await test('wrong backup keys lock out the guesser, never the owner', async () => {
  const id = hex('d4');
  const owner = { ip: '198.51.100.7', headers: { 'X-Backup-Key': KEY } };
  const guesser = { ip: '192.0.2.66', headers: { 'X-Backup-Key': WRONG } };
  await call('PUT', `/backups/${id}`, { blob: 'sealed' }, owner);
  for (let i = 0; i < 10; i++) assert.equal((await call('GET', `/backups/${id}`, undefined, guesser)).status, 403);
  assert.equal((await call('GET', `/backups/${id}`, undefined, guesser)).status, 429, 'the guesser is locked out');
  assert.equal((await call('GET', `/backups/${id}`, undefined, { ip: guesser.ip, headers: { 'X-Backup-Key': KEY } })).status, 429, 'even with the right key, from there, for a while');
  assert.equal((await call('GET', `/backups/${id}`, undefined, owner)).status, 200, 'the owner still gets in');
  assert.equal((await call('PUT', `/backups/${id}`, { blob: 'newer' }, owner)).status, 200);
  clock += 16 * 60_000;
  assert.equal((await call('GET', `/backups/${id}`, undefined, { ip: guesser.ip, headers: { 'X-Backup-Key': KEY } })).status, 200, 'the lock passes');
});

await test('a body is refused by its size before, or while, it arrives', async () => {
  const space = newSpace();
  const declared = await call('PUT', `/spaces/${space}/data`, undefined, { headers: { 'Content-Length': '3000000', 'Content-Type': 'application/json' }, raw: '{}' });
  assert.equal(declared.status, 413);
  const chunk = new TextEncoder().encode('x'.repeat(256_000));
  let sent = 0;
  const endless = new ReadableStream({ pull(controller) { sent += chunk.byteLength; controller.enqueue(chunk); } });
  const streamed = await call('PUT', `/spaces/${space}/data`, undefined, { raw: endless });
  assert.equal(streamed.status, 413);
  assert.ok(sent < 4_000_000, `stopped reading soon after the limit (read ${sent})`);
  assert.equal((await call('PUT', `/spaces/${space}/data`, { version: 0, blob: 'y'.repeat(1_500_001) })).status, 400, 'a blob over the limit');
  assert.equal(count('SELECT COUNT(*) FROM seen_spaces WHERE id = ?', space), 0, 'nothing was stored, so the space took no room');
});

await test('one caller can start only so many new spaces a day; spaces in use carry on', async () => {
  const ip = '192.0.2.10';
  const mine = [];
  for (let i = 0; i < 10; i++) {
    const space = newSpace();
    mine.push(space);
    assert.equal((await call('PUT', `/spaces/${space}/data`, { version: 0, blob: 'x' }, { ip })).status, 200, `space ${i + 1}`);
  }
  assert.equal((await call('PUT', `/spaces/${newSpace()}/data`, { version: 0, blob: 'x' }, { ip })).status, 429, 'the eleventh');
  assert.equal((await call('PUT', `/spaces/${newSpace()}/feeds/app`, { blob: 'x' }, { ip })).status, 429, 'by any door');
  assert.equal((await call('PUT', `/spaces/${newSpace()}/reminders`, { reminders: [{ id: 'r', at: clock + 60_000 }] }, { ip })).status, 429);
  assert.equal((await call('PUT', `/spaces/${newSpace()}/reminders`, { reminders: [] }, { ip })).status, 204, 'an empty list stores nothing and needs no room');
  assert.deepEqual((await call('PUT', `/spaces/${mine[0]}/data`, { version: 1, blob: 'again' }, { ip })).body, { version: 2 }, 'their own spaces still work');
  assert.equal((await call('PUT', `/spaces/${newSpace()}/data`, { version: 0, blob: 'x' }, { ip: '192.0.2.11' })).status, 200, 'someone else is not held up');
  clock += 86_400_000;
  assert.equal((await call('PUT', `/spaces/${newSpace()}/data`, { version: 0, blob: 'x' }, { ip })).status, 200, 'tomorrow is a new day');
});

await test('there is room for only so many spaces in all', async () => {
  const before = count('SELECT COUNT(*) FROM seen_spaces');
  const insert = db.prepare('INSERT INTO seen_spaces (id, created_at) VALUES (?, ?)');
  for (let i = before; i < 300; i++) insert.run(`f${i.toString(16).padStart(63, '0')}`, clock);
  assert.equal((await call('PUT', `/spaces/${newSpace()}/data`, { version: 0, blob: 'x' }, { ip: '192.0.2.20' })).status, 507);
  assert.deepEqual((await call('PUT', `/spaces/${OLD_SYNCED}/data`, { version: 58, blob: 'still fine' })).body, { version: 59 }, 'spaces in use are not affected');
  db.exec("DELETE FROM seen_spaces WHERE id LIKE 'f0%'");
});

await test('a space has a ceiling on connected apps and on its inbox', async () => {
  const space = newSpace();
  const ip = '192.0.2.30';
  for (const app of ['a', 'b', 'c', 'd']) assert.equal((await call('PUT', `/spaces/${space}/feeds/${app}`, { blob: 'x' }, { ip })).status, 204);
  assert.equal((await call('PUT', `/spaces/${space}/feeds/e`, { blob: 'x' }, { ip })).status, 429);
  assert.equal((await call('PUT', `/spaces/${space}/feeds/a`, { blob: 'updated' }, { ip })).status, 204, 'one it already has can still change');
  for (const app of ['a', 'b', 'c', 'd']) assert.equal((await call('PUT', `/spaces/${space}/turns/${app}`, { device: 'device-0001' }, { ip })).status, 200);
  assert.equal((await call('PUT', `/spaces/${space}/turns/e`, { device: 'device-0001' }, { ip })).status, 429);
  const add = db.prepare('INSERT INTO inbox (space_id, box, item_id, blob, created_at) VALUES (?, ?, ?, ?, ?)');
  for (let i = 0; i < 100; i++) add.run(space, 'a', `item-a-${String(i).padStart(4, '0')}`, 'x', clock);
  assert.equal((await call('POST', `/spaces/${space}/inbox/a`, { id: 'item-a-full', blob: 'x' }, { ip })).status, 429, 'one inbox is full at a hundred');
  for (let i = 0; i < 100; i++) add.run(space, 'b', `item-b-${String(i).padStart(4, '0')}`, 'x', clock);
  assert.equal((await call('POST', `/spaces/${space}/inbox/c`, { id: 'item-c-0001', blob: 'x' }, { ip })).status, 429, 'and the space at two hundred');
});

await test('one caller can start only so many backups a day, and there is room for only so many', async () => {
  const ip = '192.0.2.40';
  const opts = { ip, headers: { 'X-Backup-Key': KEY } };
  for (let i = 0; i < 6; i++) assert.equal((await call('PUT', `/backups/${hex(`e${i}`)}`, { blob: 'x' }, opts)).status, 200);
  assert.equal((await call('PUT', `/backups/${hex('e9')}`, { blob: 'x' }, opts)).status, 429);
  assert.equal((await call('PUT', `/backups/${hex('e0')}`, { blob: 'changed' }, opts)).status, 200, 'their own backups still save');
  const fill = db.prepare("INSERT INTO backups (id, auth_hash, parts, size, updated_at) VALUES (?, 'h', 0, 0, ?)");
  for (let i = count('SELECT COUNT(*) FROM backups'); i < 40; i++) fill.run(`9${i.toString(16).padStart(63, '0')}`, clock);
  assert.equal((await call('PUT', `/backups/${hex('ea')}`, { blob: 'x' }, { ip: '192.0.2.41', headers: { 'X-Backup-Key': KEY } })).status, 507);
  db.exec("DELETE FROM backups WHERE id LIKE '90%'");
});

await test('a flood of new spaces cannot hold up the reminders of one that was here first', async () => {
  db.exec('DELETE FROM reminders');
  const insertSpace = db.prepare('INSERT OR IGNORE INTO seen_spaces (id, created_at) VALUES (?, ?)');
  const insertDevice = db.prepare('INSERT INTO devices (space_id, device_id, subscription, updated_at) VALUES (?, ?, ?, ?)');
  const insertReminder = db.prepare('INSERT INTO reminders (space_id, reminder_id, due_at, sent) VALUES (?, ?, ?, 0)');
  for (let i = 0; i < 60; i++) {
    const junk = `7${i.toString(16).padStart(63, '0')}`;
    insertSpace.run(junk, clock);
    insertDevice.run(junk, 'device-junk', JSON.stringify({ endpoint: `https://fcm.googleapis.com/fcm/send/junk-${i}` }), clock);
    for (let r = 0; r < 20; r++) insertReminder.run(junk, `r${r}`, clock - 120_000); // due earlier than the owner's
  }
  insertReminder.run(OLD_PUSH_ONLY, 'theirs', clock - 1000);
  pushed.length = 0;
  pushStatus = url => (url.includes('junk') ? 500 : 201);
  await runMinute();
  assert.equal(pushed[0], 'https://fcm.googleapis.com/fcm/send/old', 'the space that was here first is pushed first');
  assert.ok(pushed.length <= 41, `no more than a minute's share of pushes (${pushed.length})`);
  assert.equal(count('SELECT sent FROM reminders WHERE space_id = ? AND reminder_id = ?', OLD_PUSH_ONLY, 'theirs'), 1);
  pushStatus = () => 201;
  db.exec("DELETE FROM reminders WHERE space_id LIKE '70%'; DELETE FROM devices WHERE space_id LIKE '70%'; DELETE FROM seen_spaces WHERE id LIKE '70%'; DELETE FROM device_failures");
});

await test('what nobody uses is cleared away; what is in use, and every backup, stays', async () => {
  const left = newSpace();      // stored once, then left
  const synced = newSpace();    // synced twice
  const withDevice = newSpace(); // stored once, but a device listens there
  const ip = '192.0.2.50';
  await call('PUT', `/spaces/${left}/data`, { version: 0, blob: 'x' }, { ip });
  await call('PUT', `/spaces/${left}/reminders`, { reminders: [{ id: 'r', at: clock + 400 * 86_400_000 }] }, { ip });
  await call('PUT', `/spaces/${synced}/data`, { version: 0, blob: 'x' }, { ip });
  await call('PUT', `/spaces/${synced}/data`, { version: 1, blob: 'y' }, { ip });
  await call('PUT', `/spaces/${withDevice}/data`, { version: 0, blob: 'x' }, { ip });
  const backups = count('SELECT COUNT(*) FROM backups');
  clock += 31 * 86_400_000;
  clock -= clock % 600_000; // a "tidy up" minute
  await call('PUT', `/spaces/${withDevice}/devices/device-live-1`, { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/live' } }, { ip });
  await runMinute();
  assert.equal(count('SELECT COUNT(*) FROM spaces WHERE id = ?', left), 0, 'stored once and left a month: gone');
  assert.equal(count('SELECT COUNT(*) FROM seen_spaces WHERE id = ?', left), 0);
  assert.equal(count('SELECT COUNT(*) FROM reminders WHERE space_id = ?', left), 0);
  assert.equal(count('SELECT COUNT(*) FROM spaces WHERE id = ?', synced), 1, 'synced more than once: kept');
  assert.equal(count('SELECT COUNT(*) FROM spaces WHERE id = ?', withDevice), 1, 'a device listens there: kept');
  assert.equal(count('SELECT COUNT(*) FROM spaces WHERE id = ?', OLD_SYNCED), 1, 'their own space: kept');
  assert.equal(count('SELECT COUNT(*) FROM spaces WHERE id = ?', OLD_STORED_ONCE), 1, 'anything from before this version is never cleared, however old');
  assert.equal(count('SELECT COUNT(*) FROM backups'), backups, 'no backup is ever cleared');
  assert.deepEqual((await call('PUT', `/spaces/${left}/data`, { version: 0, blob: 'back again' }, { ip })).body, { version: 1 }, 'a device that comes back simply stores it again');
});

await test('one address can only ask so often in a minute', async () => {
  const ip = '192.0.2.99';
  let last = 200;
  for (let i = 0; i < 601; i++) last = (await call('GET', '/vapid-public-key', undefined, { ip })).status;
  assert.equal(last, 429);
  assert.equal((await call('GET', '/vapid-public-key', undefined, { ip: '192.0.2.98' })).status, 200);
  clock += 60_000;
  assert.equal((await call('GET', '/vapid-public-key', undefined, { ip })).status, 200, 'the next minute it may again');
});

await test('other sites cannot call it from a browser', async () => {
  const request = origin => new Request('https://cloud.example/vapid-public-key', { headers: { Origin: origin, 'CF-Connecting-IP': '192.0.2.120' } });
  assert.equal((await worker.fetch(request('https://app.example'), env)).headers.get('Access-Control-Allow-Origin'), 'https://app.example');
  assert.equal((await worker.fetch(request('https://evil.example'), env)).headers.get('Access-Control-Allow-Origin'), null);
});

Date.now = realNow;
if (failed) { console.log(`${failed} failed`); process.exit(1); }
process.exit(0);
