// Sending straight from LightMoon through the user's Microsoft work account (Microsoft Graph): Teams messages
// to a chat, group chat or channel found by name, with real @mentions, and work email. The sign-in and its key
// live on the phone (android/.../WorkAccountPlugin.java); this asks it for a short-lived token per request.
// Nothing is sent without the user's yes: tools.js reads each message back first (phone.js askFirst).
// The matching and message-building helpers are plain functions, checked by tests/graph.test.mjs.

const GRAPH = 'https://graph.microsoft.com/v1.0';
const CACHE_KEY = 'assistant.graphChats'; // chat and channel names → ids, this device only
const CACHE_FOR_MS = 6 * 60 * 60_000;

const lower = text => String(text ?? '').trim().toLowerCase();
// "Gunukonda, Akash | Saras America" → "gunukonda, akash"; words for loose matching.
const bare = name => lower(String(name ?? '').split('|')[0]);
const words = name => bare(name).split(/[\s,.]+/).filter(Boolean);

// How well a shown name fits what was said: 3 exact, 2 starts with it, 1 every word of it appears, 0 not at all.
export function nameScore(shown, said) {
  const a = bare(shown);
  const b = bare(said);
  if (!a || !b) return 0;
  if (a === b) return 3;
  if (a.startsWith(b)) return 2;
  const have = words(shown);
  return words(said).every(w => have.some(h => h.startsWith(w))) ? 1 : 0;
}

// The best places for a name among [{ kind, label, ... }]: the top score only, so "NOC Team" beats "NOC Team old".
export function bestMatches(places, said) {
  const scored = places.map(place => ({ place, score: nameScore(place.label, said) })).filter(s => s.score > 0);
  const top = Math.max(0, ...scored.map(s => s.score));
  return scored.filter(s => s.score === top).map(s => s.place);
}

export const escapeHtml = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// A message body with real @mentions: "@Akash" in the text becomes Teams' <at> tag for that person, and any
// mentioned person not written in the text goes in front ("@Akash I'm running late"). people: [{ id, name }].
export function buildMessage(text, people = []) {
  let content = escapeHtml(String(text ?? '').trim());
  const mentions = [];
  people.forEach((person, i) => {
    const first = person.name.split(/[\s,]+/).filter(Boolean);
    const shown = person.name.includes(',') ? first[1] ?? first[0] : first[0]; // "Gunukonda, Akash" → "Akash"
    const tag = `<at id="${i}">${escapeHtml(shown)}</at>`;
    const written = new RegExp(`@${shown.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    content = written.test(content) ? content.replace(written, tag) : `${tag} ${content}`;
    mentions.push({ id: i, mentionText: shown, mentioned: { user: { id: person.id, displayName: person.name, userIdentityType: 'aadUser' } } });
  });
  return { body: { contentType: 'html', content: content.replace(/\n/g, '<br>') }, ...(mentions.length && { mentions }) };
}

// ---------- Talking to Microsoft (only in the Android app, signed in) ----------

let account = null; // WorkAccount plugin, set by connect()
export function connect(plugin) {
  account = plugin;
}

export async function signedIn() {
  if (!account) return false;
  return Boolean((await account.status().catch(() => null))?.signedIn);
}

async function graph(path, { method = 'GET', body, headers = {} } = {}) {
  if (!account) throw new Error('Sending through the work account needs the LightMoon phone app.');
  const { accessToken } = await account.token();
  const response = await fetch(path.startsWith('http') ? path : `${GRAPH}${path}`, {
    method,
    headers: { Authorization: `Bearer ${accessToken}`, ...headers, ...(body && { 'Content-Type': 'application/json' }) },
    ...(body && { body: JSON.stringify(body) }),
  });
  if (response.status === 202 || response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const why = data?.error?.message ?? `Microsoft answered ${response.status}`;
    throw new Error(response.status === 403 ? `Microsoft refused (${why}). The work account may need your company's approval for this.` : why);
  }
  return data;
}

async function me() {
  const cached = readCache().me;
  if (cached) return cached;
  const who = await graph('/me?$select=id,displayName,mail,userPrincipalName');
  writeCache({ me: who });
  return who;
}

function readCache() {
  try {
    const saved = JSON.parse(localStorage.getItem(CACHE_KEY) ?? '{}');
    return Date.now() - (saved.at ?? 0) < CACHE_FOR_MS ? saved : {};
  } catch {
    return {};
  }
}
function writeCache(part) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ ...readCache(), ...part, at: Date.now() }));
  } catch {
    // No storage: just ask Microsoft again next time.
  }
}

// Every chat and channel they're in, as [{ kind: 'chat' | 'channel', label, id, teamId?, members? }].
async function places() {
  const cached = readCache().places;
  if (cached) return cached;
  const self = await me();
  const found = [];
  let next = '/me/chats?$expand=members&$top=50';
  for (let page = 0; next && page < 6; page++) {
    const data = await graph(next);
    for (const chat of data.value ?? []) {
      const others = (chat.members ?? []).filter(m => m.userId && m.userId !== self.id);
      const label = chat.topic || others.map(m => m.displayName).join(', ');
      if (label) found.push({ kind: 'chat', label, id: chat.id, members: (chat.members ?? []).map(m => ({ id: m.userId, name: m.displayName })) });
    }
    next = data['@odata.nextLink'];
  }
  const teams = await graph('/me/joinedTeams?$select=id,displayName').catch(() => ({ value: [] }));
  for (const team of (teams.value ?? []).slice(0, 25)) {
    const channels = await graph(`/teams/${team.id}/channels?$select=id,displayName`).catch(() => ({ value: [] }));
    for (const channel of channels.value ?? []) {
      found.push({ kind: 'channel', label: channel.displayName === 'General' ? team.displayName : `${channel.displayName} (${team.displayName})`, id: channel.id, teamId: team.id });
    }
  }
  writeCache({ places: found });
  return found;
}

// A person in the organisation by name, for mentions and new chats: [{ id, name, mail }].
async function people(said) {
  const query = String(said).replace(/["\\]/g, '');
  const data = await graph(`/users?$search="displayName:${encodeURIComponent(query)}"&$select=id,displayName,mail&$top=5`, { headers: { ConsistencyLevel: 'eventual' } });
  return (data.value ?? []).map(u => ({ id: u.id, name: u.displayName, mail: u.mail }));
}

// Where "NOC Team" or "Akash" is: { place } or { ask } when it's unclear or not found.
export async function findPlace(said) {
  const hits = bestMatches(await places(), said);
  if (hits.length === 1) return { place: hits[0] };
  if (hits.length > 1) {
    return { ask: `"${said}" could be ${hits.slice(0, 4).map(h => `${h.label} (${h.kind === 'chat' ? 'chat' : 'channel'})`).join(', ')}. Ask which, then use that exact name.` };
  }
  // Someone they haven't chatted with yet: a new one-to-one chat with them.
  const found = (await people(said)).filter(p => nameScore(p.name, said) > 0);
  if (found.length === 1) return { place: { kind: 'new-chat', label: found[0].name, person: found[0] } };
  if (found.length > 1) return { ask: `"${said}" could be ${found.slice(0, 4).map(p => `${p.name}${p.mail ? ` (${p.mail})` : ''}`).join(', ')}. Ask which.` };
  return { ask: `There's no Teams chat, channel or person called "${said}" in their work account. Ask for the name as it shows in Teams.` };
}

// The people to @mention, found among the chat's members first, then the organisation.
export async function findMentions(names, place) {
  const result = [];
  for (const name of names) {
    const inChat = (place.members ?? []).filter(m => nameScore(m.name, name) > 0);
    const pool = inChat.length ? inChat : await people(name);
    const best = pool.filter(p => nameScore(p.name, name) === Math.max(...pool.map(q => nameScore(q.name, name))));
    if (best.length !== 1) return { ask: `Who is "${name}" to tag? ${best.length ? `It could be ${best.map(p => p.name).join(' or ')}.` : 'No one by that name.'}` };
    result.push({ id: best[0].id, name: best[0].name });
  }
  return { people: result };
}

export async function sendTeams(place, text, mentionPeople = []) {
  const message = buildMessage(text, mentionPeople);
  if (place.kind === 'channel') return graph(`/teams/${place.teamId}/channels/${place.id}/messages`, { method: 'POST', body: message });
  let chatId = place.id;
  if (place.kind === 'new-chat') {
    const self = await me();
    const bind = id => `https://graph.microsoft.com/v1.0/users('${id}')`;
    const chat = await graph('/chats', {
      method: 'POST',
      body: {
        chatType: 'oneOnOne',
        members: [self.id, place.person.id].map(id => ({ '@odata.type': '#microsoft.graph.aadUserConversationMember', roles: ['owner'], 'user@odata.bind': bind(id) })),
      },
    });
    chatId = chat.id;
    writeCache({ places: null });
  }
  return graph(`/chats/${chatId}/messages`, { method: 'POST', body: message });
}

export async function sendMail({ to, subject, body }) {
  return graph('/me/sendMail', {
    method: 'POST',
    body: {
      message: { subject, body: { contentType: 'Text', content: body }, toRecipients: to.map(address => ({ emailAddress: { address } })) },
      saveToSentItems: true,
    },
  });
}
