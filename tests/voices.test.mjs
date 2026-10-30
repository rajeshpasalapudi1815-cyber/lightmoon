// Checks docs/js/voices.js: voices are told apart as male or female, and the best of each is picked.
// Run: npm test
import { pathToFileURL, fileURLToPath } from 'node:url';
const repo = fileURLToPath(new URL('..', import.meta.url)).replace(/[\/]$/, '');
import assert from 'node:assert/strict';
const { genderOf, bestVoice, wantedGender } = await import(pathToFileURL(`${repo}/docs/js/voices.js`));

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log('ok  ', name); } catch (err) { failed++; console.log('FAIL', name, '\n     ', err.message); }
};
const v = (name, lang = 'en-GB') => ({ name, lang });

console.log('-- male or female');
check('Android Indian female', () => assert.equal(genderOf(v('en-in-x-ena-network')), 'female'));
check('Android British male', () => assert.equal(genderOf(v('en-gb-x-rjs-local')), 'male'));
check('Edge natural male', () => assert.equal(genderOf(v('Microsoft Ryan Online (Natural) - English (United Kingdom)')), 'male'));
check('Edge natural female', () => assert.equal(genderOf(v('Microsoft Neerja Online (Natural) - English (India)')), 'female'));
check('Windows voices', () => assert.deepEqual([genderOf('Microsoft Zira - English (United States)'), genderOf('Microsoft David - English (United States)')], ['female', 'male']));
check('Chrome UK female and male', () => assert.deepEqual([genderOf('Google UK English Female'), genderOf('Google UK English Male')], ['female', 'male']));
check('Chrome US voice is female', () => assert.equal(genderOf('Google US English'), 'female'));
check('Apple voices', () => assert.deepEqual([genderOf('Daniel'), genderOf('Samantha')], ['male', 'female']));
check('unknown voice', () => assert.equal(genderOf('Some Robot 3000'), null));
check('Android "any voice" entry', () => assert.equal(genderOf('en-GB-language'), null));

console.log('-- the best of each');
const phone = ['en-gb-x-rjs-local', 'en-gb-x-gba-local', 'en-in-x-ena-local', 'en-in-x-ena-network', 'en-in-x-end-local'].map(n => v(n, 'en-IN'));
check('phone wants female', () => assert.equal(wantedGender(true), 'female'));
check('computer wants male', () => assert.equal(wantedGender(false), 'male'));
check('phone: Indian female, online first', () => assert.equal(bestVoice(phone, 'female').name, 'en-in-x-ena-network'));
check('phone offline: its offline twin', () => assert.equal(bestVoice(phone.filter(x => !x.name.endsWith('network')), 'female').name, 'en-in-x-ena-local'));
const edge = ['Microsoft Aria Online (Natural) - English (United States)', 'Microsoft Ryan Online (Natural) - English (United Kingdom)', 'Microsoft David - English (United States)'].map(n => v(n));
check('Edge: Ryan', () => assert.match(bestVoice(edge, 'male').name, /Ryan/));
check('Windows without Edge voices: David', () => assert.match(bestVoice([v('Microsoft Zira - English (United States)'), v('Microsoft David - English (United States)')], 'male').name, /David/));
check('falls back to any English voice of that kind', () => assert.equal(bestVoice([v('Microsoft Andrew Online (Natural) - English (United States)', 'en-US')], 'male').name.split(' ')[1], 'Andrew'));
check('none of that kind', () => assert.equal(bestVoice([v('Microsoft Zira - English (United States)')], 'male'), null));

process.exit(failed ? 1 : 0);
