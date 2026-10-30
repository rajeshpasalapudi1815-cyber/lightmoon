// Messages written for the user in other apps, ready for them to check and send: Teams first (a chat with one
// person or several opens with the message typed in), and any other app (Slack, Telegram, Signal, Google Chat,
// Instagram...) through its "share to" screen. Nothing is sent from here: the user taps Send in the app.
// LightMoon can't move around inside another app (open a channel, @mention someone), so a Teams channel opens
// from its link with the message on the clipboard to paste. tools.js runs the plan; tests/compose.test.mjs checks it.

const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

// The last draft LightMoon opened in an app the Send helper works in (Android packages), so "send it" can tap Send
// on that one, and only that one, for ten minutes.
export const SEND_APPS = {
  teams: ['com.microsoft.teams'],
  whatsapp: ['com.whatsapp', 'com.whatsapp.w4b'],
  email: ['com.google.android.gm', 'com.microsoft.office.outlook'],
};
const DRAFT_FOR_MS = 10 * 60_000;
// A message that is only a yes ("yes", "ok send it", "haan ji", "sare"), nothing more: it answers LightMoon's
// read-back on the phone itself (tools.js quickReply). "Yes, but make it Friday" is not one.
export const YES_ONLY = /^\W*(?:(?:yes|yeah|yep|yup|ya|ok(?:ay)?|sure|haan|ha|ji|sare|sari|avunu|theek hai|go ahead|do it|confirm(?:ed)?|correct|please)[\s,.!]*)+(?:(?:send|pampu|pampinchu)(?:\s+(?:it|now|please|cheyyi|chey))*)?\W*$/i;
// A plain "send it" (also in Telugu: "pampu", "send cheyyi"), answered without the AI (tools.js quickReply).
export const SEND_NOW = /^\W*(?:(?:ok(?:ay)?|yes|ya|haan|ha|sare|please|ji)[\s,.!]+)*(?:send|pampu|pampinchu)(?:\s+(?:it|that|this|now|please|cheyyi|chey|cheyandi|the (?:message|msg|mail|email|draft)))*\W*$/i;
let lastDraft = null;
let draftListener = null;
// Told about each new draft (tools.js: the phone then listens for "send it" for a while).
export const onDraft = listener => { draftListener = listener; };
// chat: the chat it was typed into (when known), which must be the one on screen when Send is tapped.
export function rememberDraft(kind, text, chat = '') {
  lastDraft = SEND_APPS[kind] && String(text ?? '').trim() ? { kind, apps: SEND_APPS[kind], text: String(text).trim(), chat, at: Date.now() } : null;
  if (lastDraft) draftListener?.(lastDraft);
}
export const recentDraft = (now = Date.now()) => (lastDraft && now - lastDraft.at < DRAFT_FOR_MS ? lastDraft : null);
const TEAMS_LINK = /^https:\/\/teams\.microsoft\.com\/l\//i;

// "Akash, Priya and Ravi" -> ['Akash', 'Priya', 'Ravi'].
export const splitPeople = to => String(to ?? '').split(/\s*(?:,|;|\band\b|&)\s*/i).map(s => s.trim()).filter(Boolean);

// A plan for compose_message: { kind: 'link', url, app, copy?, note } | { kind: 'share', app, text, note } | { ask }.
// lookUp turns a nickname into what it stands for (an email address, or a Teams chat or channel link).
// byName: the Send helper can open a Teams chat by its name (Android 1.15 and later, helper switched on).
export function planCompose({ app, to = '', text, group = '', lookUp = () => null, byName = false }) {
  const words = String(text ?? '').trim();
  const where = String(app ?? '').trim();
  if (!words) return { ask: 'What should the message say?' };
  if (!where) return { ask: 'Which app should it go in?' };
  if (/^teams$|microsoft teams/i.test(where)) return planTeams({ to, text: words, group, lookUp, byName });
  return {
    kind: 'share', app: where, text: words,
    note: `${where} is open on its "share to" screen with the message in it (it's on the clipboard too): they pick ${to ? `the chat with ${to}` : 'the chat'} and tap Send. You can't pick the chat or send it for them.`,
  };
}

function planTeams({ to, text, group, lookUp, byName }) {
  const people = splitPeople(to);
  if (!people.length && !group) return { ask: 'Who is the Teams message for? Give a name, or the group or channel.' };
  // A saved link for a group chat or channel ("NOC Team" = its Teams link) opens that chat itself.
  const linkFor = name => {
    const saved = lookUp(name);
    return saved && TEAMS_LINK.test(saved) ? saved : TEAMS_LINK.test(name) ? name : null;
  };
  const target = group ? linkFor(group) : people.length === 1 ? linkFor(people[0]) : null;
  const tags = [...text.matchAll(/@([A-Za-z][\w.-]*)/g)].map(m => m[1]);
  const tagNote = tags.length
    ? ` Teams links can't make real @mentions: tell them to type @ and pick ${tags.join(' and ')} in Teams (the plain "@${tags[0]}" in the text won't notify anyone).`
    : '';
  if (target) {
    return {
      kind: 'link', app: 'Teams', url: target, copy: text,
      note: `Teams is opening ${group || people[0]}. Teams can't take a message ready-made for a group chat or channel link, so the message is on the clipboard: tell them to long-press the message box, tap Paste, check it and tap Send.${tagNote}`,
    };
  }
  // No link or email, but the Send helper can find the chat by name in Teams itself.
  const byNameChat = group || (people.length === 1 && !EMAIL.test(people[0]) && !(lookUp(people[0]) && EMAIL.test(lookUp(people[0]))) ? people[0] : '');
  if (byName && byNameChat) {
    return {
      kind: 'chat', app: 'Teams', chat: byNameChat, text,
      note: `Teams is opening "${byNameChat}" through its search and typing the message (the phone shows a note when it's ready). They check it; "send it" sends it.${tagNote}`,
    };
  }
  if (group && !people.length) {
    return { ask: `To open "${group}" in Teams, LightMoon needs its link once: in Teams, long-press the chat (or tap ⋯ on the channel) → Copy link, then say "${group} is" and paste it. Offer to remember it with set_nickname.` };
  }
  const emails = [];
  const missing = [];
  for (const name of people) {
    const saved = lookUp(name);
    const address = EMAIL.test(name) ? name : saved && EMAIL.test(saved) ? saved : null;
    if (address) emails.push(address);
    else missing.push(name);
  }
  if (missing.length) {
    return { ask: `Teams finds people by their work email. Ask for ${missing.join(' and ')}'s work email, then remember each with set_nickname (e.g. ${missing[0]} = name@company.com) so it's known next time.` };
  }
  const params = new URLSearchParams({ users: emails.join(','), message: text });
  if (emails.length > 1 && group) params.set('topicName', group);
  return {
    kind: 'link', app: 'Teams',
    url: `https://teams.microsoft.com/l/chat/0/0?${params.toString().replace(/\+/g, '%20')}`,
    note: `Teams is opening the chat with ${people.join(', ')} with the message typed in. They check it and tap Send there; you haven't sent it.${tagNote}`,
  };
}
