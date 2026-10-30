// Telling look-alikes apart: two contacts called Asha, one Asha with a mobile and a work number, "Family" on WhatsApp
// and on Teams, three emails from the same sender. Nothing here acts: it works out who or what is most likely meant
// from what the user did lately, and when that isn't certain, words the question LightMoon asks. phone.js uses it.
// No phone needed, so tests/people.test.mjs checks it directly.

const DAY = 86_400_000;

// The same number written two ways ("+91 98480 12345", "098480 12345") is one number.
export const sameNumber = (a, b) => {
  const tail = n => String(n ?? '').replace(/\D/g, '').slice(-10);
  return tail(a).length >= 6 && tail(a) === tail(b);
};

const lower = text => String(text ?? '').trim().toLowerCase();
const lastDigits = number => String(number ?? '').replace(/\D/g, '').slice(-4);

function ago(ms, now) {
  const days = Math.floor((now - ms) / DAY);
  if (days < 1) return 'today';
  if (days < 2) return 'yesterday';
  return days < 14 ? `${days} days ago` : 'a while ago';
}

// What the user did with a number lately: { calls, last, missedFromThem }.
function historyWith(number, calls) {
  const theirs = calls.filter(c => sameNumber(c.number, number));
  return {
    calls: theirs.filter(c => c.type !== 'missed').length,
    missed: theirs.filter(c => c.type === 'missed').length,
    last: Math.max(0, ...theirs.map(c => c.at ?? 0)),
  };
}

// Who a name means, from the contacts that matched it. Returns { person } when there is only one, or
// { ask, options } with the likeliest first. `calls` are recent calls ({ number, type, at }), `messages` the recent
// ones ({ from, at }), so "call Asha" right after Asha Rao rang or wrote points at her. It never picks between two
// different numbers on its own: a guess is offered as a question.
export function choosePerson(said, contacts, { calls = [], messages = [], now = Date.now() } = {}) {
  const wanted = lower(said);
  const exact = contacts.filter(c => lower(c.name) === wanted);
  const options = [];
  for (const contact of exact.length ? exact : contacts) {
    for (const n of contact.numbers ?? []) {
      // One number saved twice (a synced copy, a second format) is one option.
      const twin = options.find(o => sameNumber(o.number, n.number));
      if (twin) continue;
      options.push({ name: contact.name, number: n.number, label: n.label || 'phone' });
    }
  }
  if (!options.length) return { none: true };
  if (options.length === 1) return { person: options[0] };

  for (const o of options) {
    const h = historyWith(o.number, calls);
    const wrote = messages.filter(m => lower(m.from) === lower(o.name)).map(m => m.at ?? 0);
    o.lastWrote = Math.max(0, ...wrote);
    o.history = h;
    // Recent beats frequent, and a call or message today beats anything older.
    const recent = Math.max(h.last, o.lastWrote);
    o.score = h.calls * 2 + h.missed * 3 + wrote.length * 3 + (recent ? Math.max(0, 14 - (now - recent) / DAY) : 0)
      + (/mobile|cell/i.test(o.label) ? 0.5 : 0);
  }
  options.sort((a, b) => b.score - a.score);

  const sameName = options.every(o => lower(o.name) === lower(options[0].name));
  const describe = o => {
    const parts = [sameName ? `${o.name}'s ${o.label.toLowerCase()} ending ${lastDigits(o.number)}` : `${o.name} (${o.label.toLowerCase()} ending ${lastDigits(o.number)})`];
    if (o.lastWrote && o.lastWrote >= o.history.last) parts.push(`who messaged them ${ago(o.lastWrote, now)}`);
    else if (o.history.missed && o.history.last) parts.push(`who tried to call them ${ago(o.history.last, now)}`);
    else if (o.history.calls) parts.push(`they last spoke ${ago(o.history.last, now)}`);
    return parts.join(', ');
  };
  const shown = options.slice(0, 4);
  const clear = shown[0].score >= 3 && shown[0].score >= 2 * (shown[1].score || 0.1);
  const lines = shown.map((o, i) => `${i + 1}. ${describe(o)}: number ${o.number}`);
  const hint = clear
    ? `Most likely the first, from their recent calls and messages, but don't assume: ask, naming your guess first (for example "${shortName(shown[0], sameName)}, the one ${tie(shown[0], now)}?").`
    : "Nothing in their recent calls or messages says which, so ask, telling them apart in a few words (surname, mobile or work, or who it was last time).";
  return {
    options: shown,
    ask: `"${said}" could be ${options.length > shown.length ? `${options.length} numbers, these are the likeliest` : `${shown.length} numbers`}:\n${lines.join('\n')}\n${hint} `
      + 'Then call the tool again with the number they choose. Once they have chosen, offer once to remember it with set_nickname '
      + `so "${said}" means that one next time.`,
  };
}

const shortName = (o, sameName) => (sameName ? `${o.name}'s ${o.label.toLowerCase()}` : o.name);
function tie(o, now) {
  if (o.lastWrote && o.lastWrote >= o.history.last) return `who messaged you ${ago(o.lastWrote, now)}`;
  if (o.history.last) return `you spoke to ${ago(o.history.last, now)}`;
  return `on ${o.label.toLowerCase()}`;
}

// For the list of recent messages the AI sees: a note on each one whose sender's name also turns up in a different
// chat, app or email account ("Asha" on WhatsApp and "Asha" on Teams), and on emails when one sender sent several.
// messages: [{ ref, from, app, chat, conversation, kind }]. Returns { M3: 'note', ... }.
export function lookAlikeNotes(messages) {
  const notes = {};
  for (const m of messages) {
    const sameName = messages.filter(o => o !== m && lower(o.from) === lower(m.from));
    if (!sameName.length) continue;
    const elsewhere = sameName.filter(o => o.conversation !== m.conversation);
    const parts = [];
    if (elsewhere.length) {
      const where = [...new Set(elsewhere.map(o => o.ref))].join(', ');
      parts.push(`SAME NAME, DIFFERENT CHAT: also ${where}`);
    }
    if (m.kind === 'email') {
      const more = sameName.filter(o => o.kind === 'email' && o.conversation === m.conversation).map(o => o.ref);
      if (more.length) parts.push(`one of ${more.length + 1} emails from this sender: also ${more.join(', ')}`);
    }
    if (parts.length) notes[m.ref] = parts.join('; ');
  }
  return notes;
}

// The messages a reply to `name` could be meant for, one per conversation (its newest), newest first: when there
// are two or more, LightMoon asks which chat before replying.
export function conversationsFrom(name, messages) {
  const wanted = lower(name);
  const byConversation = new Map();
  for (const m of messages) {
    if (lower(m.from) !== wanted && lower(m.chat) !== wanted) continue;
    const seen = byConversation.get(m.conversation);
    if (!seen || (m.at ?? 0) >= (seen.at ?? 0)) byConversation.set(m.conversation, m);
  }
  return [...byConversation.values()].sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
}
