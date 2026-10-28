// LightMoon cloud: keeps encrypted sync data, knows when reminders are due, and wakes devices with
// push notifications at that moment. It never sees what anyone wrote: sync data arrives already
// encrypted with the user's sync code, and reminders are only an id and a time.
// Connected apps (Life Levelling) use the same space: a "feed" is their encrypted summary for LightMoon,
// and an "inbox" holds LightMoon's encrypted requests for them. Both are encrypted with the sync code too.

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS spaces (
     id         TEXT PRIMARY KEY,
     version    INTEGER NOT NULL,
     blob       TEXT NOT NULL,
     updated_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS devices (
     space_id     TEXT NOT NULL,
     device_id    TEXT NOT NULL,
     subscription TEXT NOT NULL,
     updated_at   INTEGER NOT NULL,
     PRIMARY KEY (space_id, device_id))`,
  `CREATE TABLE IF NOT EXISTS reminders (
     space_id    TEXT NOT NULL,
     reminder_id TEXT NOT NULL,
     due_at      INTEGER NOT NULL,
     sent        INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (space_id, reminder_id))`,
  'CREATE INDEX IF NOT EXISTS reminders_due ON reminders (sent, due_at)',
  `CREATE TABLE IF NOT EXISTS feeds (
     space_id   TEXT NOT NULL,
     name       TEXT NOT NULL,
     blob       TEXT NOT NULL,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (space_id, name))`,
  `CREATE TABLE IF NOT EXISTS inbox (
     space_id   TEXT NOT NULL,
     box        TEXT NOT NULL,
     item_id    TEXT NOT NULL,
     blob       TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     PRIMARY KEY (space_id, box, item_id))`,
];

const SPACE_ID = /^[0-9a-f]{64}$/; // a SHA-256 of the sync code, or a random id for a device on its own
const DEVICE_ID = /^[A-Za-z0-9_-]{8,64}$/;
const REMINDER_ID = /^[A-Za-z0-9_-]{1,64}$/;
const APP_NAME = /^[a-z0-9-]{1,32}$/; // a connected app, e.g. "lifelevelling"
const ITEM_ID = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_BODY_BYTES = 2_000_000;
const MAX_BLOB_CHARS = 1_500_000;
const MAX_FEED_CHARS = 300_000;
const MAX_REQUEST_CHARS = 20_000;
const MAX_INBOX_ITEMS = 100;
const MAX_REMINDERS = 500;
const KEEP_SENT_REMINDERS_MS = 7 * 86_400_000;
const KEEP_INBOX_MS = 7 * 86_400_000;
const RETRY_PUSH_FOR_MS = 60 * 60_000;
const FORGET_DEVICES_AFTER_MS = 120 * 86_400_000;
// Only real browser push services, so this service can't be used to send requests anywhere else.
const PUSH_HOSTS = /^(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|web\.push\.apple\.com|[\w-]+\.notify\.windows\.com|[\w.-]+\.push\.apple\.com)$/;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Tables are created on first use, so deploying needs no separate database setup step.
let schemaReady = null;
const ensureSchema = env => (schemaReady ??= env.DB.batch(SCHEMA.map(sql => env.DB.prepare(sql))).catch(err => {
  schemaReady = null;
  throw err;
}));

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    let response;
    try {
      await ensureSchema(env);
      response = await route(request, env);
    } catch (err) {
      if (!err.status) console.error(err);
      response = json({ error: err.status ? err.message : 'Server error' }, err.status ?? 500);
    }
    for (const [name, value] of Object.entries(cors)) response.headers.set(name, value);
    return response;
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(ensureSchema(env).then(() => sendDueReminders(env)));
  },
};

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map(o => o.trim());
  if (!origin || !allowed.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const noContent = () => new Response(null, { status: 204 });

async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, 'Too large');
  try {
    return JSON.parse(text || '{}');
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

async function route(request, env) {
  const { pathname } = new URL(request.url);
  const method = request.method;
  if (method === 'GET' && pathname === '/vapid-public-key') return json({ key: env.VAPID_PUBLIC_KEY });

  const [section, space, part, name, item, ...rest] = pathname.split('/').filter(Boolean);
  if (section !== 'spaces' || !SPACE_ID.test(space ?? '') || rest.length) throw new HttpError(404, 'Not found');

  if (part === 'data' && !name) {
    if (method === 'GET') return getData(env, space);
    if (method === 'PUT') return putData(env, space, await readJson(request));
  }
  if (part === 'reminders' && !name && method === 'PUT') return putReminders(env, space, await readJson(request));
  if (part === 'devices' && DEVICE_ID.test(name ?? '') && !item) {
    if (method === 'PUT') return putDevice(env, space, name, await readJson(request));
    if (method === 'DELETE') return deleteDevice(env, space, name);
  }
  if (part === 'feeds' && APP_NAME.test(name ?? '') && !item) {
    if (method === 'GET') return getFeed(env, space, name);
    if (method === 'PUT') return putFeed(env, space, name, await readJson(request));
  }
  if (part === 'inbox' && APP_NAME.test(name ?? '')) {
    if (!item && method === 'GET') return listInbox(env, space, name);
    if (!item && method === 'POST') return addToInbox(env, space, name, await readJson(request));
    if (ITEM_ID.test(item ?? '') && method === 'DELETE') return removeFromInbox(env, space, name, item);
  }
  throw new HttpError(404, 'Not found');
}

// ---------- Connected apps: their encrypted summary (feed) and LightMoon's requests to them (inbox) ----------

async function getFeed(env, space, name) {
  const row = await env.DB.prepare('SELECT blob, updated_at FROM feeds WHERE space_id = ? AND name = ?').bind(space, name).first();
  return row ? json({ blob: row.blob, updatedAt: row.updated_at }) : json({ error: 'Not found' }, 404);
}

async function putFeed(env, space, name, { blob }) {
  if (typeof blob !== 'string' || !blob || blob.length > MAX_FEED_CHARS) throw new HttpError(400, 'Bad feed');
  await env.DB.prepare(
    `INSERT INTO feeds (space_id, name, blob, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(space_id, name) DO UPDATE SET blob = excluded.blob, updated_at = excluded.updated_at`,
  ).bind(space, name, blob, Date.now()).run();
  return noContent();
}

async function listInbox(env, space, box) {
  const { results } = await env.DB.prepare(
    'SELECT item_id, blob, created_at FROM inbox WHERE space_id = ? AND box = ? ORDER BY created_at LIMIT ?',
  ).bind(space, box, MAX_INBOX_ITEMS).all();
  return json({ items: results.map(r => ({ id: r.item_id, blob: r.blob, createdAt: r.created_at })) });
}

async function addToInbox(env, space, box, { id, blob }) {
  if (!ITEM_ID.test(String(id)) || typeof blob !== 'string' || !blob || blob.length > MAX_REQUEST_CHARS) {
    throw new HttpError(400, 'Bad request item');
  }
  const { count } = await env.DB.prepare('SELECT COUNT(*) AS count FROM inbox WHERE space_id = ? AND box = ?').bind(space, box).first();
  if (count >= MAX_INBOX_ITEMS) throw new HttpError(429, 'Inbox full');
  await env.DB.prepare('INSERT INTO inbox (space_id, box, item_id, blob, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING')
    .bind(space, box, String(id), blob, Date.now()).run();
  return noContent();
}

async function removeFromInbox(env, space, box, item) {
  await env.DB.prepare('DELETE FROM inbox WHERE space_id = ? AND box = ? AND item_id = ?').bind(space, box, item).run();
  return noContent();
}

// ---------- Encrypted sync data: one blob per space, with a version to catch conflicting writes ----------

async function getData(env, space) {
  const row = await env.DB.prepare('SELECT version, blob FROM spaces WHERE id = ?').bind(space).first();
  return row ? json({ version: row.version, blob: row.blob }) : json({ error: 'Not found' }, 404);
}

async function putData(env, space, { version, blob }) {
  if (!Number.isInteger(version) || version < 0 || typeof blob !== 'string' || !blob || blob.length > MAX_BLOB_CHARS) {
    throw new HttpError(400, 'Bad data');
  }
  const now = Date.now();
  const result = version === 0
    ? await env.DB.prepare('INSERT INTO spaces (id, version, blob, updated_at) VALUES (?, 1, ?, ?) ON CONFLICT(id) DO NOTHING')
      .bind(space, blob, now).run()
    : await env.DB.prepare('UPDATE spaces SET version = version + 1, blob = ?, updated_at = ? WHERE id = ? AND version = ?')
      .bind(blob, now, space, version).run();
  if (result.meta.changes === 1) return json({ version: version + 1 });
  // Someone else wrote first: send back the current copy so the device can merge and try again.
  const current = await env.DB.prepare('SELECT version, blob FROM spaces WHERE id = ?').bind(space).first();
  return json({ version: current?.version ?? 0, blob: current?.blob ?? null }, 409);
}

// ---------- Devices that want reminder notifications ----------

async function putDevice(env, space, device, { subscription }) {
  let host;
  try {
    host = new URL(subscription?.endpoint).hostname;
  } catch {
    throw new HttpError(400, 'Bad subscription');
  }
  const localTesting = env.ALLOW_ANY_PUSH_HOST === '1'; // set only in .dev.vars, never in production
  if (!localTesting && (!subscription.endpoint.startsWith('https://') || !PUSH_HOSTS.test(host))) {
    throw new HttpError(400, 'Unsupported push service');
  }
  // Pushes carry no content, so only the endpoint is kept.
  await env.DB.prepare(
    `INSERT INTO devices (space_id, device_id, subscription, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(space_id, device_id) DO UPDATE SET subscription = excluded.subscription, updated_at = excluded.updated_at`,
  ).bind(space, device, JSON.stringify({ endpoint: subscription.endpoint }), Date.now()).run();
  return noContent();
}

async function deleteDevice(env, space, device) {
  await env.DB.prepare('DELETE FROM devices WHERE space_id = ? AND device_id = ?').bind(space, device).run();
  return noContent();
}

// ---------- Reminder times (no titles) ----------

async function putReminders(env, space, { reminders }) {
  if (!Array.isArray(reminders) || reminders.length > MAX_REMINDERS) throw new HttpError(400, 'Bad reminders');
  for (const r of reminders) {
    if (!REMINDER_ID.test(String(r?.id)) || !Number.isFinite(r?.at)) throw new HttpError(400, 'Bad reminder');
  }
  // Replace the space's pending schedule; a reminder already sent stays sent unless its time changed.
  const upsert = env.DB.prepare(
    `INSERT INTO reminders (space_id, reminder_id, due_at, sent) VALUES (?, ?, ?, 0)
     ON CONFLICT(space_id, reminder_id) DO UPDATE SET
       sent = CASE WHEN reminders.due_at = excluded.due_at THEN reminders.sent ELSE 0 END,
       due_at = excluded.due_at`,
  );
  await env.DB.batch([
    env.DB.prepare('DELETE FROM reminders WHERE space_id = ? AND sent = 0').bind(space),
    ...reminders.map(r => upsert.bind(space, String(r.id), Math.round(r.at))),
  ]);
  return noContent();
}

async function sendDueReminders(env) {
  const now = Date.now();
  const { results: due } = await env.DB.prepare('SELECT space_id, reminder_id, due_at FROM reminders WHERE sent = 0 AND due_at <= ? LIMIT 500')
    .bind(now).all();
  const finished = new Set(); // spaces whose devices were reached (or that have no devices to reach)
  for (const space of new Set(due.map(r => r.space_id))) {
    const { results: devices } = await env.DB.prepare('SELECT device_id, subscription FROM devices WHERE space_id = ?').bind(space).all();
    let delivered = devices.length === 0;
    for (const device of devices) {
      const status = await sendPush(env, JSON.parse(device.subscription)).catch(err => {
        console.error('push failed', err);
        return 0;
      });
      if (status >= 200 && status < 300) delivered = true;
      if (status === 404 || status === 410) {
        // The browser has dropped this subscription.
        await env.DB.prepare('DELETE FROM devices WHERE space_id = ? AND device_id = ?').bind(space, device.device_id).run();
      }
    }
    if (delivered) finished.add(space);
  }
  // Undelivered reminders are tried again next minute, for up to an hour.
  const done = due.filter(r => finished.has(r.space_id) || r.due_at < now - RETRY_PUSH_FOR_MS);
  const markSent = env.DB.prepare('UPDATE reminders SET sent = 1 WHERE space_id = ? AND reminder_id = ?');
  await env.DB.batch([
    ...done.map(r => markSent.bind(r.space_id, r.reminder_id)),
    env.DB.prepare('DELETE FROM reminders WHERE sent = 1 AND due_at < ?').bind(now - KEEP_SENT_REMINDERS_MS),
    env.DB.prepare('DELETE FROM devices WHERE updated_at < ?').bind(now - FORGET_DEVICES_AFTER_MS),
    env.DB.prepare('DELETE FROM inbox WHERE created_at < ?').bind(now - KEEP_INBOX_MS),
    env.DB.prepare('DELETE FROM feeds WHERE updated_at < ?').bind(now - FORGET_DEVICES_AFTER_MS),
  ]);
}

// ---------- Web Push (RFC 8030) with VAPID (RFC 8292), sent without a payload ----------

let signingKey = null;
const toBase64Url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const encodeJson = value => toBase64Url(new TextEncoder().encode(JSON.stringify(value)));

async function vapidToken(env, audience) {
  signingKey ??= await crypto.subtle.importKey(
    'jwk', JSON.parse(env.VAPID_PRIVATE_JWK), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'],
  );
  const claims = { aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT };
  const unsigned = `${encodeJson({ typ: 'JWT', alg: 'ES256' })}.${encodeJson(claims)}`;
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signingKey, new TextEncoder().encode(unsigned));
  return `${unsigned}.${toBase64Url(signature)}`;
}

async function sendPush(env, { endpoint }) {
  const token = await vapidToken(env, new URL(endpoint).origin);
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { TTL: '3600', Urgency: 'high', Authorization: `vapid t=${token}, k=${env.VAPID_PUBLIC_KEY}` },
    body: '',
  });
  return res.status;
}
