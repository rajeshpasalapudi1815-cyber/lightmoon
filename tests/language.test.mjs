// Checks docs/js/language.js and the voice choice by script (voices.js): "speak in Telugu" means Telugu letters said
// by a Telugu voice and listening in Telugu; yes and "send it" are understood in Telugu letters.
// Run: npm test
import { pathToFileURL, fileURLToPath } from 'node:url';
const repo = fileURLToPath(new URL('..', import.meta.url)).replace(/[\/]$/, '');
import assert from 'node:assert/strict';
const { languageCode, listeningLanguage, languageRule, NATIVE_YES, either, NATIVE_YES_ONLY, NATIVE_SEND_NOW } = await import(pathToFileURL(`${repo}/docs/js/language.js`));
const { scriptOf, voiceForLanguage } = await import(pathToFileURL(`${repo}/docs/js/voices.js`));
const { YES_ONLY, SEND_NOW } = await import(pathToFileURL(`${repo}/docs/js/compose.js`));
const { saidYes } = await import(pathToFileURL(`${repo}/docs/js/orders.js`));

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log('ok  ', name); } catch (err) { failed++; console.log('FAIL', name, '\n     ', err.message); }
};

console.log('-- which language');
check('names and codes', () => assert.deepEqual(['Telugu', 'te-IN', 'తెలుగు', 'hindi', 'English', 'en-IN', 'french'].map(languageCode), ['te', 'te', 'te', 'hi', 'en', 'en', null]));
check('listens in Telugu when talking Telugu', () => assert.equal(listeningLanguage('te', 'en-IN'), 'te-IN'));
check('else the device\'s own choice', () => assert.deepEqual([listeningLanguage('', 'en-IN'), listeningLanguage('en', 'en-GB')], ['en-IN', 'en-GB']));
check('the prompt asks for Telugu letters', () => assert.match(languageRule('te'), /Telugu script/));
check('English by default, with the way to switch', () => assert.match(languageRule(''), /set_language/));

console.log('-- the voice for the letters');
check('Telugu letters', () => assert.equal(scriptOf('బాస్, మీకు ఈ రోజు మూడు పనులు ఉన్నాయి. మొదటిది AWS.'), 'te'));
check('Hindi letters', () => assert.equal(scriptOf('ठीक है, मैं कॉल करता हूँ'), 'hi'));
check('English, or Telugu in English letters, stays English', () => assert.deepEqual([scriptOf('Your meeting is at 5'), scriptOf('Nenu late avthunna')], [null, null]));
const voices = [
  { name: 'en-in-x-ena-network', lang: 'en-IN', localService: false },
  { name: 'te-IN-language', lang: 'te-IN', localService: true },
  { name: 'te-in-x-tee-local', lang: 'te-IN', localService: true },
  { name: 'te-in-x-tee-network', lang: 'te-IN', localService: false },
];
check('a Telugu voice, online when it can', () => assert.equal(voiceForLanguage(voices, 'te', 'female').name, 'te-in-x-tee-network'));
check('offline without a connection', () => assert.equal(voiceForLanguage(voices, 'te', 'female', { online: false }).name, 'te-in-x-tee-local'));
check('never the "any voice" entry, none for Tamil here', () => assert.equal(voiceForLanguage(voices, 'ta', 'female'), null));

console.log('-- yes in Telugu letters');
check('అవును and సరే are a yes', () => assert.ok(saidYes('అవును') && saidYes('సరే, చేయి') && NATIVE_YES.test('हाँ')));
check('a no is not', () => assert.ok(!saidYes('వద్దు') && !saidYes('వద్దు yes')));
check('only a yes', () => assert.ok(YES_ONLY.test('సరే') && YES_ONLY.test('అవును పంపు') && !YES_ONLY.test('సరే కానీ friday')));
check('"ok" with Telugu after it isn\'t only a yes', () => assert.ok(!YES_ONLY.test('ok వద్దు')));
check('send it, in Telugu', () => assert.ok(SEND_NOW.test('పంపు') && SEND_NOW.test('సరే పంపించు') && NATIVE_SEND_NOW.test('పంపండి')));
check('English still works', () => assert.ok(YES_ONLY.test('ok send it') && SEND_NOW.test('send it') && !SEND_NOW.test('send it to Ravi tomorrow')));
check('either joins patterns', () => assert.ok(either(/a/, /b/).test('b') && !either(/a/).test('c') && NATIVE_YES_ONLY.test('ఓకే')));

if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
