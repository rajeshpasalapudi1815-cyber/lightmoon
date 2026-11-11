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
// Listening is in the practice language, so a spoken "stop practice" arrives as "स्टॉप प्रैक्टिस": both count.
const STOP = new RegExp([
  String.raw`\b(?:stop|end|finish|quit|pause|exit|cancel)\b[^.?!]{0,25}\b(?:practi[cs]e|practi[cs]ing|lesson|class|training|tutor|${LANGUAGE_WORDS})`,
  String.raw`\b(?:that'?s|thats) (?:all|enough)(?: for (?:today|now))?\b`,
  String.raw`\b(?:back to|switch to|change to|speak in|talk in|talk to me in|reply in) english\b`,
  String.raw`\bno more (?:practi[cs]e|lessons?|${LANGUAGE_WORDS})`,
  'बस (?:करो|करते हैं)', 'अब बस', 'बंद करो', 'ख़?त्म करो',
  '(?:स्टॉप|स्टाप|एंड|फिनिश|क्विट|एग्जिट|बंद)[^.?!]{0,25}(?:प्रैक्टिस|प्रेक्टिस|प्रैक्टिसिंग|लेसन|क्लास|हिंदी|ट्रेनिंग)',
  '(?:बैक टू|स्विच टू|स्पीक इन|टॉक इन) इंग्लिश', 'इंग्लिश में (?:बात|बोलो|बोलिए)',
  'दैट्स (?:ऑल|इनफ)',
].join('|'), 'i');

// The language a message asks to practise ('hi'), or null.
export function practiceWanted(text) {
  const match = START.exec(String(text ?? ''));
  if (!match) return null;
  const word = (match[1] ?? match[2] ?? match[3] ?? '').toLowerCase();
  return NAMES[word] ?? null;
}
export const practiceEnds = text => STOP.test(String(text ?? ''));

// { lang, since, last }, kept as a (synced) setting, so a practice started on the phone carries on at the laptop.
// Nobody practised for PRACTICE_IDLE_MS: it is over by itself, so LightMoon is back to their own language (a
// practice left on used to keep it listening in Hindi for days).
export const PRACTICE_IDLE_MS = 20 * 60_000;
export function practice(now = Date.now()) {
  try {
    const going = JSON.parse(settings.get('practice') || 'null');
    if (!going || !PRACTICE_LANGUAGES[going.lang]) return null;
    if (now - (going.last ?? going.since ?? 0) > PRACTICE_IDLE_MS) {
      settings.set('practice', '');
      return null;
    }
    return going;
  } catch {
    return null;
  }
}
export function startPractice(lang) {
  const going = { lang, since: Date.now(), last: Date.now() };
  settings.set('practice', JSON.stringify(going));
  return going;
}
// A practice turn: it stays on for another PRACTICE_IDLE_MS.
export function practised(going) {
  const kept = { ...going, last: Date.now() };
  settings.set('practice', JSON.stringify(kept));
  return kept;
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

// ---------- Is this English? ----------
// While practising, listening is in the practice language, so English they speak to LightMoon ("how to say it's a
// good product") arrives in that language's letters: "हाउ टू से दैट इट इज़ अ गुड प्रोडक्ट". Those are questions and
// instructions for the tutor, never practice to correct. Hindi with a few English words in it ("प्रोडक्ट अच्छा है")
// is practice. Typed English in English letters counts too; Hindi typed in English letters ("aap kaise ho") doesn't.
const ENGLISH_IN_DEVANAGARI = new Set(`हाउ व्हाट वाट व्हॉट व्हेन वेन व्हेयर वेयर व्हाई वाय व्हिच हू टू टु द दी एन इज आर एम आई यू यु मी माय वी दे देयर दैट दिस इट इट्स
  कैन कैन्ट कुड वुड शुड विल डू डोंट डज डिड नॉट नोट यस से सेइंग सेड सेज टेल एक्सप्लेन एक्सप्लेनेशन इंग्लिश लैंग्वेज प्लीज करेक्ट करेक्टिंग करेक्शन
  मिस्टेक मिस्टेक्स रॉन्ग रोंग राइट मीन मीनिंग मीन्स वर्ड वर्ड्स सेंटेंस स्लो स्लोली स्लोअर ईजी इजी ईजियर अगेन रिपीट अंडरस्टैंड अंडरस्टूड गुड बैड
  प्रोडक्ट लाइक वांट नीड नो थैंक थैंक्स थैंक्यू सो बट एंड ऑर विद फॉर ऑफ ऑन एट अबाउट ट्रांसलेट हेल्प स्पीक स्पीकिंग टॉक लर्न टीच लेसन
  क्वेश्चन आंसर ओके ओकाय वेरी मच मोर लेस हाउस सिंपल सिंपलर इन्स्टेड यूज यूजिंग गिव गिव्स एग्जांपल एक्जांपल शो मेक इंस्टेड बिफोर आफ्टर`
  .split(/\s+/).filter(Boolean));
const ENGLISH_STARTS = /^(?:हाउ (?:टू|टु|डू|कैन|शुड|आई|डज|इज|आर)|व्हाट (?:इज|इज़|डज|डू|आर)|वाट (?:इज|डज)|कैन यू|प्लीज|एक्सप्लेन|टेल मी)/;
const ENGLISH_WORDS_LATIN = /\b(?:the|is|are|to|how|what|why|when|where|which|i|you|me|my|it|this|that|do|does|can|please|explain|say|mean|meaning|word|in|of|and|correct|wrong|english)\b/gi;

export function spokenEnglish(text) {
  const said = String(text ?? '').normalize('NFC').replace(/\u093C/g, '').trim(); // nukta off: इज़ = इज
  if (!said) return false;
  const latin = (said.match(/[a-z]/gi) ?? []).length;
  const indic = (said.match(/[\u0900-\u0DFF]/g) ?? []).length;
  if (latin > indic * 2) {
    const words = said.split(/\s+/).length;
    return (said.match(ENGLISH_WORDS_LATIN) ?? []).length >= Math.max(1, Math.ceil(words * 0.3));
  }
  if (ENGLISH_STARTS.test(said)) return true;
  const tokens = said.split(/[\s,.?!।]+/).filter(Boolean);
  const english = tokens.filter(token => ENGLISH_IN_DEVANAGARI.has(token)).length;
  return tokens.length > 0 && english >= 2 && english / tokens.length >= 0.5;
}

// The note added to a practice turn whose message was English.
export const englishNote = (text, lang) => `Their last message ("${String(text).slice(0, 200)}") is English, `
  + `${/[a-z]/i.test(text) ? '' : `written in ${PRACTICE_LANGUAGES[lang].name} letters by the speech recogniser, `}`
  + `so it is a question or instruction for you, not ${PRACTICE_LANGUAGES[lang].name} practice. Do NOT correct it or start with "Correction". `
  + `Work out what they asked by how it sounds, answer it in English (give any ${PRACTICE_LANGUAGES[lang].name} they asked for, with how to say it in ⟨ ⟩), `
  + `ask them to say it back, and follow any instruction for the rest of the practice.`;
