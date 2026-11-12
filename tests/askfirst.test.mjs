// Checks docs/js/askfirst.js: "are you free now?" before a reminder, and how the answer is understood.
// Run: npm test
import assert from 'node:assert/strict';
const { pathToFileURL, fileURLToPath } = await import('node:url');
const repo = fileURLToPath(new URL('..', import.meta.url)).replace(/[\/]$/, '');
const a = await import(pathToFileURL(`${repo}/docs/js/askfirst.js`));
let failed = 0;
const test = (name, fn) => {
  try { fn(); console.log('ok  ', name); } catch (err) { failed++; console.log('FAIL', name, '\n     ', err.message); }
};

test('the question says nothing of what the reminder is', () => {
  assert.equal(a.askLine([{ kind: 'reminder' }], { address: 'boss' }), 'Boss, are you free now? I have a reminder for you.');
  assert.equal(a.askLine([{ kind: 'reminder' }, { kind: 'reminder' }], { address: 'boss' }), 'Boss, are you free now? I have two reminders for you.');
  assert.equal(a.askLine([{ kind: 'reminder' }, { kind: 'check-in' }], { address: 'sir' }), 'Sir, are you free now? I have two things for you.');
  assert.match(a.askLine([{ kind: 'check-in' }], { address: 'boss' }), /check in with you/);
  assert.match(a.askLine([{ kind: 'reminder' }], { address: 'boss', afterCall: true }), /^Boss, your call is over\. Are you free now\?/);
  assert.match(a.askLine([{ kind: 'reminder', urgent: true }], { address: 'boss' }), /urgent/);
});

test('yes', () => {
  for (const said of ['yes', 'Yeah tell me', 'go ahead', "what is it", "I'm free", 'okay', 'haan bolo', 'हाँ बताओ', 'no, tell me', 'LightMoon yes', 'sure', 'यस', 'ओके टेल मी']) {
    assert.equal(a.consentAnswer(said), 'yes', said);
  }
});

test('not now, and when to ask again', () => {
  assert.deepEqual(a.consentAnswer('not now'), { later: 10 });
  assert.deepEqual(a.consentAnswer("no I'm busy"), { later: 10 });
  assert.deepEqual(a.consentAnswer('ask me in 20 minutes'), { later: 20 });
  assert.deepEqual(a.consentAnswer('later, in half an hour'), { later: 30 });
  assert.deepEqual(a.consentAnswer("I'm in a meeting, after an hour"), { later: 60 });
  assert.deepEqual(a.consentAnswer('in 2 hours'), { later: 120 });
  assert.deepEqual(a.consentAnswer('abhi nahi'), { later: 10 });
  assert.deepEqual(a.consentAnswer('बाद में'), { later: 10 });
  assert.deepEqual(a.consentAnswer('नॉट नाउ'), { later: 10 });
});

test('anything else is their own request, not an answer', () => {
  for (const said of ['what is the weather tomorrow', 'call Ravi', 'play some music', 'how many steps did I walk today and what is left on my list']) {
    assert.equal(a.consentAnswer(said), null, said);
  }
});

test('a reminder that was just said is answered by voice, like its buttons', () => {
  for (const said of ['done', 'Done.', 'did it', 'I did it', 'yes, done', 'already done', 'हो गया', 'ayipoindi']) assert.deepEqual(a.reminderAnswer(said), { action: 'done' }, said);
  for (const said of ['stop asking', "don't ask me again", 'skip it']) assert.deepEqual(a.reminderAnswer(said), { action: 'stop' }, said);
  assert.deepEqual(a.reminderAnswer('snooze it'), { action: 'snooze', minutes: 10 });
  assert.deepEqual(a.reminderAnswer('snooze for 20 minutes'), { action: 'snooze', minutes: 20 });
  assert.deepEqual(a.reminderAnswer('in half an hour'), { action: 'snooze', minutes: 30 });
  assert.deepEqual(a.reminderAnswer('remind me in 2 hours'), { action: 'snooze', minutes: 120 });
  for (const said of ['done with the report but the slides are pending, move those to tomorrow morning please', 'what was that again', 'call Ravi instead', 'tomorrow morning']) {
    assert.equal(a.reminderAnswer(said), null, said);
  }
});

if (failed) { console.log(`${failed} failed`); process.exit(1); }
