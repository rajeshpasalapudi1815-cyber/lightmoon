// Stands between the AI's stream and what LightMoon shows and says. Some models (gpt-oss especially) now and then
// spill their own thinking into the reply ("We need to respond to user? Probably wait.") and then fall into a loop
// ("Master, I'm standing by. Master, I'm here. Master, I'm ready...") that ran for minutes. The guard lets whole
// sentences through one at a time and stops the reply at the first sign of either, or when it grows far past what
// anyone wants to hear. tests/replyguard.test.mjs checks it.

export const MAX_REPLY_CHARS = 1800;
// The model talking to itself, not to them.
const THINKING = /^(?:we (?:need|should|must|have) to|we are done|we're done|need to (?:respond|answer|ask|reply)|the user\b|user (?:says|asked|wants|hasn't|has)\b|probably (?:wait|ask|respond)|already asked|let['’]?s (?:think|see|respond|answer|check)|i think we need to stop|now (?:we|i) (?:need|should)|(?:analysis|reasoning|final)\s*:)/i;
// "Master, I'm here." and "Master, I'm ready." count as the same idle line.
const IDLE = /^(?:\w+, )?(?:i['’]?m|i am) (?:here|ready|standing by|waiting|awaiting)|^(?:\w+, )?(?:what['’]?s next|what shall we|what would you like|let me know what you need|tell me what|please (?:tell|give|let) me)/i;
const key = sentence => sentence.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, '').replace(/\s+/g, ' ').trim();

// emit(text) receives what may be shown and said. push(delta) returns false once the reply should stop.
// end() lets the last unfinished sentence through (unless the guard has stopped) and returns everything let through.
export function replyGuard(emit = () => {}) {
  let pending = '';
  let out = '';
  let stopped = false;
  let idle = 0;
  const seen = new Map();

  const pass = sentence => {
    const text = sentence.trim();
    if (!text) return true;
    const k = key(text);
    if (THINKING.test(text)) return false;
    if (k && seen.has(k)) return false; // said already: from here on it is going round in circles
    if (IDLE.test(text) && ++idle > 1) return false; // one "I'm here" is plenty
    seen.set(k, true);
    const lead = /^\s*/.exec(sentence)[0];
    const piece = out ? (lead.includes('\n') ? lead : ' ') + text : text; // paragraph breaks kept
    if (out.length + piece.length > MAX_REPLY_CHARS) return false;
    out += piece;
    emit(piece);
    return true;
  };

  // A sentence ends at . ! ? … when what follows starts a new one (a space, or a capital letter glued on).
  const SENTENCE = /^([\s\S]*?[.!?…]+["'”’)]*)(?=\s|[\p{Lu}"“‘])/u;
  return {
    push(delta) {
      if (stopped) return false;
      pending += delta;
      for (let m = SENTENCE.exec(pending); m; m = SENTENCE.exec(pending)) {
        pending = pending.slice(m[1].length);
        if (!pass(m[1])) {
          stopped = true;
          return false;
        }
      }
      if (pending.length > MAX_REPLY_CHARS) { // one endless sentence
        stopped = true;
        return false;
      }
      return true;
    },
    end() {
      if (!stopped && pending.trim()) pass(pending);
      pending = '';
      return out;
    },
    get stopped() { return stopped; },
  };
}
