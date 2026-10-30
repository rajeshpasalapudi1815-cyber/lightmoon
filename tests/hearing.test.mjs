// Checks docs/js/hearing.js: mishearings learnt from the user's own fixes (and nothing else), fixed next time,
// and saying the same thing again noticed.
// Run: npm test
import { pathToFileURL, fileURLToPath } from 'node:url';
const repo = fileURLToPath(new URL('..', import.meta.url)).replace(/[\/]$/, '');
import assert from 'node:assert/strict';
const { learnedFix, applyFixes, withFix, saidAgain, soundsAlike } = await import(pathToFileURL(`${repo}/docs/js/hearing.js`));

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log('ok  ', name); } catch (err) { failed++; console.log('FAIL', name, '\n     ', err.message); }
};

console.log('-- learning from a fix');
check('pulav fixed to pull up is learnt', () => assert.deepEqual(learnedFix('pulav my mails', 'pull up my mails'), { heard: 'pulav', meant: 'pull up' }));
check('a misheard name is learnt', () => assert.deepEqual(learnedFix('tell kept in I am running late', 'tell Gifty I am running late'), { heard: 'kept in', meant: 'Gifty' }));
check('punctuation and case are not fixes', () => assert.equal(learnedFix('send it', 'Send it.'), null));
check('a different person is a change of mind, not a mishearing', () => assert.equal(learnedFix('tell Ravi I am late', 'tell Deeksha I am late'), null));
check('a rewritten message teaches nothing', () => assert.equal(learnedFix('what is the weather', 'remind me to call mom at six'), null));
check('swapping little words teaches nothing', () => assert.equal(learnedFix('remind me at six', 'remind me to six'), null));
check('a word added at the end teaches nothing', () => assert.equal(learnedFix('call mom', 'call mom now'), null));
check('sounds alike: pulav / pull up', () => assert.ok(soundsAlike('pulav', 'pull up')));
check('does not sound alike: ravi / gifty', () => assert.ok(!soundsAlike('ravi', 'gifty')));

console.log('-- fixing it next time');
check('a learnt fix is applied as whole words', () => assert.deepEqual(applyFixes('Pulav my calendar', { pulav: 'pull up' }), { text: 'pull up my calendar', used: [{ heard: 'pulav', meant: 'pull up' }] }));
check('not inside other words', () => assert.equal(applyFixes('pulavs are tasty', { pulav: 'pull up' }).text, 'pulavs are tasty'));
check('phrases with two words', () => assert.equal(applyFixes('tell kept  in hi', { 'kept in': 'Gifty' }).text, 'tell Gifty hi'));
check('nothing learnt, nothing changed', () => assert.deepEqual(applyFixes('hello there', {}), { text: 'hello there', used: [] }));
check('regex characters in a fix are literal', () => assert.equal(applyFixes('a.b axb', { 'a.b': 'x' }).text, 'x axb'));
check('newest fix wins and old ones are let go', () => {
  let fixes = {};
  for (let i = 0; i < 90; i++) fixes = withFix(fixes, { heard: `w${i}`, meant: `m${i}` });
  fixes = withFix(fixes, { heard: 'w89', meant: 'new' });
  assert.equal(Object.keys(fixes).length, 80);
  assert.equal(fixes.w89, 'new');
  assert.equal(fixes.w0, undefined);
});

console.log('-- saying it again');
check('nearly the same words soon after', () => assert.ok(saidAgain('open teams and message deeksha', 'open teams message deeksha please', 30_000)));
check('different requests are not repeats', () => assert.ok(!saidAgain('what is the weather today', 'open teams and message deeksha', 30_000)));
check('two yeses are not a repeat', () => assert.ok(!saidAgain('yes', 'yes', 5_000)));
check('the same thing an hour later is a new request', () => assert.ok(!saidAgain('check my mails now', 'check my mails now', 3_600_000)));

process.exit(failed ? 1 : 0);
