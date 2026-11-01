// The language LightMoon talks in: English unless they ask for Telugu, Hindi or Tamil ("speak in Telugu"), on every
// device (a synced setting). Then replies are written in that language's own letters, which its own voice reads
// (app.js picks the voice by the letters, voices.js scriptOf), and listening is in that language too, so Telugu
// isn't heard as Hindi by the Indian English recogniser. tests/language.test.mjs checks it.

export const TALK_LANGUAGES = {
  en: { name: 'English' },
  te: { name: 'Telugu', script: 'Telugu script (తెలుగు)', how: 'the everyday Telugu people speak in Hyderabad and Andhra' },
  hi: { name: 'Hindi', script: 'Devanagari (हिंदी)', how: 'everyday spoken Hindi' },
  ta: { name: 'Tamil', script: 'Tamil script (தமிழ்)', how: 'everyday spoken Tamil' },
};

// 'te' for "telugu", "Telugu", "te", "te-IN", "తెలుగు"; null if it isn't one.
export function languageCode(said) {
  const word = String(said ?? '').trim().toLowerCase();
  if (/^(en|eng|english)\b|^en-/.test(word)) return 'en';
  if (/^(te|tel|telugu)\b|^te-|తెలుగు/.test(word)) return 'te';
  if (/^(hi|hin|hindi)\b|^hi-|हिंदी|हिन्दी/.test(word)) return 'hi';
  if (/^(ta|tam|tamil)\b|^ta-|தமிழ்/.test(word)) return 'ta';
  return null;
}

// What to listen in: the language they talk in, else the device's own choice (Settings → Voice).
export const listeningLanguage = (talk, deviceLang) => (talk && talk !== 'en' ? `${talk}-IN` : deviceLang);

// For the system prompt (prompt.js).
export function languageRule(talk) {
  const lang = TALK_LANGUAGES[talk];
  if (!lang?.script) return '- Language: English. If they ask you to talk in Telugu, Hindi or Tamil (or English again), call set_language.';
  return `- LANGUAGE: they asked you to speak ${lang.name}. Write every reply in ${lang.name}, in ${lang.script}: ${lang.how}, simple and natural, `
    + `not bookish. Keep common English words they'd use (meeting, task, phone, office, names) in English letters. Your voice can read only `
    + `${lang.name} letters, so never write ${lang.name} in English letters in a reply. Their words arrive through ${lang.name} speech recognition, `
    + 'often mixed with English. Tool fields (task titles, notes) in the language they used. To switch back, set_language.'
    + (talk === 'te' ? ' Messages they send to people are different: write those in Tenglish, Telugu in English letters as they\'d type it '
      + '("Akkada unnav bangaram?"), turning Telugu letters into English ones, unless they ask for Telugu letters.' : '');
}

// Yes in Indian scripts ("అవును", "సరే", "हाँ"), at the start of a message; JavaScript's \b doesn't work for these letters.
const NATIVE_YES_WORDS = 'అవును|సరే|ఓకే|అలాగే|హా|చేయి|చెయ్యి|पक्का|हाँ|हां|हा|ठीक है|जी|ஆமா|ஆம்|சரி';
export const NATIVE_YES = new RegExp(`^[\\s\\p{P}]*(?:${NATIVE_YES_WORDS})(?![\\p{L}\\p{M}])`, 'u');
const SEND_WORDS = 'పంపు|పంపించు|పంపండి|పంపేయి|भेज दो|भेजो|அனுப்பு';
const MORE = '(?:\\s*(?:చేయి|చెయ్యి|చేయండి|it|now|please))*';
// The whole message is only a yes (and maybe "send"), in those letters.
export const NATIVE_YES_ONLY = new RegExp(`^[\\s\\p{P}]*(?:(?:${NATIVE_YES_WORDS}|ok|okay|yes)[\\s\\p{P}]*)+(?:(?:${SEND_WORDS}|send)${MORE})?[\\s\\p{P}]*$`, 'iu');
// The whole message is a plain "send it": "పంపు", "సరే పంపించు".
export const NATIVE_SEND_NOW = new RegExp(`^[\\s\\p{P}]*(?:(?:${NATIVE_YES_WORDS}|ok|yes)[\\s\\p{P}]+)*(?:${SEND_WORDS})${MORE}[\\s\\p{P}]*$`, 'iu');

// Either pattern, as one with .test (for the yes and send checks that take a pattern).
export const either = (...patterns) => ({ test: text => patterns.some(p => p.test(String(text ?? ''))) });
