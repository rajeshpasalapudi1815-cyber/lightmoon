// Learning how the user speaks: words the speech recogniser keeps getting wrong for them ("pulav" for "pull up"),
// learnt when they fix a spoken message, and fixed by themselves the next time; and noticing when they say nearly
// the same thing again, because the last answer missed. Plain functions, so they can be tested (tests/hearing.test.mjs).

const MAX_SPAN_WORDS = 3; // a fix is a few words swapped, not a rewritten message
const MAX_FIXES = 80;
// Little words: swapping these is rewording, not a mishearing, and fixing them everywhere would do harm.
const LITTLE = new Set('a an the to of in on at for and or but is it i me my you your we be do so if up off no not this that'.split(' '));

const words = text => String(text ?? '').trim().split(/\s+/).filter(Boolean);
const bare = word => word.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');

function distance(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}
const likeness = (a, b) => (a || b ? 1 - distance(a, b) / Math.max(a.length, b.length) : 1);

// Roughly how it sounds: consonants by kind (k/g, p/b/f/v, t/d...), vowels dropped. "kept in" and "Gifty" come close.
const SOUND_KINDS = { k: 'k', g: 'k', c: 'k', q: 'k', x: 'k', j: 'j', p: 'p', b: 'p', f: 'p', v: 'p', t: 't', d: 't', s: 's', z: 's', m: 'n', n: 'n', l: 'l', r: 'l' };
const sound = text => [...text.toLowerCase()].map(ch => SOUND_KINDS[ch] ?? '').join('').replace(/(.)\1+/g, '$1');

// Whether two phrases sound alike enough to be one misheard as the other.
export function soundsAlike(heard, meant) {
  const a = heard.toLowerCase().replace(/[^a-z]/g, '');
  const b = meant.toLowerCase().replace(/[^a-z]/g, '');
  if (!a || !b) return false; // other scripts: not judged, not learnt
  return Math.max(likeness(a, b), likeness(sound(a), sound(b))) >= 0.5;
}

// The user fixed a spoken message: what was heard → what they meant, when the fix is a few words that sound like the
// ones they replace. Otherwise null: they reworded it or changed their mind, which isn't a mishearing.
export function learnedFix(heardText, fixedText) {
  const heard = words(heardText);
  const fixed = words(fixedText);
  let start = 0;
  while (start < heard.length && start < fixed.length && bare(heard[start]) === bare(fixed[start])) start++;
  let end = 0;
  while (end < heard.length - start && end < fixed.length - start && bare(heard.at(-1 - end)) === bare(fixed.at(-1 - end))) end++;
  const was = heard.slice(start, heard.length - end).map(bare).filter(Boolean);
  const now = fixed.slice(start, fixed.length - end).map(word => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}']+$/gu, '')).filter(Boolean);
  if (!was.length || !now.length || was.length > MAX_SPAN_WORDS || now.length > MAX_SPAN_WORDS + 1) return null;
  if (was.every(word => LITTLE.has(word))) return null;
  if (heard.length - was.length < 1 && heard.length > 1) return null; // the whole message changed
  const fix = { heard: was.join(' '), meant: now.join(' ') };
  if (fix.heard === fix.meant.toLowerCase() || !soundsAlike(fix.heard, fix.meant)) return null;
  return fix;
}

const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Puts the learnt fixes into something just heard: `fixes` is { heard: meant }. Whole words only.
// -> { text, used: [{ heard, meant }] }
export function applyFixes(text, fixes) {
  let out = String(text ?? '');
  const used = [];
  // Longer phrases first, so "kept in" goes before a fix for "kept".
  for (const [heard, meant] of Object.entries(fixes ?? {}).sort(([a], [b]) => b.length - a.length)) {
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${heard.split(' ').map(escape).join('\\s+')}(?![\\p{L}\\p{N}])`, 'giu');
    if (!pattern.test(out)) continue;
    out = out.replace(pattern, meant);
    used.push({ heard, meant });
  }
  return { text: out, used };
}

// Adds a fix to the saved ones (newest kept when there are too many).
export function withFix(fixes, { heard, meant }) {
  const next = { ...fixes };
  delete next[heard];
  next[heard] = meant;
  const keys = Object.keys(next);
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_FIXES))) delete next[key];
  return next;
}

const REPEAT_WITHIN_MS = 3 * 60_000;

// Whether the user just said nearly the same thing again (within a few minutes), so the last answer missed.
export function saidAgain(latest, before, gapMs) {
  if (!(gapMs >= 0 && gapMs <= REPEAT_WITHIN_MS)) return false;
  const set = text => new Set(words(text).map(bare).filter(word => word && !LITTLE.has(word)));
  const a = set(latest);
  const b = set(before);
  if (a.size < 2 || b.size < 2) return false; // "yes" twice is just two yeses
  const shared = [...a].filter(word => b.has(word)).length;
  return shared / Math.max(a.size, b.size) >= 0.6;
}
