// Checks docs/js/people.js: look-alike contacts, chats and emails are told apart, or asked about, never guessed.
// Run: npm test
import { pathToFileURL, fileURLToPath } from 'node:url';
const repo = fileURLToPath(new URL('..', import.meta.url)).replace(/[\/]$/, '');
import assert from 'node:assert/strict';
const { choosePerson, lookAlikeNotes, conversationsFrom, sameNumber } = await import(pathToFileURL(`${repo}/docs/js/people.js`));

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log('ok  ', name); } catch (err) { failed++; console.log('FAIL', name, '\n     ', err.message); }
};
const now = Date.parse('2026-10-30T18:00');
const hoursAgo = h => now - h * 3_600_000;
const ashaRao = { name: 'Asha Rao', numbers: [{ number: '+91 98480 11111', label: 'Mobile' }] };
const ashaOffice = { name: 'Asha Office', numbers: [{ number: '040 2345 2222', label: 'Work' }] };
const twoAshas = { name: 'Asha', numbers: [{ number: '98480 33333', label: 'Mobile' }, { number: '99590 44444', label: 'Mobile' }] };

console.log('-- people');
check('one match is used as it is', () => assert.equal(choosePerson('Mom', [{ name: 'Mom', numbers: [{ number: '98480 55555', label: 'Mobile' }] }]).person.number, '98480 55555'));
check('one number saved twice is one person', () => {
  const copy = { name: 'Ravi', numbers: [{ number: '+91 98480 66666', label: 'Mobile' }, { number: '098480 66666', label: 'Mobile' }] };
  assert.equal(choosePerson('Ravi', [copy]).person.number, '+91 98480 66666');
});
check('an exact name wins over partial matches', () => assert.equal(choosePerson('Asha Rao', [ashaRao, ashaOffice]).person.name, 'Asha Rao'));
check('two Ashas are asked about, not guessed', () => {
  const out = choosePerson('Asha', [ashaRao, ashaOffice], { now });
  assert.ok(out.ask && !out.person);
  assert.equal(out.options.length, 2);
});
check('the one who just messaged comes first', () => {
  const out = choosePerson('Asha', [ashaOffice, ashaRao], { now, messages: [{ from: 'Asha Rao', at: hoursAgo(1) }] });
  assert.equal(out.options[0].name, 'Asha Rao');
  assert.match(out.ask, /Most likely the first/);
  assert.match(out.ask, /messaged/);
});
check('the one they call often comes first', () => {
  const calls = [1, 30, 60].map(h => ({ number: '04023452222', type: 'outgoing', at: hoursAgo(h) }));
  const out = choosePerson('Asha', [ashaRao, ashaOffice], { now, calls });
  assert.equal(out.options[0].name, 'Asha Office');
  assert.match(out.ask, /spoke today/);
});
check('no history: says nothing tells them apart', () => assert.match(choosePerson('Asha', [ashaRao, ashaOffice], { now }).ask, /Nothing in their recent calls/));
check('one name, two numbers: both shown by label and last digits', () => {
  const out = choosePerson('Asha', [twoAshas], { now, calls: [{ number: '+919959044444', type: 'missed', at: hoursAgo(2) }] });
  assert.equal(out.options[0].number, '99590 44444');
  assert.match(out.ask, /Asha's mobile ending 4444/);
  assert.match(out.ask, /tried to call them today/);
});
check('offers to remember the choice', () => assert.match(choosePerson('Asha', [ashaRao, ashaOffice], { now }).ask, /set_nickname/));
check('numbers match across formats', () => assert.ok(sameNumber('+91 98480 11111', '098480-11111') && !sameNumber('12', '12')));

console.log('-- chats and emails');
const msgs = [
  { ref: 'M1', from: 'Asha', app: 'WhatsApp', chat: 'Asha', conversation: 'wa|Asha', at: hoursAgo(3) },
  { ref: 'M2', from: 'Asha', app: 'Teams', chat: 'Asha', conversation: 'teams|Asha', at: hoursAgo(2) },
  { ref: 'M3', from: 'Asha', app: 'WhatsApp', chat: 'Asha', conversation: 'wa|Asha', at: hoursAgo(1) },
  { ref: 'M4', from: 'Bank', app: 'Gmail', kind: 'email', conversation: 'gm|me|Bank', at: hoursAgo(5) },
  { ref: 'M5', from: 'Bank', app: 'Gmail', kind: 'email', conversation: 'gm|me|Bank', at: hoursAgo(4) },
  { ref: 'M6', from: 'Ravi', app: 'WhatsApp', chat: 'Family', conversation: 'wa|Family', at: hoursAgo(1) },
  { ref: 'M7', from: 'Ravi', app: 'Teams', chat: 'Family', conversation: 'teams|Family', at: hoursAgo(1) },
];
const notes = lookAlikeNotes(msgs);
check('Asha on WhatsApp and on Teams are marked', () => {
  assert.match(notes.M1, /SAME NAME, DIFFERENT CHAT: also M2/);
  assert.match(notes.M2, /also M1, M3/);
});
check('a group with the same name in two apps is marked', () => assert.match(notes.M6, /also M7/));
check('several emails from one sender are marked', () => {
  assert.match(notes.M4, /one of 2 emails from this sender: also M5/);
  assert.ok(!/DIFFERENT CHAT/.test(notes.M4));
});
check('someone with only one chat gets no note', () => assert.equal(lookAlikeNotes([msgs[0], msgs[3]]).M1, undefined));
check('replying to Asha could mean two chats, newest first', () => {
  const chats = conversationsFrom('asha', msgs);
  assert.deepEqual(chats.map(m => m.ref), ['M3', 'M2']);
});
check('a group name finds its chats', () => assert.equal(conversationsFrom('Family', msgs).length, 2));

process.exit(failed ? 1 : 0);
