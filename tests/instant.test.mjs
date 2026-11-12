// Checks docs/js/instant.js: which requests are instant commands (done on the device, no AI), what a protocol's
// steps turn into, and what is left for the AI. Run: npm test
import assert from 'node:assert/strict';
const { pathToFileURL, fileURLToPath } = await import('node:url');
const repo = fileURLToPath(new URL('..', import.meta.url)).replace(/[\/]$/, '');
const i = await import(pathToFileURL(`${repo}/docs/js/instant.js`));
let failed = 0;
const test = (name, fn) => {
  try { fn(); console.log('ok  ', name); } catch (err) { failed++; console.log('FAIL', name, '\n     ', err.message); }
};
const at3pm = new Date(2026, 10, 13, 15, 0);
const phone = { device: 'phone', now: at3pm };
const computer = { device: 'computer', now: at3pm };
const cmd = (text, where = phone) => i.instantCommand(text, where);

test('the time, the date, status, battery, say it again', () => {
  assert.deepEqual(cmd('What time is it?'), { kind: 'time' });
  assert.deepEqual(cmd("what's the date today"), { kind: 'date' });
  for (const said of ['status report', 'Hey LightMoon, status report', 'run diagnostics', 'is everything working', 'sitrep', 'give me a full status report', 'systems check']) {
    assert.deepEqual(cmd(said), { kind: 'status' }, said);
  }
  assert.deepEqual(cmd('how much battery is left'), { kind: 'battery' });
  assert.deepEqual(cmd('say that again'), { kind: 'repeat' });
  assert.deepEqual(i.instantCommand('Sunshine, what time is it', { names: ['sunshine'] }), { kind: 'time' }, 'their own name for it');
});

test('timers and alarms (the phone)', () => {
  assert.deepEqual(cmd('set a timer for 10 minutes'), { kind: 'timer', seconds: 600 });
  assert.deepEqual(cmd('timer 90 seconds'), { kind: 'timer', seconds: 90 });
  assert.deepEqual(cmd('start a 5 minute timer'), { kind: 'timer', seconds: 300 });
  assert.deepEqual(cmd('timer for an hour and a half'), { kind: 'timer', seconds: 5400 });
  assert.deepEqual(cmd('alarm at 6:30 am'), { kind: 'alarm', hour: 6, minute: 30 });
  assert.deepEqual(cmd('wake me up at 7 in the morning'), { kind: 'alarm', hour: 7, minute: 0 });
  assert.deepEqual(cmd('set an alarm for 6'), { kind: 'alarm', hour: 18, minute: 0 }, 'at 3 pm, the next 6 is this evening');
  assert.deepEqual(i.instantCommand('set an alarm for 6', { device: 'phone', now: new Date(2026, 10, 13, 22, 0) }), { kind: 'alarm', hour: 6, minute: 0 }, 'at 10 pm it is the morning');
});

test('focus, do not disturb, torch, ringer, volume', () => {
  assert.deepEqual(cmd('focus for 45 minutes'), { kind: 'focus', minutes: 45 });
  assert.deepEqual(cmd('focus mode'), { kind: 'focus', minutes: 45 });
  assert.deepEqual(cmd('end focus'), { kind: 'focus', end: true });
  assert.deepEqual(cmd('silence the phone for an hour'), { kind: 'focus', minutes: 60 });
  assert.deepEqual(cmd('do not disturb for half an hour'), { kind: 'quiet', minutes: 30 });
  assert.deepEqual(cmd('hold everything for 2 hours'), { kind: 'quiet', minutes: 120 });
  assert.deepEqual(cmd('torch on'), { kind: 'torch', on: true });
  assert.deepEqual(cmd('turn off the flashlight'), { kind: 'torch', on: false });
  assert.deepEqual(cmd('put the phone on silent'), { kind: 'ringer', mode: 'silent' });
  assert.deepEqual(cmd('vibrate mode'), { kind: 'ringer', mode: 'vibrate' });
  assert.deepEqual(cmd('volume 40'), { kind: 'volume', percent: 40, stream: 'media' });
  assert.deepEqual(cmd('ring volume to max'), { kind: 'volume', percent: 100, stream: 'ring' });
  assert.deepEqual(cmd('mute'), { kind: 'volume', percent: 0, stream: 'media' });
});

test('music and apps', () => {
  assert.deepEqual(cmd('pause'), { kind: 'media', action: 'pause' });
  assert.deepEqual(cmd('play some music'), { kind: 'media', action: 'play' });
  assert.deepEqual(cmd('next song'), { kind: 'media', action: 'next' });
  assert.deepEqual(cmd('previous track'), { kind: 'media', action: 'previous' });
  assert.deepEqual(cmd('play despacito on spotify'), { kind: 'media', action: 'play', what: 'despacito', app: 'spotify' });
  assert.deepEqual(cmd('open spotify'), { kind: 'open', name: 'spotify' });
  assert.deepEqual(cmd('Could you please open WhatsApp for me?'), { kind: 'open', name: 'whatsapp' });
  assert.deepEqual(cmd('launch vs code', computer), { kind: 'open', name: 'vs code' });
});

test("the computer has no torch, ringer or clock app, and what to play there is the AI's call", () => {
  for (const said of ['torch on', 'timer 10 minutes', 'volume 40', 'put the phone on silent', 'play lofi']) assert.equal(cmd(said, computer), null, said);
  assert.deepEqual(cmd('pause', computer), { kind: 'media', action: 'pause' });
  assert.deepEqual(cmd('status report', computer), { kind: 'status' });
});

test('anything unsure goes to the AI', () => {
  for (const said of ['next', 'back', 'continue', 'stop', 'stop everything', 'volume up', 'what time is it in new york', 'remind me at 5 to call ravi', 'how are you',
    'play a game', 'play it safe', 'open the door', 'start work', 'start the timer', 'open spotify and send ravi a message', 'what is the status of my order',
    'tell me a story about a timer that ran for 10 minutes and what happened when it ended in the old house']) {
    assert.equal(cmd(said), null, said);
  }
});

const ROUTINES = [
  { trigger: 'focus protocol', steps: 'focus for 45 minutes; open Spotify and play lofi' },
  { trigger: 'good night', steps: 'Silence the phone, then set an alarm for 6:30 am. Say good night boss' },
  { trigger: 'weekly review', steps: 'summarise my week and suggest three goals' },
];

test('a protocol is asked for by name', () => {
  for (const said of ['activate focus protocol', 'run the focus protocol', 'focus protocol', 'Hey LightMoon, activate the focus protocol please', 'focus']) {
    assert.equal(i.protocolAsked(said, ROUTINES)?.trigger, 'focus protocol', said);
  }
  assert.equal(i.protocolAsked('good night', ROUTINES)?.trigger, 'good night');
  assert.equal(i.protocolAsked('start weekly review', ROUTINES)?.trigger, 'weekly review');
  for (const said of ['activate house party protocol', 'I said good night to her', 'what is a protocol', 'focus on my work today']) assert.equal(i.protocolAsked(said, ROUTINES), null, said);
});

test('steps that are all instant commands run without the AI', () => {
  assert.deepEqual(i.protocolSteps(ROUTINES[0].steps, phone), [{ kind: 'focus', minutes: 45 }, { kind: 'open', name: 'spotify' }, { kind: 'media', action: 'play', what: 'lofi' }]);
  assert.deepEqual(i.protocolSteps(ROUTINES[1].steps, phone), [{ kind: 'ringer', mode: 'silent' }, { kind: 'alarm', hour: 6, minute: 30 }, { kind: 'say', text: 'good night boss' }]);
  assert.equal(i.protocolSteps(ROUTINES[2].steps, phone), null, 'needs the AI');
  assert.equal(i.protocolSteps(ROUTINES[1].steps, computer), null, 'the computer cannot silence a phone: the AI decides');
  assert.deepEqual(i.protocolSteps('opens spotify and plays some music', phone), [{ kind: 'open', name: 'spotify' }, { kind: 'media', action: 'play' }]);
  assert.deepEqual(i.protocolSteps('hold everything for 30 minutes and say good luck boss', computer), [{ kind: 'quiet', minutes: 30 }, { kind: 'say', text: 'good luck boss' }], 'a line to say keeps its words');
});

test('a protocol is defined in one breath', () => {
  assert.deepEqual(i.protocolDefined('When I say focus protocol, focus for 45 minutes, open Spotify and play lofi'), { trigger: 'focus protocol', steps: 'focus for 45 minutes, open spotify and play lofi' });
  assert.deepEqual(i.protocolDefined('Create a protocol called movie night: put the phone on silent; volume 30; open Netflix'), { trigger: 'movie night', steps: 'put the phone on silent; volume 30; open netflix' });
  assert.equal(i.protocolDefined('what is a protocol'), null);
  assert.ok(i.protocolsListed('what protocols do I have?'));
  assert.ok(!i.protocolsListed('what is a protocol'));
});

test('said back in plain words', () => {
  assert.equal(i.protocolSteps(ROUTINES[1].steps, phone).map(i.describe).join('; '), 'put the phone on silent; set an alarm for 6:30 AM; say "good night boss"');
  assert.equal(i.spokenDuration(5400), '1 hour and 30 minutes');
  assert.equal(i.spokenClock(18, 5), '6:05 PM');
});

if (failed) { console.log(`${failed} failed`); process.exit(1); }
