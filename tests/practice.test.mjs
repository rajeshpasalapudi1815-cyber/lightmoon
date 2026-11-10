// Checks docs/js/practice.js: what starts and ends language practice, and that pronunciation hints aren't spoken.
// Run: npm test
import assert from 'node:assert/strict';
const mem = new Map();
globalThis.localStorage = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k) };
const { pathToFileURL, fileURLToPath } = await import('node:url');
const repo = fileURLToPath(new URL('..', import.meta.url)).replace(/[\/]$/, '');
const p = await import(pathToFileURL(`${repo}/docs/js/practice.js`));
const { forSpeech } = await import(pathToFileURL(`${repo}/docs/js/speech.js`));
let failed = 0;
const test = (name, fn) => {
  try { fn(); console.log('ok  ', name); } catch (err) { failed++; console.log('FAIL', name, '\n     ', err.message); }
};

test('asking to learn starts practice', () => {
  for (const said of ['Teach me Hindi', 'I want to learn Hindi', "let's practice Hindi", 'train me in Hindi language',
    'Can you teach me how to speak Hindi', 'Hindi lesson please', 'talk to me in Hindi so I can learn', 'help me improve my Hindi']) {
    assert.equal(p.practiceWanted(said), 'hi', said);
  }
  assert.equal(p.practiceWanted('teach me French'), 'fr');
});

test('other Hindi requests do not', () => {
  for (const said of ['speak in Hindi', 'what is water in Hindi', 'send a Hindi joke to Ravi', 'remind me to study at 6']) {
    assert.equal(p.practiceWanted(said), null, said);
  }
});

test('stopping', () => {
  for (const said of ['stop the practice', "that's enough for today", 'back to English', 'end the lesson', 'अब बस']) {
    assert.ok(p.practiceEnds(said), said);
  }
  assert.ok(!p.practiceEnds('मैं आज ऑफिस गया'));
});

test('start, carry on, end', () => {
  assert.equal(p.practice(), null);
  p.startPractice('hi');
  assert.equal(p.practice().lang, 'hi');
  assert.equal(p.practiceListening(), 'hi-IN');
  p.endPractice();
  assert.equal(p.practice(), null);
  assert.equal(p.practiceListening(), null);
});

test('the tutor prompt corrects and talks, never plans', () => {
  const prompt = p.practicePrompt({ lang: 'hi', name: 'Rajesh', firstTurn: true });
  assert.match(prompt, /Correction:/);
  assert.match(prompt, /Never make plans, schedules, checklists/);
  assert.match(prompt, /Devanagari/);
  assert.ok(prompt.length < 2600, `prompt is ${prompt.length} chars`);
});

test('history is only the practice, last turns', () => {
  const msgs = [{ role: 'user', content: 'old', at: 1 }, { role: 'system', content: 'x', at: 5000 },
    ...Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}`, at: 5000 + i }))];
  const got = p.practiceHistory(msgs, 5000);
  assert.equal(got.length, 12);
  assert.ok(got.every(m => m.role !== 'system' && m.content !== 'old'));
});

test('how to say it is shown, not spoken', () => {
  assert.equal(forSpeech('आप कैसे हैं? ⟨aap kaise hain?⟩'), 'आप कैसे हैं?');
});

if (failed) { console.log(`${failed} failed`); process.exit(1); }
