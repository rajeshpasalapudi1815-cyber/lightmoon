// "WhatsApp wife akkada unnav bangaram", "text Ravi I'm on my way", "message Mom": sent without the AI, so nothing is
// rephrased or talked over. The words go exactly as they said them (Telugu letters turned into English ones, as they'd
// type them); tools.js finds who it's for, reads it back and sends on their yes. tests/quicksend.test.mjs checks it.

// -> { via: 'whatsapp' | 'sms', rest } for an order to message someone, else null.
// Also as Telugu speech recognition writes it, once in English letters ("వాట్సాప్" -> "vatsap").
const ORDER = /^\W*(?:(?:please|can you|could you|pls)\s+)*(?:send\s+(?:a\s+)?)?(whats\s?app|wh?atsapp?|vaa?tsaa?p|sms|text|message|msg|mesej)\s+(?:to\s+)?(.+?)\W*$/i;
export function parseSend(text) {
  const said = String(text ?? '').trim();
  const match = ORDER.exec(hasTelugu(said) ? teluguToLatin(said) : said);
  if (!match) return null;
  const rest = match[2].trim();
  // "message from Asha", "text me back": not an order to write to someone.
  if (/^(from|me|back|him|her|them|it|this|that)\b/i.test(rest)) return null;
  return { via: /^sms$/i.test(match[1]) ? 'sms' : 'whatsapp', rest };
}

// Splits "wife akkada unnav bangaram" into who and what, trying the longest name first (up to four words).
// isPerson(name) -> Promise<boolean>. -> { to, text } (text may be ''), or null when no name fits.
export async function splitNameAndText(rest, isPerson) {
  const words = String(rest).split(/\s+/).filter(Boolean);
  for (let n = Math.min(4, words.length); n >= 1; n--) {
    const to = words.slice(0, n).join(' ');
    if (await isPerson(to)) {
      const text = words.slice(n).join(' ').replace(/^(that|saying|say|ki|ku|ni|ke|ko)\s+/i, '').trim();
      return { to, text };
    }
  }
  return null;
}

// ---------- Telugu letters to English ones ("అక్కడ ఉన్నావ్" -> "akkada unnav") ----------
// Speech recognition in Telugu writes Telugu letters, but they text in English letters.

const VOWELS = { 'అ': 'a', 'ఆ': 'aa', 'ఇ': 'i', 'ఈ': 'ee', 'ఉ': 'u', 'ఊ': 'oo', 'ఋ': 'ru', 'ఎ': 'e', 'ఏ': 'e', 'ఐ': 'ai', 'ఒ': 'o', 'ఓ': 'o', 'ఔ': 'au' };
const SIGNS = { 'ా': 'a', 'ి': 'i', 'ీ': 'ee', 'ు': 'u', 'ూ': 'oo', 'ృ': 'ru', 'ె': 'e', 'ే': 'e', 'ై': 'ai', 'ొ': 'o', 'ో': 'o', 'ౌ': 'au' };
const CONSONANTS = {
  'క': 'k', 'ఖ': 'kh', 'గ': 'g', 'ఘ': 'gh', 'ఙ': 'n', 'చ': 'ch', 'ఛ': 'chh', 'జ': 'j', 'ఝ': 'jh', 'ఞ': 'n',
  'ట': 't', 'ఠ': 'th', 'డ': 'd', 'ఢ': 'dh', 'ణ': 'n', 'త': 't', 'థ': 'th', 'ద': 'd', 'ధ': 'dh', 'న': 'n',
  'ప': 'p', 'ఫ': 'ph', 'బ': 'b', 'భ': 'bh', 'మ': 'm', 'య': 'y', 'ర': 'r', 'ఱ': 'r', 'ల': 'l', 'ళ': 'l', 'వ': 'v',
  'శ': 'sh', 'ష': 'sh', 'స': 's', 'హ': 'h',
};
const VIRAMA = '్';
const ANUSVARA = 'ం';
const VISARGA = 'ః';

export function teluguToLatin(text) {
  const chars = [...String(text ?? '')];
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    const next = chars[i + 1];
    if (CONSONANTS[c]) {
      out += CONSONANTS[c];
      if (next === VIRAMA) i++; // no vowel: "క్క" -> "kk"
      else if (SIGNS[next]) {
        out += SIGNS[next];
        i++;
      } else {
        // The vowel every letter carries unless marked.
        out += 'a';
      }
    } else if (VOWELS[c]) out += VOWELS[c];
    else if (c === ANUSVARA) out += CONSONANTS[next] && !/^[pbm]/.test(CONSONANTS[next]) ? 'n' : 'm'; // "బంగారం" -> "bangaram"
    else if (c === VISARGA) out += 'h';
    else if (SIGNS[c] || c === VIRAMA) continue; // stray sign
    else out += c;
  }
  return out;
}

export const hasTelugu = text => /[ఀ-౿]/.test(String(text ?? ''));
