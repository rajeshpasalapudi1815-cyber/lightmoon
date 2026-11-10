// Checks docs/js/interpreter.js: what starts and stops it, and that Whisper's made-up lines are never said.
// Run: npm test
import assert from 'node:assert/strict';
const { pathToFileURL, fileURLToPath } = await import('node:url');
const repo = fileURLToPath(new URL('..', import.meta.url)).replace(/[\/]$/, '');
const it = await import(pathToFileURL(`${repo}/docs/js/interpreter.js`));
let failed = 0;
const test = (name, fn) => {
  try { fn(); console.log('ok  ', name); } catch (err) { failed++; console.log('FAIL', name, '\n     ', err.message); }
};

test('asking for an interpreter', () => {
  for (const said of ['translate for me', 'be my interpreter', 'what is he saying?', "what's she saying", 'what are they saying',
    'translate what he is saying', 'translate what this guy says', 'tell me what they are saying', 'translate this conversation', 'translate live']) {
    assert.ok(it.interpreterWanted(said), said);
  }
});

test('other translation requests go to the AI', () => {
  for (const said of ['translate hello to Hindi', 'what is water in Marathi', 'interpret this word', 'what did Ravi say in his message', 'teach me Hindi']) {
    assert.ok(!it.interpreterWanted(said), said);
  }
});

test('stopping by voice', () => {
  for (const said of ['Stop translating.', 'stop the translation', 'end interpreting', "That's enough.", 'Thank you, LightMoon.']) {
    assert.ok(it.interpreterStop(said), said);
  }
  assert.ok(!it.interpreterStop('Please stop at the next station.'));
});

test("Whisper's made-up lines are dropped", () => {
  for (const noise of ['Thank you.', 'Thanks for watching!', 'you', '...', '[Music]', '(applause)', '', 'मैं']) {
    assert.equal(it.cleanTranslation(noise), '', noise);
  }
  assert.equal(it.cleanTranslation('  Where are you going   today? '), 'Where are you going today?');
});

if (failed) { console.log(`${failed} failed`); process.exit(1); }
