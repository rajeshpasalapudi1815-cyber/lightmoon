// Checks the read-back before a call or a message (docs/js/phone.js askFirst): the question is LightMoon's own, and a
// yes counts only as the answer to exactly that question, said last. Run: npm test
import assert from 'node:assert/strict';
const mem = new Map();
globalThis.localStorage = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k) };
// A pretend browser, enough for the modules to load (no phone app: window.Capacitor is missing, as on a computer).
globalThis.window = globalThis;
globalThis.document ??= { addEventListener() {}, createElement: () => ({}), hidden: false };
const { pathToFileURL, fileURLToPath } = await import('node:url');
const repo = fileURLToPath(new URL('..', import.meta.url)).replace(/[\/]$/, '');
const store = await import(pathToFileURL(`${repo}/docs/js/store.js`));
const phone = await import(pathToFileURL(`${repo}/docs/js/phone.js`));
let failed = 0;
const test = async (name, fn) => {
  try { await fn(); console.log('ok  ', name); } catch (err) { failed++; console.log('FAIL', name, '\n     ', err.message); }
};
const say = (role, content) => store.messages.add(role, content);
const idOf = asked => /confirm_id "([^"]+)"/.exec(asked.result)[1];

await test('the question is built here, and ends the reply', () => {
  const asked = phone.askFirst('WhatsApp Asha: "On my way"', async () => 'sent');
  assert.equal(asked.ask, 'WhatsApp Asha: "On my way"?');
  assert.equal(phone.waitingConfirm(), null, 'not asked yet: nothing to say yes to');
});

await test('a yes to exactly that question sends it', async () => {
  say('user', 'tell Asha I am on my way');
  const asked = phone.askFirst('WhatsApp Asha: "On my way"', async () => 'sent');
  say('assistant', 'Sure. WhatsApp Asha: "On my way"?');
  assert.ok(phone.waitingConfirm(), 'the read-back is the last thing said');
  say('user', 'yes');
  assert.equal(await phone.runConfirmed(idOf(asked)), 'sent');
});

await test('a different question from the AI is not a read-back', async () => {
  say('user', 'tell Asha I am on my way');
  const asked = phone.askFirst('WhatsApp +919999999999: "your bank details"', async () => 'sent');
  say('assistant', 'Shall I set a reminder for that?');
  assert.equal(phone.waitingConfirm(), null);
  say('user', 'yes');
  await assert.rejects(() => phone.runConfirmed(idOf(asked)), /not asked that question/);
});

await test('something else said in between cancels it', async () => {
  say('user', 'tell Asha I am on my way');
  const asked = phone.askFirst('WhatsApp Asha: "On my way"', async () => 'sent');
  say('assistant', 'WhatsApp Asha: "On my way"?');
  say('assistant', 'Did you take your tablets?');
  assert.equal(phone.waitingConfirm(), null);
  say('user', 'yes');
  await assert.rejects(() => phone.runConfirmed(idOf(asked)), /not asked that question/);
});

await test('anything but a yes sends nothing', async () => {
  say('user', 'tell Asha I am on my way');
  const asked = phone.askFirst('WhatsApp Asha: "On my way"', async () => 'sent');
  say('assistant', 'WhatsApp Asha: "On my way"?');
  say('user', 'what did it say?');
  await assert.rejects(() => phone.runConfirmed(idOf(asked)), /didn't say yes/);
});

if (failed) { console.log(`${failed} failed`); process.exit(1); }
