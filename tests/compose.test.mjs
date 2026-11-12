// Checks docs/js/compose.js: a message for another personal app goes through that app's share screen, it asks when
// it's missing something, and "send it" only ever sends the last draft. Work apps are not handled at all. Run: npm test
import { pathToFileURL, fileURLToPath } from 'node:url';
const repo = fileURLToPath(new URL('..', import.meta.url)).replace(/[\/]$/, '');
import assert from 'node:assert/strict';
const { planCompose, rememberDraft, recentDraft, SEND_NOW, SEND_APPS } = await import(pathToFileURL(`${repo}/docs/js/compose.js`));

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log('ok  ', name); } catch (err) { failed++; console.log('FAIL', name, '\n     ', err.message); }
};

console.log('-- other apps');
check('Telegram goes through its share screen', () => {
  const plan = planCompose({ app: 'Telegram', to: 'Akash', text: 'Running late' });
  assert.equal(plan.kind, 'share');
  assert.match(plan.note, /pick the chat with Akash/);
});
check('needs the words', () => assert.ok(planCompose({ app: 'Telegram', text: '  ' }).ask));
check('needs the app', () => assert.ok(planCompose({ app: '', text: 'hi' }).ask));

console.log('-- "send it" only for the last draft');
check('a WhatsApp draft is remembered with its app', () => {
  rememberDraft('whatsapp', "I'm running late today");
  assert.deepEqual(recentDraft().apps, ['com.whatsapp', 'com.whatsapp.w4b']);
});
check('forgotten after ten minutes', () => assert.equal(recentDraft(Date.now() + 11 * 60_000), null));
check("an app the helper can't work in is not remembered", () => {
  rememberDraft('slack', 'hi');
  assert.equal(recentDraft(), null);
});
check('no work app is ever one the helper sends in', () => {
  assert.equal(SEND_APPS.teams, undefined);
  assert.ok(!Object.values(SEND_APPS).flat().some(app => /teams|outlook/.test(app)));
  rememberDraft('teams', 'hi');
  assert.equal(recentDraft(), null);
});

check('"send it" phrases, English and Telugu', () => assert.ok(['send it', 'Send it.', 'ok send it', 'yes, send', 'send it now', 'send cheyyi', 'pampu', 'ha send the message'].every(t => SEND_NOW.test(t))));
check('longer requests still go to the AI', () => assert.ok(!['send it to Priya instead', 'send a message to Akash', "don't send it", 'send the report by 5'].some(t => SEND_NOW.test(t))));

process.exit(failed ? 1 : 0);
