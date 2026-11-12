// Checks docs/js/quicksend.js: "WhatsApp wife akkada unnav bangaram" is understood without the AI, the words kept
// exactly, Telugu letters turned into English ones as they'd type them.
// Run: npm test
import { pathToFileURL, fileURLToPath } from 'node:url';
const repo = fileURLToPath(new URL('..', import.meta.url)).replace(/[\/]$/, '');
import assert from 'node:assert/strict';
const { parseSend, splitNameAndText, teluguToLatin } = await import(pathToFileURL(`${repo}/docs/js/quicksend.js`));

let failed = 0;
const check = async (name, fn) => {
  try { await fn(); console.log('ok  ', name); } catch (err) { failed++; console.log('FAIL', name, '\n     ', err.message); }
};
const known = new Set(['wife', 'mr sharma tv', 'ravi', 'mom']);
const isPerson = async name => known.has(name.toLowerCase());

console.log('-- an order to message someone');
await check('WhatsApp wife ...', () => assert.deepEqual(parseSend('WhatsApp wife akkada unnav bangaram'), { via: 'whatsapp', rest: 'wife akkada unnav bangaram' }));
await check('send a whatsapp to Mom', () => assert.equal(parseSend('send a whatsapp to Mom').rest, 'Mom'));
await check('sms goes as a text', () => assert.equal(parseSend('sms Ravi call me').via, 'sms'));
await check('not orders', () => assert.deepEqual([parseSend('message from Asha'), parseSend('what is whatsapp'), parseSend('text me back')], [null, null, null]));
await check('in Telugu letters', () => assert.equal(parseSend('వాట్సాప్ wife అక్కడ ఉన్నావ్')?.via, 'whatsapp'));

console.log('-- who and what');
await check('the name, then their words as said', async () => assert.deepEqual(await splitNameAndText('wife akkada unnav bangaram', isPerson), { to: 'wife', text: 'akkada unnav bangaram' }));
await check('a longer name first', async () => assert.deepEqual(await splitNameAndText('Mr Sharma TV call me', isPerson), { to: 'Mr Sharma TV', text: 'call me' }));
await check('no words yet', async () => assert.deepEqual(await splitNameAndText('wife', isPerson), { to: 'wife', text: '' }));
await check('"that" is dropped', async () => assert.equal((await splitNameAndText('Ravi that I am late', isPerson)).text, 'I am late'));
await check('nobody by that name', async () => assert.equal(await splitNameAndText('Suresh hello', isPerson), null));

console.log('-- Telugu letters to English ones');
await check('akkada unnav bangaram', () => assert.equal(teluguToLatin('అక్కడ ఉన్నావ్ బంగారం'), 'akkada unnav bangaram'));
await check('intiki vastunna', () => assert.equal(teluguToLatin('ఇంటికి వస్తున్నా'), 'intiki vastunna'));
await check('English and punctuation kept', () => assert.equal(teluguToLatin('సరే, ok తిన్నావా?'), 'sare, ok tinnava?'));

if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
