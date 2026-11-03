// Checks docs/js/voicecontrol.js: commands about LightMoon itself are recognised, ordinary sentences aren't.
// Run: npm test
import { pathToFileURL, fileURLToPath } from 'node:url';
const repo = fileURLToPath(new URL('..', import.meta.url)).replace(/[\/]$/, '');
import assert from 'node:assert/strict';
const { voiceCommand } = await import(pathToFileURL(`${repo}/docs/js/voicecontrol.js`));

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log('ok  ', name); } catch (err) { failed++; console.log('FAIL', name, '\n     ', err.message); }
};
const all = (phrases, want) => phrases.forEach(p => assert.equal(voiceCommand(p), want, p));

check('wake word off', () => all(['turn off the wake word', 'Wake word off.', 'turn the wake word off', 'switch off wake up word', 'off the wake word', 'stop the wake word', 'Hey Sunshine, turn off the wake word'], 'wake-off'));
check('wake word on', () => all(['turn on the wake word', 'wake word on', 'turn the wake word back on', 'enable the wake word'], 'wake-on'));
check('hide', () => all(['go back to the background', 'hide yourself', 'Go to background.', 'run in the background', 'minimise yourself'], 'hide'));
check('show', () => all(['show yourself', 'come back', 'stop hiding'], 'show'));
check('ordinary sentences are not commands', () => all(['what time is it', 'remind me to wake up at 6', 'how do I turn off notifications', 'I want to go hiking'], null));
check('a long sentence that mentions it is not a command', () => assert.equal(voiceCommand('can you tell me why the wake word keeps turning off when I am outside'), null));

if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
