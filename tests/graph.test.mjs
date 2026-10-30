// Checks docs/js/graph.js's plain helpers: finding a Teams chat or person by what was said, and @mentions.
// Run: npm test
import { pathToFileURL, fileURLToPath } from 'node:url';
const repo = fileURLToPath(new URL('..', import.meta.url)).replace(/[\/]$/, '');
import assert from 'node:assert/strict';
globalThis.localStorage ??= { getItem: () => null, setItem() {}, removeItem() {} };
const { nameScore, bestMatches, buildMessage, escapeHtml } = await import(pathToFileURL(`${repo}/docs/js/graph.js`));
const { YES_ONLY } = await import(pathToFileURL(`${repo}/docs/js/compose.js`));

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log('ok  ', name); } catch (err) { failed++; console.log('FAIL', name, '\n     ', err.message); }
};

const places = [
  { kind: 'chat', label: 'NOC Team' },
  { kind: 'chat', label: 'NOC Team old' },
  { kind: 'chat', label: 'Gunukonda, Akash | Saras America' },
  { kind: 'chat', label: 'IT Team' },
  { kind: 'channel', label: 'General (IP & Billing Audit)' },
  { kind: 'chat', label: 'Deeksha Rao' },
];

console.log('-- finding the chat');
check('exact name wins over a longer one', () => assert.deepEqual(bestMatches(places, 'noc team').map(p => p.label), ['NOC Team']));
check('first name finds the person', () => assert.equal(bestMatches(places, 'Akash')[0].label, 'Gunukonda, Akash | Saras America'));
check('start of a name', () => assert.equal(bestMatches(places, 'Deeksha')[0].label, 'Deeksha Rao'));
check('no match', () => assert.equal(bestMatches(places, 'Finance').length, 0));
check('scores', () => assert.deepEqual([nameScore('NOC Team', 'NOC Team'), nameScore('NOC Team old', 'noc team'), nameScore('Gunukonda, Akash', 'akash')], [3, 2, 1]));

console.log('-- messages and mentions');
check('plain text is made safe', () => assert.equal(buildMessage('a < b & c').body.content, 'a &lt; b &amp; c'));
check('@Akash in the text becomes a real mention', () => {
  const msg = buildMessage('@Akash I am running late', [{ id: 'u1', name: 'Gunukonda, Akash' }]);
  assert.equal(msg.body.content, '<at id="0">Akash</at> I am running late');
  assert.equal(msg.mentions[0].mentioned.user.id, 'u1');
  assert.equal(msg.mentions[0].mentionText, 'Akash');
});
check('a mention not in the text goes in front', () => assert.match(buildMessage('Hi, akkada unnava?', [{ id: 'u2', name: 'Deeksha Rao' }]).body.content, /^<at id="0">Deeksha<\/at> Hi, akkada unnava\?$/));
check('no mentions, no mentions field', () => assert.equal(buildMessage('hi').mentions, undefined));
check('escapeHtml', () => assert.equal(escapeHtml('<b>'), '&lt;b&gt;'));

console.log('-- a plain yes confirms on the phone');
check('just a yes', () => assert.ok(['yes', 'ok send it', 'haan ji', 'sare', 'go ahead', 'Yes please.'].every(t => YES_ONLY.test(t))));
check('a yes with changes is not', () => assert.ok(!['yes, but make it Friday', 'yes change the time', 'no', 'send it to Priya'].some(t => YES_ONLY.test(t))));

process.exit(failed ? 1 : 0);
