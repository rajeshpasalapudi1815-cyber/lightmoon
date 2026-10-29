// Checks docs/js/speech.js: what LightMoon says aloud and where it breaks it. Run: npm test
import { pathToFileURL, fileURLToPath } from 'node:url';
const repo = fileURLToPath(new URL('..', import.meta.url)).replace(/[\/]$/, '');
import assert from 'node:assert/strict';
const { forSpeech, sentencesOf, speechChunks, lastSentenceEnd } = await import(pathToFileURL(`${repo}/docs/js/speech.js`));
let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log('ok  ', name); } catch (err) { failed++; console.log('FAIL', name, '\n     ', err.message); }
};
const year = new Date().getFullYear();

check('numbers stay whole', () => assert.deepEqual(sentencesOf(forSpeech('LightMoon 1.7 is out. It costs 2.5 dollars.')), ['LightMoon 1.7 is out.', 'It costs 2.5 dollars.']));
check('abbreviations are said, not stopped at', () => assert.equal(forSpeech('Bring fruit, e.g. apples, i.e. something light.'), 'Bring fruit, for example apples, that is something light.'));
check('titles do not end a sentence', () => assert.deepEqual(sentencesOf(forSpeech('Call Dr. Rao at 5. He is waiting.')), ['Call Dr Rao at 5.', 'He is waiting.']));
check('initials do not end a sentence', () => assert.deepEqual(sentencesOf('Read J. K. Rowling tonight. Then sleep.'), ['Read J. K. Rowling tonight.', 'Then sleep.']));
check('emoji are dropped', () => assert.equal(forSpeech('Well done 🎉👍🏽 Boss! ❤️'), 'Well done Boss!'));
check('markdown and lists become sentences', () => assert.equal(forSpeech('**Today:**\n- Gym at 7\n- Call Mom\n1. Pay rent'), 'Today: Gym at 7. Call Mom. Pay rent.'));
check('links are not read out', () => assert.equal(forSpeech('See [the guide](https://x.y/z) or https://a.b/c.'), 'See the guide or the link.'));
check('money and symbols', () => assert.equal(forSpeech('It is ₹1,20,000 & 15% off, 28°C, 3-4 days.'), 'It is 120000 rupees and 15 percent off, 28 degrees Celsius, 3 to 4 days.'));
check('dates and times', () => assert.equal(forSpeech(`Due ${year}-11-01T10:00 and 2025-01-05. Meet at 5 p.m. today.`), 'Due 1 November at 10 AM and 5 January 2025. Meet at 5 PM today.'));
check('phone numbers stay', () => assert.equal(forSpeech('Call 98480-12345.'), 'Call 98480-12345.'));
check('brackets become pauses', () => assert.equal(forSpeech('Drink water (two glasses) now.'), 'Drink water, two glasses, now.'));
check('slashes between words', () => assert.equal(forSpeech('Say yes/no.'), 'Say yes or no.'));
check('short sentences join into one phrase', () => assert.deepEqual(speechChunks('Yes. Done. It is at 5.'), ['Yes. Done. It is at 5.']));
check('long text splits at pauses under the limit', () => {
  const long = 'This is a long sentence about your plans for the week, which include the gym on Monday, a call with your manager on Tuesday, groceries on Wednesday, the dentist on Thursday, and a long-awaited dinner with friends on Friday evening at the new place.';
  const chunks = speechChunks(long, { max: 120 });
  assert.ok(chunks.length >= 2 && chunks.every(c => c.length <= 120), JSON.stringify(chunks));
  assert.equal(chunks.join(' '), forSpeech(long));
});
check('streaming: no cut at e.g. or a decimal', () => {
  assert.equal(lastSentenceEnd('Try fruit, e.g. '), -1);
  assert.equal(lastSentenceEnd('Version 1.'), -1);
  assert.equal(lastSentenceEnd('Step 1. '), -1);
  assert.equal(lastSentenceEnd('Call Dr. '), -1);
  assert.equal(lastSentenceEnd('Done. Next'), 6);
  assert.equal(lastSentenceEnd('Line one\nLine'), 9);
  assert.equal(lastSentenceEnd('It is **done**. Next'), 16);
});
check('etc. at the end keeps the sentence end', () => assert.deepEqual(sentencesOf(forSpeech('Buy milk, eggs, etc. Then rest.')), ['Buy milk, eggs, and so on.', 'Then rest.']));
check('nothing to say', () => assert.deepEqual(speechChunks('```js\nx()\n``` 🙂'), []));
check('money with a size word', () => {
  assert.equal(forSpeech('It is $5k, ₹1.5 lakh and $2.5 billion.'), 'It is 5 thousand dollars, 1.5 lakh rupees and 2.5 billion dollars.');
  assert.equal(forSpeech('Rs 200 or ₹3cr.'), '200 rupees or 3 crore rupees.');
});
check('VS Code stays', () => assert.equal(forSpeech('Open VS Code, not this vs that.'), 'Open VS Code, not this versus that.'));
check('a list of numbers stays a list', () => assert.equal(forSpeech('Pick 1,2,3 or 4. Pay 12,345,678.'), 'Pick 1,2,3 or 4. Pay 12345678.'));
check('a.m. at the end of a sentence keeps the stop', () => {
  assert.deepEqual(sentencesOf(forSpeech('Meet at 9:30 a.m. Then go.')), ['Meet at 9:30 AM.', 'Then go.']);
  assert.equal(forSpeech('At 5 p.m., call. Up at 6am, gym at 7:00 pm'), 'At 5 PM, call. Up at 6 AM, gym at 7 PM.');
  assert.equal(forSpeech('2 amps and 3 apples.'), '2 amps and 3 apples.');
});
check('and/or', () => assert.equal(forSpeech('Tea and/or coffee.'), 'Tea and or coffee.'));
check('their own pronunciations, whole words in any case', () => {
  const sayAs = { Rajesh: 'Raa-jesh', 'Arogya 360': 'Aa-rogya three sixty', Ravi: '' };
  assert.equal(forSpeech("Call RAJESH and rajeshwari. Ravi's at Arogya  360.", sayAs), "Call Raa-jesh and rajeshwari. Ravi's at Aa-rogya three sixty.");
  assert.deepEqual(speechChunks('Hi Rajesh.', { sayAs }), ['Hi Raa-jesh.']);
  assert.equal(forSpeech('Odd (a+b) word.', { 'a+b': 'a plus b' }), 'Odd, a plus b, word.');
});
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
