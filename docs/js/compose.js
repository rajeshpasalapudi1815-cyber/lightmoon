// Messages written for the user in other apps, ready for them to check and send: Teams first (a chat with one
// person or several opens with the message typed in), and any other app (Slack, Telegram, Signal, Google Chat,
// Instagram...) through its "share to" screen. Nothing is sent from here: the user taps Send in the app.
// LightMoon can't move around inside another app (open a channel, @mention someone), so a Teams channel opens
// from its link with the message on the clipboard to paste. tools.js runs the plan; tests/compose.test.mjs checks it.

const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
const TEAMS_LINK = /^https:\/\/teams\.microsoft\.com\/l\//i;

// "Akash, Priya and Ravi" -> ['Akash', 'Priya', 'Ravi'].
export const splitPeople = to => String(to ?? '').split(/\s*(?:,|;|\band\b|&)\s*/i).map(s => s.trim()).filter(Boolean);

// A plan for compose_message: { kind: 'link', url, app, copy?, note } | { kind: 'share', app, text, note } | { ask }.
// lookUp turns a nickname into what it stands for (an email address, or a Teams chat or channel link).
export function planCompose({ app, to = '', text, group = '', lookUp = () => null }) {
  const words = String(text ?? '').trim();
  const where = String(app ?? '').trim();
  if (!words) return { ask: 'What should the message say?' };
  if (!where) return { ask: 'Which app should it go in?' };
  if (/^teams$|microsoft teams/i.test(where)) return planTeams({ to, text: words, group, lookUp });
  return {
    kind: 'share', app: where, text: words,
    note: `${where} is open on its "share to" screen with the message in it (it's on the clipboard too): they pick ${to ? `the chat with ${to}` : 'the chat'} and tap Send. You can't pick the chat or send it for them.`,
  };
}

function planTeams({ to, text, group, lookUp }) {
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
