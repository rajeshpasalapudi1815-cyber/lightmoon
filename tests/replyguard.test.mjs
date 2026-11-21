// Checks docs/js/replyguard.js: the AI's own thinking and its loops never reach the screen or the voice. Run: npm test
import assert from 'node:assert/strict';
const { pathToFileURL, fileURLToPath } = await import('node:url');
const repo = fileURLToPath(new URL('..', import.meta.url)).replace(/[\/]$/, '');
const { replyGuard, MAX_REPLY_CHARS } = await import(pathToFileURL(`${repo}/docs/js/replyguard.js`));
let failed = 0;
const test = (name, fn) => {
  try { fn(); console.log('ok  ', name); } catch (err) { failed++; console.log('FAIL', name, '\n     ', err.message); }
};
// Feeds text in small pieces, as a stream does.
const run = (text, size = 7) => {
  const shown = [];
  const g = replyGuard(piece => shown.push(piece));
  let stoppedAt = -1;
  for (let i = 0; i < text.length; i += size) if (!g.push(text.slice(i, i + size))) { stoppedAt = i; break; }
  const out = g.end();
  assert.equal(shown.join(''), out, 'what is shown is what is returned');
  return { out, stopped: stoppedAt >= 0 };
};

test('the reply that ran for five minutes stops after its real answer', () => {
  const real = 'Master, the Life Levelling system has no recorded metrics for you yet. If you want to start logging anything, just tell me what to record.';
  const spill = 'We need to ask follow-up? Already asked.Master, what habit shall we begin tracking first?We need to respond to user? They haven\'t asked. Probably wait.'
    + 'Master, I’m standing by.Master, I’m here.Master, I’m ready for your next command.'.repeat(200);
  const { out, stopped } = run(real + spill);
  assert.equal(out, real);
  assert.ok(stopped);
});

test('a loop of idle lines is cut to one', () => {
  const { out } = run('Done, boss. Master, I’m here. Master, I’m ready. Master, I’m standing by. Master, I’m here.');
  assert.equal(out, 'Done, boss. Master, I’m here.');
});

test('ordinary replies pass untouched, paragraphs and lists too', () => {
  const text = 'Your next meeting is at 3 PM. It is with Ravi.\n\nToday:\n1. Call the bank.\n2. Pay the 1,500 rupees fee.\nShall I remind you at 2:45?';
  assert.equal(run(text).out, text);
  assert.equal(run('Version 2.5 is out. Great!').out, 'Version 2.5 is out. Great!');
  assert.equal(run('Sure').out, 'Sure', 'the last unfinished sentence still comes through');
});

test('far too long is cut at a sentence', () => {
  const { out, stopped } = run('This is a sentence about number 1. '.repeat(1).concat(Array.from({ length: 200 }, (_, i) => `Point ${i} matters.`).join(' ')));
  assert.ok(stopped);
  assert.ok(out.length <= MAX_REPLY_CHARS && /\.$/.test(out));
});

if (failed) { console.log(`${failed} failed`); process.exit(1); }
