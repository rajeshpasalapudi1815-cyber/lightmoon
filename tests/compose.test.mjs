// Checks docs/js/compose.js: Teams chats open with the message ready, groups and channels from their saved link,
// other apps through their share screen, and it asks when it's missing something. Run: npm test
import { pathToFileURL, fileURLToPath } from 'node:url';
const repo = fileURLToPath(new URL('..', import.meta.url)).replace(/[\/]$/, '');
import assert from 'node:assert/strict';
const { planCompose, splitPeople } = await import(pathToFileURL(`${repo}/docs/js/compose.js`));

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log('ok  ', name); } catch (err) { failed++; console.log('FAIL', name, '\n     ', err.message); }
};
const saved = {
  akash: 'akash.r@company.com',
  priya: 'priya@company.com',
  'noc team': 'https://teams.microsoft.com/l/channel/19%3aabc%40thread.tacv2/NOC%20Team?groupId=1&tenantId=2',
};
const lookUp = name => saved[String(name).toLowerCase()] ?? null;

console.log('-- Teams');
check('one person: chat opens with the message', () => {
  const plan = planCompose({ app: 'Teams', to: 'Akash', text: "I'm running late today", lookUp });
  assert.equal(plan.kind, 'link');
  const url = new URL(plan.url);
  assert.equal(url.searchParams.get('users'), 'akash.r@company.com');
  assert.equal(url.searchParams.get('message'), "I'm running late today");
  assert.ok(!plan.url.includes('+'), 'spaces are %20, not +');
});
check('several people with a group name', () => {
  const url = new URL(planCompose({ app: 'teams', to: 'Akash and Priya', group: 'Standup', text: 'Late today', lookUp }).url);
  assert.equal(url.searchParams.get('users'), 'akash.r@company.com,priya@company.com');
  assert.equal(url.searchParams.get('topicName'), 'Standup');
});
check('a saved channel opens from its link, message on the clipboard', () => {
  const plan = planCompose({ app: 'Teams', group: 'NOC Team', to: 'Akash', text: "@Akash I'm running late today", lookUp });
  assert.equal(plan.url, saved['noc team']);
  assert.equal(plan.copy, "@Akash I'm running late today");
  assert.match(plan.note, /Paste/);
  assert.match(plan.note, /type @ and pick Akash/);
});
check('unknown channel: asks for its link', () => assert.match(planCompose({ app: 'Teams', group: 'Ops Room', text: 'hi', lookUp }).ask, /Copy link/));
check('unknown person: asks for the work email', () => assert.match(planCompose({ app: 'Teams', to: 'Ravi', text: 'hi', lookUp }).ask, /Ravi's work email/));
check('an email given straight away works', () => assert.equal(new URL(planCompose({ app: 'Teams', to: 'ravi@company.com', text: 'hi', lookUp }).url).searchParams.get('users'), 'ravi@company.com'));

console.log('-- other apps');
check('Slack goes through its share screen', () => {
  const plan = planCompose({ app: 'Slack', to: 'Akash', text: 'Running late', lookUp });
  assert.equal(plan.kind, 'share');
  assert.match(plan.note, /pick the chat with Akash/);
});
check('needs the words', () => assert.ok(planCompose({ app: 'Slack', text: '  ', lookUp }).ask));
check('splits names', () => assert.deepEqual(splitPeople('Akash, Priya and Ravi'), ['Akash', 'Priya', 'Ravi']));

console.log('-- "send it" only for the last draft');
const { rememberDraft, recentDraft } = await import(pathToFileURL(`${repo}/docs/js/compose.js`));
check('a Teams draft is remembered with its app', () => {
  rememberDraft('teams', "I'm running late today");
  assert.deepEqual(recentDraft().apps, ['com.microsoft.teams']);
});
check('forgotten after ten minutes', () => assert.equal(recentDraft(Date.now() + 11 * 60_000), null));
check('an app the helper can\'t work in is not remembered', () => {
  rememberDraft('slack', 'hi');
  assert.equal(recentDraft(), null);
});

const { SEND_NOW } = await import(pathToFileURL(`${repo}/docs/js/compose.js`));
check('"send it" phrases, English and Telugu', () => assert.ok(['send it', 'Send it.', 'ok send it', 'yes, send', 'send it now', 'send cheyyi', 'pampu', 'ha send the message'].every(t => SEND_NOW.test(t))));
check('longer requests still go to the AI', () => assert.ok(!['send it to Priya instead', 'send a message to Akash', "don't send it", 'send the report by 5'].some(t => SEND_NOW.test(t))));

console.log('-- Teams chats by name (Send helper on)');
check('an unknown group opens by name', () => {
  const plan = planCompose({ app: 'Teams', group: 'IT Team', text: 'Hi, akkada unnava?', lookUp, byName: true });
  assert.equal(plan.kind, 'chat');
  assert.equal(plan.chat, 'IT Team');
});
check('an unknown person opens by name', () => assert.equal(planCompose({ app: 'Teams', to: 'Rajan Reddy', text: 'hi', lookUp, byName: true }).chat, 'Rajan Reddy'));
check('a known email still uses the chat link', () => assert.equal(planCompose({ app: 'Teams', to: 'Akash', text: 'hi', lookUp, byName: true }).kind, 'link'));
check('a saved channel link still wins', () => assert.equal(planCompose({ app: 'Teams', group: 'NOC Team', text: 'hi', lookUp, byName: true }).kind, 'link'));

process.exit(failed ? 1 : 0);
