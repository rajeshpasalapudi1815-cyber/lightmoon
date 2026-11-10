// Language practice: "teach me Hindi" starts a real conversation in that language, not a plan or a checklist.
// LightMoon talks with them in simple everyday sentences, corrects what they said wrong (the right sentence, and
// why, in a line of English), and keeps them talking. Requests are small (a short prompt, no tools, the last few
// turns), so a long practice stays inside the free tier's limits. "Stop practice" ends it.
// tests/practice.test.mjs checks it.
import { settings } from './store.js';

export const PRACTICE_LANGUAGES = {
  hi: { name: 'Hindi', script: 'Devanagari', listen: 'hi-IN' },
  te: { name: 'Telugu', script: 'Telugu script', listen: 'te-IN' },
  ta: { name: 'Tamil', script: 'Tamil script', listen: 'ta-IN' },
  kn: { name: 'Kannada', script: 'Kannada script', listen: 'kn-IN' },
  ml: { name: 'Malayalam', script: 'Malayalam script', listen: 'ml-IN' },
  mr: { name: 'Marathi', script: 'Devanagari', listen: 'mr-IN' },
  bn: { name: 'Bengali', script: 'Bengali script', listen: 'bn-IN' },
  gu: { name: 'Gujarati', script: 'Gujarati script', listen: 'gu-IN' },
  es: { name: 'Spanish', script: 'Latin letters', listen: 'es-ES' },
  fr: { name: 'French', script: 'Latin letters', listen: 'fr-FR' },
  de: { name: 'German', script: 'Latin letters', listen: 'de-DE' },
};
const NAMES = Object.fromEntries(Object.entries(PRACTICE_LANGUAGES).map(([code, lang]) => [lang.name.toLowerCase(), code]));
const LANGUAGE_WORDS = Object.keys(NAMES).join('|');

const HISTORY_TURNS = 12; // messages of the practice the AI sees: enough to follow the talk, small enough for the free tier

// "teach me Hindi", "I want to learn Hindi", "let's practise Hindi", "train me in Hindi", "talk to me in Hindi so I
// can learn", "Hindi lesson". Not "speak in Hindi" on its own: that switches LightMoon's language (set_language).
const START = new RegExp(
  `\\b(?:teach(?:ing)?|learn(?:ing)?|practi[cs](?:e|ing)|train(?:ing)?|tutor|coach|improve)\\b[^.?!]{0,40}?\\b(${LANGUAGE_WORDS})\\b`
  + `|\\b(${LANGUAGE_WORDS})\\b[^.?!]{0,25}?\\b(?:lessons?|class(?:es)?|practi[cs]e|tutor(?:ing)?|conversation practice)\\b`
  + `|\\b(?:talk|speak|chat|converse)\\b[^.?!]{0,25}?\\b(${LANGUAGE_WORDS})\\b[^.?!]{0,40}?\\b(?:learn|practi[cs]e|improve|correct)`,
  'i');
const STOP = /\b(?:stop|end|finish|quit|pause|exit)\b[^.?!]{0,25}\b(?:practi[cs]e|practi[cs]ing|lesson|class|training|tutor)|\b(?:that'?s|thats) (?:all|enough)(?: for (?:today|now))?\b|\bback to english\b|\bno more (?:practi[cs]e|hindi|lesson)|बस (?:करो|करते हैं)|अब बस/i;

// The language a message asks to practise ('hi'), or null.
export function practiceWanted(text) {
  const match = START.exec(String(text ?? ''));
  if (!match) return null;
  const word = (match[1] ?? match[2] ?? match[3] ?? '').toLowerCase();
  return NAMES[word] ?? null;
}
export const practiceEnds = text => STOP.test(String(text ?? ''));

// { lang, since }, kept as a (synced) setting, so a practice started on the phone carries on at the laptop.
export function practice() {
  try {
    const now = JSON.parse(settings.get('practice') || 'null');
    return now && PRACTICE_LANGUAGES[now.lang] ? now : null;
  } catch {
    return null;
  }
}
export function startPractice(lang) {
  const going = { lang, since: Date.now() };
  settings.set('practice', JSON.stringify(going));
  return going;
}
export function endPractice() {
  settings.set('practice', '');
}
// What to listen in while practising ('hi-IN'), or null.
export const practiceListening = () => (practice() ? PRACTICE_LANGUAGES[practice().lang].listen : null);

// The tutor's instructions: short, so each turn costs little.
export function practicePrompt({ lang, name = '', firstTurn = false }) {
  const { name: language, script } = PRACTICE_LANGUAGES[lang];
  const local = script !== 'Latin letters';
  return [
    `You are LightMoon, ${name ? `${name}'s` : 'their'} friendly ${language} conversation partner and tutor. They speak English and Telugu and are learning ${language}. `
      + 'This is a free, spoken conversation, so they learn by talking. Never make plans, schedules, checklists or reminders, and never suggest apps or podcasts: you ARE the practice.',
    'Every reply, in this order:',
    `1. Their last ${language} message: if it had a mistake (grammar, gender, verb ending, word order, a wrong word, or English where a simple ${language} word exists), `
      + `start with "Correction:", then "You said" and their words, then "Say" and the right sentence in ${language}, then "Because" and the reason IN ENGLISH, `
      + `naming the wrong word and the right one (Because "कैसा" is for one person you know well; with "आप" use "कैसे"). `
      + `Every explanation is in English, never in ${language}. At most two corrections; the biggest first. If it was right, say so in a word.`,
    `2. Then carry on the conversation in simple, natural, everyday spoken ${language}: one to three short sentences, ending with a question that keeps them talking.`,
    local
      ? `Write ${language} in ${script} (the voice reads only that), and after each ${language} sentence put how to say it in English letters inside ⟨ ⟩, `
        + 'like: आप कैसे हैं? ⟨aap kaise hain?⟩ . The ⟨ ⟩ part is shown, not spoken.'
      : '',
    `3. A word they likely don't know: its English meaning in brackets the first time.`,
    `Their words come through ${language} speech recognition, so English they speak often arrives written in ${script}`
      + (local ? ` letters (व्हेन यू आर करेक्टिंग मी is "when you are correcting me"). Read it by sound.` : '.'),
    `When they talk to you in English (an instruction about the lesson like "explain in English", "slower", "easier", a question, or "I don't understand"), `
      + `that is not practice: never correct it or turn it into ${language}. Do what they ask, answering in English, keep doing it for the rest of the practice, then carry on.`,
    'Talk about everyday things: their day, food, family, work, plans, places, films. Start easy; when they do well, make it a little harder. '
      + 'No markdown, lists or symbols: this is spoken aloud. Keep it short.',
    firstTurn ? `This is the start: greet them in ${language}, say in one English sentence that you'll chat and correct them as you go, and ask an easy first question.` : '',
  ].filter(Boolean).join('\n');
}

// The conversation since the practice began, cut to the last few turns.
export function practiceHistory(all, since) {
  return all.filter(m => (m.role === 'user' || m.role === 'assistant') && (m.at ?? 0) >= since - 1000)
    .slice(-HISTORY_TURNS)
    .map(({ role, content }) => ({ role, content }));
}
