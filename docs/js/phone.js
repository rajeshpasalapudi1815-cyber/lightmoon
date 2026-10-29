// The phone, in the Android app (android/.../PhonePlugin.java): the calendar, calls, texts and chat
// messages, opening apps, alarms and timers, the flashlight and the volume. This is what the AI is told
// (today's meetings, missed calls, recent messages) and the tools it may use, for whatever the user has
// allowed in Settings → Phone. Meetings are announced by the phone itself; this doesn't need to.
//
// Calling someone or sending a message never happens on the AI's word alone: the first call of the tool
// only reads back who and what, and the action runs when the AI calls again with that confirm_id after
// the user has answered (a newer message from them). The stored action runs, not whatever the AI sends then.
import { phone } from './native.js';
import { messages as chat } from './store.js';

const REFRESH_AFTER_MS = 60_000;
const WAIT_AT_MOST_MS = 2_500;
const HOUR = 3_600_000;
const CONFIRM_FOR_MS = 3 * 60_000;
const MAX_EVENTS = 14;
const MAX_MISSED = 6;
const MAX_MESSAGES = 10;

let allowed = null;
let seen = { events: [], calls: [], messages: [], battery: null, at: 0 };
const pending = new Map(); // confirm_id -> { say, run, at }

export const phoneAvailable = () => Boolean(phone);
export const phoneStatus = () => allowed;

// Fresh phone data for the next reply, at most every minute and never holding it up for long.
export async function refresh({ force = false } = {}) {
  if (!phone || (!force && Date.now() - seen.at < REFRESH_AFTER_MS)) return;
  await Promise.race([load(), new Promise(resolve => setTimeout(resolve, WAIT_AT_MOST_MS))]);
}

async function load() {
  allowed = await phone.status().catch(() => null);
  if (!allowed) return;
  const now = Date.now();
  const startOfToday = new Date().setHours(0, 0, 0, 0);
  const [events, calls, messages, battery] = await Promise.all([
    allowed.calendar ? phone.events({ from: startOfToday, to: now + 36 * HOUR }).then(r => r.events, () => []) : [],
    allowed.calls ? phone.calls({ since: now - 24 * HOUR }).then(r => r.calls, () => []) : [],
    allowed.messages ? phone.messages({ since: now - 12 * HOUR }).then(r => r.messages, () => []) : [],
    phone.battery?.().catch(() => null) ?? null,
  ]);
  seen = { events, calls, messages, battery, at: now };
}

// ---------- What the AI is told ----------

const clock = ms => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
function dayWord(ms) {
  const day = d => new Date(d).setHours(0, 0, 0, 0);
  const diff = Math.round((day(ms) - day(Date.now())) / 86_400_000);
  return diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : diff === -1 ? 'Yesterday'
    : new Date(ms).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}
const eventLine = e => `${dayWord(e.start)} ${e.allDay ? 'all day' : `${clock(e.start)}-${clock(e.end)}`}: ${e.title}${e.location ? ` (${e.location})` : ''}`;
const who = c => c.name || c.number || 'unknown number';

// One-time codes and other security messages never go to the AI service.
// A security word and a code-like number, the same rule as MessageListener.java ("pin code" alone is a
// postal code in India, so it doesn't count).
const SECURITY_WORDS = /\b(otp|one[- ]?time|verification|security code|passcode|login code|auth\w* code|(?<!pin )code|pin(?!\s*code)|sign[- ]?in|log[- ]?in)\b/i;
const CODE_NUMBER = /\d{4,8}|\d{3}[- ]\d{3}/;
const shareable = text => (SECURITY_WORDS.test(text) && CODE_NUMBER.test(text) ? '(a one-time code or security message, hidden)' : String(text).slice(0, 200));

// Recent messages get short references (M1, M2...) the AI uses to reply.
const messageRefs = () => seen.messages.slice(-MAX_MESSAGES).map((m, i) => ({ ...m, ref: `M${i + 1}` }));

export function promptSection() {
  if (!allowed) return '';
  const lines = [];
  if (seen.battery?.percent >= 0) lines.push(`Battery: ${seen.battery.percent}%${seen.battery.charging ? ', charging' : ''}.`);
  if (allowed.calendar) {
    const upcoming = seen.events.filter(e => e.end > Date.now()).slice(0, MAX_EVENTS);
    lines.push(upcoming.length ? 'Meetings and events:' : 'Calendar: nothing for the rest of today and tomorrow.');
    lines.push(...upcoming.map(e => `  ${eventLine(e)}`));
  }
  if (allowed.calls) {
    const missed = seen.calls.filter(c => c.type === 'missed').slice(0, MAX_MISSED);
    lines.push(missed.length ? `Missed calls (last 24 h): ${missed.map(c => `${who(c)} ${dayWord(c.at).toLowerCase()} ${clock(c.at)}`).join('; ')}` : 'No missed calls in the last 24 hours.');
  }
  if (allowed.messages) {
    const refs = messageRefs();
    lines.push(refs.length ? 'Recent messages (oldest first):' : 'No new messages in the last 12 hours.');
    lines.push(...refs.map(m => `  [${m.ref}] ${m.app}, ${m.from}${m.chat && m.chat !== m.from ? ` in "${m.chat}"` : ''}, ${clock(m.at)}: "${shareable(m.text)}"${m.canReply ? '' : ' (no reply from here)'}`));
  }
  const can = [
    allowed.calendar && 'read and add calendar events',
    allowed.calls && 'call people',
    allowed.texts && 'send texts',
    allowed.messages && 'reply to the messages above',
    'open apps, control music, navigate, search the web or YouTube, set alarms and timers, the flashlight, volume and ringer',
  ].filter(Boolean);
  return `PHONE (this phone, now; you can ${can.join(', ')})\n${lines.join('\n')}`;
}

// ---------- Asking first ----------

function lastUserMessageAt() {
  return chat.recent(30).filter(m => m.role === 'user').at(-1)?.at ?? 0;
}

function askFirst(say, run) {
  const id = `c${Math.random().toString(36).slice(2, 6)}`;
  pending.set(id, { say, run, at: Date.now() });
  return {
    text: '',
    result: `Not done yet. Ask the user exactly: "${say}?" Only if their next message clearly says yes, call this tool again with confirm_id "${id}". If they say no or change anything, don't.`,
  };
}

async function runConfirmed(id) {
  const item = pending.get(String(id));
  if (!item || Date.now() - item.at > CONFIRM_FOR_MS) {
    pending.delete(String(id));
    throw new Error('That confirmation expired. Ask the user again.');
  }
  if (lastUserMessageAt() <= item.at) throw new Error('Ask the user first and wait for their answer before using confirm_id.');
  pending.delete(String(id));
  return item.run();
}

// ---------- Finding people ----------

const looksLikeNumber = text => /^\+?[\d\s().-]{5,}$/.test(text);

// { name, number, label } for a name or number, or an error the AI can ask about.
async function findPerson(whom) {
  const wanted = String(whom ?? '').trim();
  if (!wanted) throw new Error('Who? Give a name or a number.');
  if (looksLikeNumber(wanted)) return { name: null, number: wanted.replace(/[\s().-]/g, '') };
  const { contacts } = await phone.contacts({ query: wanted });
  if (!contacts.length) throw new Error(`No contact matches "${wanted}". Ask the user for the name as saved, or the number.`);
  const exact = contacts.filter(c => c.name.toLowerCase() === wanted.toLowerCase());
  const options = (exact.length ? exact : contacts).flatMap(c => c.numbers.map(n => ({ name: c.name, number: n.number, label: n.label })));
  if (options.length > 1) {
    throw new Error(`More than one match: ${options.slice(0, 6).map(o => `${o.name}, ${o.label} ${o.number}`).join('; ')}. Ask the user which, then use that number.`);
  }
  return options[0];
}

const named = p => (p.name ? `${p.name} (${p.number})` : p.number);

// WhatsApp needs the country code; a 10-digit number without one is taken as Indian (+91).
function withCountryCode(number) {
  const digits = number.replace(/[^\d]/g, '');
  if (number.trim().startsWith('+')) return digits;
  if (digits.startsWith('00')) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) return `91${digits.slice(1)}`;
  return digits.length === 10 ? `91${digits}` : digits;
}

// ---------- Tools ----------

function tool(name, description, properties, required = []) {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, ...(required.length && { required }) } } };
}

const CONFIRM = { type: 'string', description: 'Only after they said yes to your read-back: the confirm_id you were given.' };
const STAMP = 'local time, YYYY-MM-DDTHH:MM';
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const WHO = { type: 'string', description: 'A contact name or a number.' };

// Kept short: every request carries all the tools, and the free AI tier counts every word.
export function phoneTools() {
  if (!phone || !allowed) return [];
  const tools = [];
  if (allowed.calendar) {
    tools.push(
      tool('phone_calendar', 'Calendar events beyond today and tomorrow (those are in your context).', {
        date: { type: 'string', description: 'First day, YYYY-MM-DD. Default today.' },
        days: { type: 'integer', minimum: 1, maximum: 14 },
      }),
      tool('phone_add_event', 'Add an event to the calendar.', {
        title: { type: 'string' },
        start: { type: 'string' },
        minutes: { type: 'integer', minimum: 5, maximum: 1440, description: 'Default 60.' },
        location: { type: 'string' },
        notes: { type: 'string' },
      }, ['title', 'start']),
    );
  }
  if (allowed.calls) {
    tools.push(
      tool('phone_call', 'Call someone. The first call reads back who; call again with confirm_id after their yes.', { who: WHO, confirm_id: CONFIRM }, ['who']),
      tool('phone_recent_calls', 'All recent calls (your context lists only missed calls from the last 24 h).', {
        hours: { type: 'integer', minimum: 1, maximum: 168, description: 'How far back. Default 24.' },
        missed_only: { type: 'boolean' },
      }),
    );
  }
  if (allowed.texts || allowed.messages) {
    tools.push(tool(
      'phone_message',
      'Send a message: reply_to answers one from your context in its own chat; to + via sends a new one. The first call reads it back; '
        + 'call again with confirm_id after their yes (not for whatsapp, where they tap send).',
      {
        text: { type: 'string' },
        reply_to: { type: 'string', description: 'e.g. "M3"' },
        to: WHO,
        via: { type: 'string', enum: ['sms', 'whatsapp'] },
        confirm_id: CONFIRM,
      },
      ['text'],
    ));
  }
  if (allowed.messages) {
    tools.push(tool('phone_messages', 'Messages beyond the ones in your context.', {
      hours: { type: 'integer', minimum: 1, maximum: 48, description: 'Default 12.' },
    }));
  }
  tools.push(
    tool('phone_open_app', 'Open an app by name.', { name: { type: 'string' } }, ['name']),
    tool('phone_alarm', 'Set an alarm (time) or a timer (minutes, seconds).', {
      time: { type: 'string', description: 'HH:MM, 24-hour.' },
      days: { type: 'array', items: { type: 'string', enum: DAYS }, description: 'Repeat (alarm only).' },
      minutes: { type: 'integer', minimum: 0, maximum: 1440 },
      seconds: { type: 'integer', minimum: 0, maximum: 3600 },
      label: { type: 'string' },
    }),
    tool('phone_device', 'Flashlight, volume or ringer.', {
      flashlight: { type: 'boolean' },
      volume: { type: 'integer', minimum: 0, maximum: 100, description: 'Percent.' },
      stream: { type: 'string', enum: ['media', 'ring', 'alarm'], description: 'Default media.' },
      ringer: { type: 'string', enum: ['normal', 'vibrate', 'silent'] },
    }),
    tool('phone_media', 'Control the music or video playing.', {
      action: { type: 'string', enum: ['play', 'pause', 'toggle', 'next', 'previous'] },
    }, ['action']),
    tool('phone_navigate', 'Directions in Google Maps.', {
      destination: { type: 'string' },
      mode: { type: 'string', enum: ['drive', 'walk', 'bike', 'transit'] },
    }, ['destination']),
    tool('phone_search', 'Open a search: web, YouTube, or Maps (e.g. "coffee near me").', {
      query: { type: 'string' },
      where: { type: 'string', enum: ['web', 'youtube', 'maps'] },
    }, ['query']),
  );
  return tools;
}

const nativeError = err => new Error(String(err?.message ?? err));
const call = async promise => {
  try {
    return await promise;
  } catch (err) {
    throw nativeError(err);
  }
};

function toMs(stamp, field) {
  const ms = Date.parse(String(stamp ?? ''));
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(String(stamp ?? '')) || Number.isNaN(ms)) throw new Error(`${field} must be ${STAMP}.`);
  return ms;
}

export const phoneHandlers = {
  async phone_calendar({ date, days = 1 }) {
    const from = date ? new Date(`${date}T00:00`).getTime() : new Date().setHours(0, 0, 0, 0);
    if (Number.isNaN(from)) throw new Error('date must be YYYY-MM-DD.');
    const span = Math.min(Math.max(Number(days) || 1, 1), 14);
    const { events } = await call(phone.events({ from, to: from + span * 24 * HOUR }));
    const lines = events.map(eventLine);
    return { text: `Checked the calendar`, result: lines.length ? lines.join('\n') : 'Nothing in the calendar then.' };
  },

  async phone_add_event({ title, start, minutes = 60, location, notes }) {
    const name = String(title ?? '').trim();
    if (!name) throw new Error('title is required.');
    const from = toMs(start, 'start');
    const to = from + Math.min(Math.max(Number(minutes) || 60, 5), 1440) * 60_000;
    await call(phone.addEvent({ title: name.slice(0, 200), start: from, end: to, location: location || null, notes: notes || null }));
    seen.at = 0; // show it from the next reply
    return `In the calendar: ${name}, ${dayWord(from).toLowerCase()} ${clock(from)}`;
  },

  async phone_call({ who: whom, confirm_id }) {
    if (confirm_id) return runConfirmed(confirm_id);
    const person = await findPerson(whom);
    return askFirst(`Call ${named(person)}`, async () => {
      await call(phone.placeCall({ number: person.number }));
      return `Calling ${person.name ?? person.number}`;
    });
  },

  async phone_recent_calls({ hours = 24, missed_only = false }) {
    const since = Date.now() - Math.min(Math.max(Number(hours) || 24, 1), 168) * HOUR;
    const { calls } = await call(phone.calls({ since }));
    const list = calls.filter(c => !missed_only || c.type === 'missed');
    return {
      text: 'Checked recent calls',
      result: list.length ? list.map(c => `${c.type} ${who(c)}, ${dayWord(c.at).toLowerCase()} ${clock(c.at)}${c.seconds ? `, ${Math.round(c.seconds / 60)} min` : ''}`).join('\n') : 'No calls then.',
    };
  },

  async phone_message({ text, reply_to, to, via = 'sms', confirm_id }) {
    if (confirm_id) return runConfirmed(confirm_id);
    const words = String(text ?? '').trim();
    if (!words) throw new Error('text is required.');
    if (reply_to) {
      const message = messageRefs().find(m => m.ref === String(reply_to).trim().replace(/^\[|\]$/g, '').toUpperCase());
      if (!message) throw new Error(`There is no message ${reply_to}. Use a reference like M2 from your context.`);
      if (!message.canReply) throw new Error(`That ${message.app} message can't be answered from here (its notification is gone or has no reply box). Offer to send a new message instead.`);
      return askFirst(`Reply to ${message.from} on ${message.app}: "${words}"`, async () => {
        await call(phone.reply({ conversation: message.conversation, text: words }));
        return `Replied to ${message.from}`;
      });
    }
    const person = await findPerson(to);
    if (via === 'whatsapp') {
      await call(phone.whatsapp({ number: withCountryCode(person.number), text: words }));
      return { text: `WhatsApp ready for ${person.name ?? person.number}`, result: 'WhatsApp is open with the message written in; the user taps send.' };
    }
    if (!allowed?.texts) throw new Error('Texting is off. Ask the user to allow it in Settings → Phone, or use via "whatsapp".');
    return askFirst(`Text ${named(person)}: "${words}"`, async () => {
      await call(phone.sendText({ number: person.number, text: words }));
      return `Texted ${person.name ?? person.number}`;
    });
  },

  async phone_messages({ hours = 12 }) {
    const since = Date.now() - Math.min(Math.max(Number(hours) || 12, 1), 48) * HOUR;
    const { messages } = await call(phone.messages({ since }));
    return {
      text: 'Checked messages',
      result: messages.length ? messages.map(m => `${m.app}, ${m.from}, ${dayWord(m.at).toLowerCase()} ${clock(m.at)}: "${shareable(m.text)}"`).join('\n') : 'No messages then.',
    };
  },

  async phone_open_app({ name }) {
    const { label } = await call(phone.openApp({ name: String(name ?? '') }));
    return `Opened ${label}`;
  },

  async phone_alarm({ time, days, minutes, seconds, label }) {
    const timer = Math.round((Number(minutes) || 0) * 60 + (Number(seconds) || 0));
    if (timer > 0) {
      await call(phone.setTimer({ seconds: timer, label: label || null }));
      return `Timer: ${timer >= 60 ? `${Math.floor(timer / 60)} min` : ''}${timer % 60 ? ` ${timer % 60} s` : ''}`.trim();
    }
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(time ?? '').trim());
    if (!match) throw new Error('Give time as HH:MM for an alarm, or minutes for a timer.');
    const repeat = (Array.isArray(days) ? days : []).map(d => DAYS.indexOf(String(d).slice(0, 3).toLowerCase()) + 1).filter(d => d > 0);
    await call(phone.setAlarm({ hour: Number(match[1]), minute: Number(match[2]), label: label || null, days: repeat }));
    return `Alarm set: ${match[1].padStart(2, '0')}:${match[2]}${repeat.length ? ', repeating' : ''}`;
  },

  async phone_device({ flashlight, volume, stream = 'media', ringer }) {
    const done = [];
    let note = '';
    if (typeof flashlight === 'boolean') {
      await call(phone.flashlight({ on: flashlight }));
      done.push(`Flashlight ${flashlight ? 'on' : 'off'}`);
    }
    if (volume != null) {
      await call(phone.volume({ stream, percent: Math.min(Math.max(Math.round(Number(volume)), 0), 100) }));
      done.push(`${stream} volume ${volume}%`);
    }
    if (ringer) {
      const set = await call(phone.ringer({ mode: ringer }));
      done.push(`Ringer: ${set.mode}`);
      if (set.silentNeedsAccess) {
        note = ' Full silence needs Do Not Disturb access, so the phone is on vibrate. Tell the user they can allow it in Settings → Phone.';
      }
    }
    if (!done.length) throw new Error('Say flashlight (true/false), volume (0-100) or ringer.');
    return note ? { text: done.join(', '), result: `${done.join(', ')}.${note}` } : done.join(', ');
  },

  async phone_media({ action }) {
    await call(phone.media({ action }));
    return { play: 'Playing', pause: 'Paused', next: 'Next track', previous: 'Previous track' }[action] ?? 'Play/pause';
  },

  async phone_navigate({ destination, mode = 'drive' }) {
    const place = String(destination ?? '').trim();
    if (!place) throw new Error('destination is required.');
    await call(phone.navigate({ destination: place, mode }));
    return `Directions to ${place}`;
  },

  async phone_search({ query, where = 'web' }) {
    const what = String(query ?? '').trim();
    if (!what) throw new Error('query is required.');
    await call(phone.search({ query: what, where }));
    return `Searching ${where === 'web' ? 'the web' : where === 'youtube' ? 'YouTube' : 'Maps'}: ${what}`;
  },
};
