// Turns LightMoon's written replies into smooth speech: what to say (no markdown, emoji, links or bare symbols)
// and where to break it. Pieces are whole sentences, never cut inside "1.7", "e.g." or "Dr.", and joined into
// phrases long enough for natural intonation but short enough that no voice cuts them off.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const CHUNK_CHARS = 220;

// Words before a full stop that don't end a sentence (lower case, without the stop).
const NOT_AN_END = new Set(['mr', 'mrs', 'ms', 'dr', 'st', 'prof', 'sr', 'jr', 'vs', 'no', 'approx', 'e.g', 'i.e', 'eg', 'ie', 'a.m', 'p.m', 'etc']);

const clock = (hour, minute) => {
  const h = Number(hour);
  const suffix = h < 12 ? 'AM' : 'PM';
  return `${h % 12 || 12}${minute === '00' ? '' : `:${minute}`} ${suffix}`;
};

// "2026-10-30" → "30 October" (with the year only when it isn't this year), plus "at 2:05 PM" for a time.
function spokenDate(_, year, month, day, hour, minute) {
  const name = MONTHS[Number(month) - 1];
  if (!name) return _;
  const thisYear = String(new Date().getFullYear());
  const date = `${Number(day)} ${name}${year === thisYear ? '' : ` ${year}`}`;
  return hour ? `${date} at ${clock(hour, minute)}` : date;
}

// "5 p.m." and "9:30am" → "5 PM" and "9:30 AM", keeping a full stop that also ends the sentence.
function clockWords(match, hour, minute, ap, offset, all) {
  const rest = all.slice(offset + match.length);
  const endsSentence = match.endsWith('.') && /^(\s+["'“‘(]*[A-Z]|\s*$)/.test(rest);
  return `${hour}${minute && minute !== '00' ? `:${minute}` : ''} ${ap.toUpperCase()}M${endsSentence ? '.' : ''}`;
}

// An amount, and what it's counted in: "5k", "2.5 billion", "1.5 lakh".
const AMOUNT = String.raw`(\d+(?:\.\d+)?)(?:(k|m|mn|bn|b|cr)\b|\s(lakhs?|crores?|thousand|million|billion)\b)?`;
const SCALES = { k: 'thousand', m: 'million', mn: 'million', b: 'billion', bn: 'billion', cr: 'crore' };
const money = unit => (_, amount, short, word) => {
  const scale = short ? SCALES[short.toLowerCase()] : word?.toLowerCase();
  return `${amount}${scale ? ` ${scale}` : ''} ${unit}`;
};

// Words the user taught LightMoon to say differently ({ Rajesh: 'Raa-jesh' }), whole words only, in any case.
function sayTheirWay(text, sayAs) {
  const words = Object.keys(sayAs ?? {}).filter(word => word.trim() && String(sayAs[word]).trim());
  if (!words.length) return text;
  const escape = word => word.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  const byLower = new Map(words.map(word => [word.trim().toLowerCase().replace(/\s+/g, ' '), String(sayAs[word]).trim()]));
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(?:${words.sort((a, b) => b.length - a.length).map(escape).join('|')})(?![\\p{L}\\p{N}])`, 'giu');
  return text.replace(pattern, match => byLower.get(match.toLowerCase().replace(/\s+/g, ' ')) ?? match);
}

// Markdown, emoji, links and symbols out; words in. Each line of a list becomes its own sentence. `sayAs`: the
// user's own pronunciations.
export function forSpeech(text, sayAs = {}) {
  const lines = sayTheirWay(String(text ?? ''), sayAs)
    // Emoji and the invisible characters that join or colour them.
    .replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}‍︎️⃣]/gu, '')
    .replace(/```[\s\S]*?```/g, '\n')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/(?:https?:\/\/|www\.)\S*[^\s.,;:!?)]/g, 'the link')
    .split(/\n+/);
  const sentences = lines
    .map(line => line
      .replace(/^\s*(?:[-*•+>]|#{1,6}|\d{1,2}[.)])\s+/, '')
      .replace(/[*_~#|]+/g, ' ')
      .trim())
    .filter(line => /[\p{L}\p{N}]/u.test(line))
    .map(line => (/[.!?:;,…]["'”’)\]]*$/.test(line) ? line : `${line}.`));
  return sentences.join(' ')
    // Dates and times the way they're said.
    .replace(/\b(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2})?)?\b/g, spokenDate)
    .replace(/\b(\d{1,2})(?::(\d{2}))?\s?([ap])\.?m\b\.?/gi, clockWords)
    // Abbreviations whose dots would otherwise end a sentence.
    .replace(/\be\.?g\.(?=[\s,]|$)/gi, 'for example')
    .replace(/\bi\.?e\.(?=[\s,]|$)/gi, 'that is')
    .replace(/\betc\.(?=\s+[A-Z]|\s*$)/g, 'and so on.')
    .replace(/\betc\./gi, 'and so on')
    .replace(/\bvs\.?(?=\s)/g, 'versus')
    .replace(/\bapprox\.?(?=\s)/gi, 'about')
    .replace(/\b(Mr|Mrs|Ms|Dr|St|Prof|Sr|Jr)\.(?=\s)/g, '$1')
    .replace(/\bNo\.\s*(?=\d)/g, 'number ')
    // Money, measures and symbols.
    .replace(/(\d),(?=(?:\d{2},)*\d{3}\b)/g, '$1') // 1,500 and 1,20,000 are numbers; 1,2,3 is a list
    .replace(new RegExp(String.raw`(?:₹|\bRs\.?|\bINR)\s?${AMOUNT}`, 'gi'), money('rupees'))
    .replace(new RegExp(String.raw`\$\s?${AMOUNT}`, 'gi'), money('dollars'))
    .replace(new RegExp(String.raw`£\s?${AMOUNT}`, 'gi'), money('pounds'))
    .replace(/(\d)\s?%/g, '$1 percent')
    .replace(/\s?°\s?C\b/g, ' degrees Celsius')
    .replace(/\s?°\s?F\b/g, ' degrees Fahrenheit')
    .replace(/\s?°/g, ' degrees')
    .replace(/(\d)\s?km\/h\b/gi, '$1 kilometres an hour')
    .replace(/(\d)\s?x\b/g, '$1 times')
    .replace(/(^|[^\d-])(\d{1,3})\s?[–-]\s?(\d{1,3})(?![\d-])/g, '$1$2 to $3')
    .replace(/\s*(?:->|→|=>)\s*/g, ' to ')
    .replace(/\band\/or\b/gi, 'and or')
    .replace(/\b([A-Za-z]{2,})\/([A-Za-z]{2,})\b/g, '$1 or $2')
    .replace(/\s*&\s*/g, ' and ')
    .replace(/\s?\+\s?(?=\d)/g, (match, offset, all) => (/\d$/.test(all.slice(0, offset).trim()) ? ' plus ' : match))
    // Brackets as pauses, and tidy punctuation.
    .replace(/\s*\(([^()]{1,120})\)/g, ', $1,')
    .replace(/[[\]{}<>]/g, ' ')
    .replace(/\.{3,}/g, '…')
    .replace(/\s+([,.!?;:…])/g, '$1')
    .replace(/,([.!?;:])/g, '$1')
    .replace(/([,;:])\1+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

// Where each sentence ends in already-cleaned text: after . ! ? or … (and any closing quote or bracket), then a
// space or the end. Not after an initial ("J. K. Rowling") or an abbreviation that is left in.
function sentenceEnds(text) {
  const ends = [];
  for (const match of text.matchAll(/[.!?…]+["'”’)\]]*(?=\s|$)/g)) {
    const before = text.slice(0, match.index).match(/(\S+)$/)?.[1] ?? '';
    if (match[0].startsWith('.') && (/^[A-Z]$/.test(before) || NOT_AN_END.has(before.toLowerCase()))) continue;
    ends.push(match.index + match[0].length);
  }
  return ends;
}

export function sentencesOf(text) {
  const sentences = [];
  let start = 0;
  for (const end of sentenceEnds(text)) {
    const sentence = text.slice(start, end).trim();
    if (sentence) sentences.push(sentence);
    start = end;
  }
  const rest = text.slice(start).trim();
  if (rest) sentences.push(rest);
  return sentences;
}

// A sentence too long to say in one go, split at the best pause before the limit: ; : , or a dash, else a space.
function splitLong(sentence, max) {
  const pieces = [];
  let rest = sentence;
  while (rest.length > max) {
    const head = rest.slice(0, max);
    let cut = Math.max(head.lastIndexOf('; '), head.lastIndexOf(': '), head.lastIndexOf(', '), head.lastIndexOf(' – '), head.lastIndexOf(' - '));
    if (cut < max / 3) cut = head.lastIndexOf(' ');
    if (cut <= 0) cut = max;
    pieces.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) pieces.push(rest);
  return pieces;
}

// What to hand the voice, in order: cleaned text in sentence-sized phrases of up to `max` characters.
export function speechChunks(text, { max = CHUNK_CHARS, sayAs = {} } = {}) {
  const chunks = [];
  for (const sentence of sentencesOf(forSpeech(text, sayAs))) {
    for (const piece of splitLong(sentence, max)) {
      const last = chunks.length - 1;
      if (last >= 0 && chunks[last].length + 1 + piece.length <= max) chunks[last] += ` ${piece}`;
      else chunks.push(piece);
    }
  }
  return chunks;
}

// For a reply still arriving: the index just past the last finished sentence (or line), or -1 if there is none
// yet. "e.g. ", "Dr. " and "1." in "1.7" aren't sentence ends, so speech never stops halfway through a thought.
export function lastSentenceEnd(text) {
  let end = -1;
  for (const match of text.matchAll(/[.!?…]+["'”’)\]*_]*\s+|\n+/g)) {
    if (match[0].startsWith('.')) {
      const before = text.slice(0, match.index).match(/(\S+)$/)?.[1] ?? '';
      if (/^[A-Z]$/.test(before) || NOT_AN_END.has(before.toLowerCase().replace(/^[^a-z]+/, '')) || /^\d{1,2}$/.test(before)) continue;
    }
    end = match.index + match[0].length;
  }
  return end;
}
