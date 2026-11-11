// Ask first: LightMoon never just starts talking about a reminder. Like a good assistant at the door, it asks
// "Boss, are you free now? I have a reminder for you." and waits. "Yes" / "tell me": it says it. "Not now" /
// "later" / "in 20 minutes": it asks again then. No answer: it asks again in a few minutes, and after a few tries
// leaves it written in the conversation and a notification, quietly. Nothing is asked during a call (app.js
// busyWith) or while asleep (sleep.js). Settings → Voice → "Ask if I'm free before reminders" switches it off.
// tests/askfirst.test.mjs checks it.

export const NO_ANSWER_RETRY_MS = 5 * 60_000; // not heard: ask again after this
export const MAX_UNANSWERED = 3; // asked this many times with no answer: leave it written down, quietly
export const DEFAULT_LATER_MIN = 10; // "later" with no time in it
export const ANSWER_WINDOW_MS = 3 * 60_000; // an answer this long after the question still counts

const count = n => ['', 'one', 'two', 'three', 'four', 'five'][n] ?? String(n);
const capitalize = text => text.charAt(0).toUpperCase() + text.slice(1);

// What waits: [{ kind: 'reminder' | 'check-in' | 'heads-up' | 'meeting' | 'message', urgent }].
// -> "Boss, are you free now? I have a reminder for you."
export function askLine(items, { address = 'sir', afterCall = false } = {}) {
  const who = capitalize(address);
  const n = items.length;
  const kinds = new Set(items.map(item => item.kind));
  let what;
  if (n === 1) {
    what = {
      'check-in': 'I want to check in with you about something.',
      'heads-up': 'Something is coming up soon.',
      meeting: 'A meeting is about to start.',
      message: 'A message came in for you.',
    }[items[0].kind] ?? 'I have a reminder for you.';
  } else {
    what = kinds.size === 1 && kinds.has('reminder') ? `I have ${count(n)} reminders for you.` : `I have ${count(n)} things for you.`;
  }
  const urgent = items.some(item => item.urgent) ? ' It\'s urgent.' : '';
  const opener = afterCall ? `${who}, your call is over. Are you free now?` : `${who}, are you free now?`;
  return `${opener} ${what}${urgent}`;
}

// Their answer to "are you free?": 'yes', { later: minutes }, or null (they said something else: a request of
// their own, which is answered as usual, and the question waits).
const LATER = /\b(?:not now|later|busy|in a (?:meeting|call)|on (?:a|the) call|driving|wait|hold on|give me|after(?:wards)?|remind me (?:in|after|later)|ask (?:me )?(?:again )?(?:in|after|later)|in (?:\d+|an?|one|two|five|ten|fifteen|twenty|thirty) ?(?:min(?:ute)?s?|hours?|hrs?)|not free|i'?m not free|can'?t (?:talk|now)|baad me[ni]?|abhi nahi|abhi nahin|ruko|tarvata|ippudu kadu|taruvata)\b|^(?:no|nope|nah|not really)\b|नहीं|बाद में|अभी नहीं|रुको|नॉट नाउ|लेटर|बिजी|वेट/i;
const YES = /^(?:yes|yeah|yep|yup|ya|yah|sure|ok(?:ay)?|go ahead|go on|tell me|tell|say it|i'?m free|i am free|free|please|carry on|shoot|haan(?: ji)?|ha|ji|bolo|batao|cheppu|chepu|avunu|sare|sari|cheppandi)\b|^(?:हाँ|हां|बोलो|बताओ|जी|यस|येस|ओके|ओकाय|श्योर|टेल मी|गो अहेड)|^(?:what|what is it|what is that|what's up|whats up|what happened|what's that)[\s?.!]*$/i;
const NUMBER_WORDS = { a: 1, an: 1, one: 1, two: 2, five: 5, ten: 10, fifteen: 15, twenty: 20, thirty: 30, forty: 40, 'forty five': 45, sixty: 60 };

export function laterMinutes(text) {
  const said = String(text ?? '').toLowerCase();
  if (/\bhalf (?:an )?hour\b/.test(said)) return 30;
  if (/\bquarter of an hour\b/.test(said)) return 15;
  const match = /\b(\d{1,3}|an?|one|two|five|ten|fifteen|twenty|thirty|forty(?: five)?|sixty)\s*(min(?:ute)?s?|hours?|hrs?)\b/.exec(said);
  if (!match) return DEFAULT_LATER_MIN;
  const number = /^\d/.test(match[1]) ? Number(match[1]) : NUMBER_WORDS[match[1]];
  const minutes = /^h/.test(match[2]) ? number * 60 : number;
  return Math.min(Math.max(minutes, 1), 12 * 60);
}

export function consentAnswer(text) {
  const said = String(text ?? '').trim().replace(/^(?:hey |ok |okay )?(?:light ?moon|sunshine)[, ]*/i, '');
  if (!said) return null;
  if (/^no,? (?:tell|go ahead|go on|say it|it'?s fine|problem)/i.test(said)) return 'yes'; // "no, tell me", "no problem"
  if (LATER.test(said)) return { later: laterMinutes(said) };
  if (YES.test(said) && said.split(/\s+/).length <= 8) return 'yes';
  return null;
}
