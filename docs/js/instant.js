// Instant commands: everyday requests LightMoon carries out at once, on the device, with no AI call. They answer
// in a second and never count against the AI's limits: the time, "open Spotify", "pause", "next song", "volume 40",
// "torch on", "timer for 10 minutes", "focus for 45 minutes", "do not disturb for an hour", "status report",
// "how much battery", "say that again".
// A protocol is a saved routine ("focus protocol": focus for 45 minutes; open Spotify; play lofi) whose steps are
// all instant commands: "activate focus protocol" then does every step straight away, without the AI.
// This file only works out WHAT was asked (text -> a small command object); tools.js (runInstant) carries it out.
// Anything it isn't sure about is null, and goes to the AI as before. tests/instant.test.mjs checks it.

const WORD_NUMBERS = {
  zero: 0, a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, 'twenty five': 25, thirty: 30, forty: 40, 'forty five': 45,
  fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, 'a hundred': 100, 'one hundred': 100,
};
const NUM = `(?:\\d{1,4}|${Object.keys(WORD_NUMBERS).sort((a, b) => b.length - a.length).join('|')})`;
const toNumber = word => (/^\d/.test(word) ? Number(word) : WORD_NUMBERS[word.replace(/-/g, ' ')] ?? NaN);
const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// "Hey LightMoon, could you please open Spotify for me?" -> "open spotify". `names`: what they call it (its name, their
// own wake word).
export function tidy(text, names = []) {
  let said = String(text ?? '').normalize('NFC').toLowerCase().replace(/[“”"]/g, '').replace(/[’‘]/g, "'").trim();
  const who = ['light ?moon', ...names.map(name => escapeRegex(String(name).toLowerCase().trim())).filter(Boolean)].join('|');
  said = said.replace(new RegExp(`^(?:(?:hey|hi|ok|okay|hello|yo)[ ,]+)?(?:${who})[ ,.!:]*`), '');
  for (let i = 0; i < 2; i++) {
    said = said.replace(/^(?:please|kindly|just|now|and|then|also)[ ,]+/, '')
      .replace(/^(?:can|could|will|would) you (?:please |kindly |just )?/, '')
      .replace(/^i (?:want|need|would like|'d like) you to /, '')
      .replace(/^go ahead and /, '');
    said = said.replace(/[ ,]+(?:please|now|for me|right now|right away|boss|sir|ma'am|madam|thanks|thank you)[ .!?]*$/, '');
  }
  return said.replace(/[.!?,;:]+$/, '').replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
}

// "45 minutes", "an hour and a half", "1 hour 30 minutes", "ninety seconds" -> seconds, or null.
const UNIT = '(seconds?|secs?|minutes?|mins?|hours?|hrs?)';
const unitSeconds = unit => (/^s/.test(unit) ? 1 : /^m/.test(unit) ? 60 : 3600);
export function durationSeconds(text) {
  const said = String(text ?? '').trim();
  if (/^half (?:an |a )?hour$/.test(said)) return 1800;
  if (/^(?:a )?quarter of an hour$/.test(said)) return 900;
  if (/^(?:an|one|1) hour and a half$|^one and a half hours?$|^1\.5 hours?$/.test(said)) return 5400;
  const two = new RegExp(`^(${NUM}) ${UNIT}(?: and|,)? (${NUM}) ${UNIT}$`).exec(said);
  if (two) {
    const total = toNumber(two[1]) * unitSeconds(two[2]) + toNumber(two[3]) * unitSeconds(two[4]);
    return Number.isFinite(total) && total > 0 ? total : null;
  }
  const one = new RegExp(`^(${NUM}) ${UNIT}$`).exec(said);
  if (!one) return null;
  const total = toNumber(one[1]) * unitSeconds(one[2]);
  return Number.isFinite(total) && total > 0 ? total : null;
}
const DURATION = `((?:${NUM}|half|quarter|1\\.5) [a-z0-9 ,]{2,40}?|half (?:an |a )?hour)`;

// "6", "6:30", "6 30 pm", "18:45", "7 in the morning" -> { hour, minute } on the 24-hour clock. With no am/pm it is the
// next time the clock shows it: "alarm at 6" said at 10 at night is 6 in the morning.
export function clockTime(text, now = new Date()) {
  const match = /^(\d{1,2})(?:[:. ](\d{2}))? ?(a\.?m\.?|p\.?m\.?|in the morning|in the afternoon|in the evening|at night|tonight)?$/.exec(String(text ?? '').trim());
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  const part = match[3] ?? '';
  if (hour > 23 || minute > 59) return null;
  if (/^a|morning/.test(part)) {
    if (hour > 12) return null;
    hour %= 12;
  } else if (/^p|afternoon|evening|night/.test(part)) {
    if (hour > 12) return null;
    hour = (hour % 12) + 12;
  } else if (hour >= 1 && hour <= 12) {
    const early = hour % 12; // the same clock face, morning and evening
    const minutesNow = now.getHours() * 60 + now.getMinutes();
    hour = [early, early + 12].find(h => h * 60 + minute > minutesNow) ?? early; // both gone today: tomorrow morning's
  }
  return { hour, minute };
}

const PHONE_ONLY = new Set(['timer', 'alarm', 'torch', 'ringer', 'volume']);

const TIME = /^(?:what(?:'s| is) the time(?: now)?|what time is it(?: now)?|(?:tell me )?the time|time now|current time|what'?s the time)$/;
const DATE = /^(?:what(?:'s| is) (?:the |today'?s )?date(?: today)?|what day is (?:it|today|it today)|today'?s date|which day is (?:it|today)|what is today)$/;
const STATUS = new RegExp('^(?:(?:give me |run |do |show(?: me)? |start |perform )?(?:a |an |the |your |my )?(?:full |quick |complete |system |systems )?'
  + '(?:status(?: report| check| update)?|diagnostics?(?: check| report)?|sit ?rep|situation report|systems? (?:check|report|status)|self ?check|health check|check up)'
  + '|(?:is|are) (?:everything|all systems|your systems|you) (?:working|ok|okay|fine|online|running|up|alright|all right|good)(?: (?:properly|fine|well|correctly))?'
  + '|how are (?:your |the |all )?systems|check (?:your|all|the|all your) systems|check yourself|all systems go)$');
const BATTERY = /^(?:how much (?:battery|charge)(?: (?:is left|is remaining|left|remaining|do (?:i|we|you) have(?: left)?))?|what(?:'s| is) (?:the |my |your )?battery(?: level| percentage| percent| status)?|battery(?: level| percentage| status| percent)?|(?:check|tell me) (?:the |my )?battery(?: level| percentage)?)$/;
const REPEAT = /^(?:(?:say|tell me|repeat) (?:that|it|this)(?: again| once more| one more time)?|repeat|come again|say again|once more|what did you (?:just )?say|pardon|sorry what)$/;

const TIMER = new RegExp(`^(?:(?:set|start|put|make|create|begin|give me|keep) )?(?:a |an |the )?(?:timer|countdown) (?:for |of |to )?${DURATION}$`);
const TIMER_FIRST = new RegExp(`^(?:(?:set|start|put|make|create|begin) )?(?:a |an )?${DURATION} (?:timer|countdown)$`);
const ALARM = /^(?:(?:set|put|make|create|keep) )?(?:an |a |the |my )?alarm (?:for |at )(.+)$/;
const WAKE_ME = /^wake me(?: up)? at (.+)$/;

const FOCUS_END = /^(?:(?:end|stop|finish|turn off|switch off|cancel|exit|disable|leave) (?:the |my )?focus(?: mode| time| session)?|focus(?: mode)? (?:off|over|done)|(?:turn|switch) (?:the )?focus(?: mode)? off)$/;
const FOCUS = new RegExp(`^(?:(?:start|begin|turn on|switch on|enable|go into|activate|set|put on) )?(?:a |the |my )?focus(?: mode| time| session)?(?: on)?(?: (?:for|of) ${DURATION})?$`);
const FOCUS_SILENCE = new RegExp(`^(?:silence|mute|quieten) (?:the |my )?phone for ${DURATION}$`);
const SILENCE = /^(?:silence|mute|quieten) (?:the |my )?phone$/;
const QUIET = new RegExp('^(?:(?:do not|don\'?t|dont) disturb(?: me)?|hold everything|(?:hold|keep back|pause) (?:all )?(?:my |the )?(?:reminders|announcements)|'
  + `(?:leave me alone|give me (?:some )?(?:peace|quiet)|quiet time|no interruptions?))(?: (?:for|for the next) ${DURATION})?$`);

const ON_OFF = '(on|off)';
const TORCH = '(?:flash ?light|torch|flash)';
const TORCH_A = new RegExp(`^(?:(?:turn|switch|put) )?${ON_OFF} (?:the |my )?${TORCH}$`);
const TORCH_B = new RegExp(`^(?:(?:turn|switch|put) )?(?:the |my )?${TORCH} ${ON_OFF}$`);
const TORCH_C = new RegExp(`^${TORCH}$`);
const RINGER_A = /^(?:(?:put|set|turn|switch|keep|make) )?(?:the |my )?(?:phone|ringer|ring) (?:on |to |in |into )?(silent|vibrate|vibration|normal|ring|loud|sound)(?: mode)?$/;
const RINGER_B = /^(silent|vibrate|vibration|normal) mode(?: on)?$/;
const VOLUME = new RegExp(`^(?:(?:set|turn|put|make|keep|change) )?(?:the |my )?(?:(media|music|ring|ringer|alarm) )?volume (?:to |at |up to |down to )?(${NUM}|full|max|maximum|half|zero)(?: ?%| percent| per cent)?$`);
const MUTE = /^mute(?: (?:it|the phone|the volume|the sound|the music))?$/;

const THING = '(?:it|this|that|the (?:music|song|video|movie|film|audio|track|show)|music|playback)';
const PAUSE = new RegExp(`^(?:pause(?: ${THING})?|stop (?:the )?(?:music|song|video|movie|film|playback|audio)|stop playing)$`);
const RESUME = new RegExp(`^(?:(?:play|resume|unpause)(?: ${THING})?|continue ${THING}|play (?:some |my )?(?:music|songs?)|play something|carry on playing)$`);
// A bare "next", "skip" or "back" could be about what LightMoon was saying: these need the song or track named.
const NEXT = /^(?:next|skip)(?: the| this| that)? (?:song|track|video|music)$|^(?:play (?:the )?next(?: (?:song|track|one))?|change (?:the |this )?song)$/;
const PREVIOUS = /^(?:previous|last) (?:song|track|video)$|^go back (?:a|one) (?:song|track)$|^play (?:the )?(?:previous|last) (?:song|track|one)(?: again)?$/;
const MUSIC_APP = '(spotify|youtube music|yt music|youtube|i music|jiosaavn|jio saavn|saavn|gaana|wynk|amazon music|apple music|music)';
const PLAY_WHAT = new RegExp(`^play (.{2,80}?)(?: (?:on|in|using|with|from) (?:the )?${MUSIC_APP}(?: app)?)?$`);

const OPEN = /^(?:open|launch|start|bring up|pull up)(?: up)? (?:the |my )?([a-z0-9][a-z0-9 .&'+]{0,30}?)(?: app| application)?$/;
const NOT_AN_APP = /^(?:a |an |the |my )?(?:timer|countdown|alarm|focus|protocol|routine|music|song|playing|listening|talking|interpret|translat|practi[cs]|conversation|door|window|eyes|sleep|work|chat|settings$)|\b(?:and|then|to|for|with)\b/;

const SAY = /^(?:say|tell me|speak|announce|greet me with)[:,]? (.{1,200})$/;

// One request, or one step of a protocol -> a command, or null. `device`: 'phone' (the Android app) or 'computer'.
// `step`: it is a step of a saved protocol, where "say good morning" is a line to speak.
export function instantCommand(text, { device = 'computer', now = new Date(), step = false, names = [] } = {}) {
  const said = step ? asCommand(tidy(text, names)) : tidy(text, names);
  if (!said || said.split(' ').length > 14) return null;
  const found = parse(said, now, step);
  if (!found) return null;
  if (PHONE_ONLY.has(found.kind) && device !== 'phone') return null; // the computer has no torch, ringer or clock app
  if (found.kind === 'media' && found.what && device !== 'phone') return null; // what to play on a computer is the AI's call
  return found;
}

function parse(said, now, step) {
  if (TIME.test(said)) return { kind: 'time' };
  if (DATE.test(said)) return { kind: 'date' };
  if (STATUS.test(said)) return { kind: 'status' };
  if (BATTERY.test(said)) return { kind: 'battery' };
  if (!step && REPEAT.test(said)) return { kind: 'repeat' };

  const timer = TIMER.exec(said) ?? TIMER_FIRST.exec(said);
  if (timer) {
    const seconds = durationSeconds(timer[1]);
    return seconds && seconds <= 24 * 3600 ? { kind: 'timer', seconds } : null;
  }
  const alarm = ALARM.exec(said) ?? WAKE_ME.exec(said);
  if (alarm) {
    const at = clockTime(alarm[1], now);
    return at ? { kind: 'alarm', ...at } : null;
  }

  if (FOCUS_END.test(said)) return { kind: 'focus', end: true };
  if (SILENCE.test(said)) return { kind: 'ringer', mode: 'silent' };
  const focus = FOCUS.exec(said) ?? FOCUS_SILENCE.exec(said);
  if (focus) {
    const seconds = focus[1] ? durationSeconds(focus[1]) : 45 * 60;
    return seconds ? { kind: 'focus', minutes: Math.min(Math.max(Math.round(seconds / 60), 5), 480) } : null;
  }
  const quiet = QUIET.exec(said);
  if (quiet) {
    const seconds = quiet[1] ? durationSeconds(quiet[1]) : 60 * 60;
    return seconds ? { kind: 'quiet', minutes: Math.min(Math.max(Math.round(seconds / 60), 10), 1440) } : null;
  }

  const torch = TORCH_A.exec(said) ?? TORCH_B.exec(said);
  if (torch) return { kind: 'torch', on: torch[1] === 'on' };
  if (TORCH_C.test(said)) return { kind: 'torch', on: true };
  const ringer = RINGER_A.exec(said) ?? RINGER_B.exec(said);
  if (ringer) return { kind: 'ringer', mode: /^vib/.test(ringer[1]) ? 'vibrate' : ringer[1] === 'silent' ? 'silent' : 'normal' };
  const volume = VOLUME.exec(said);
  if (volume) {
    const level = { full: 100, max: 100, maximum: 100, half: 50, zero: 0 }[volume[2]] ?? toNumber(volume[2]);
    if (!Number.isFinite(level) || level > 100) return null;
    const stream = /^ring/.test(volume[1] ?? '') ? 'ring' : volume[1] === 'alarm' ? 'alarm' : 'media';
    return { kind: 'volume', percent: level, stream };
  }
  if (MUTE.test(said)) return { kind: 'volume', percent: 0, stream: 'media' };

  if (PAUSE.test(said)) return { kind: 'media', action: 'pause' };
  if (RESUME.test(said)) return { kind: 'media', action: 'play' };
  if (NEXT.test(said)) return { kind: 'media', action: 'next' };
  if (PREVIOUS.test(said)) return { kind: 'media', action: 'previous' };
  const play = PLAY_WHAT.exec(said);
  if (play && !/^(?:a game|games?|with|the role|along|it safe)\b/.test(play[1])) {
    return { kind: 'media', action: 'play', what: play[1].trim(), ...(play[2] && { app: play[2] === 'yt music' ? 'youtube music' : play[2] }) };
  }

  if (step) {
    const say = SAY.exec(said);
    if (say) return { kind: 'say', text: say[1].trim() };
  }
  const open = OPEN.exec(said);
  if (open && !NOT_AN_APP.test(open[1])) return { kind: 'open', name: open[1].trim() };
  return null;
}

// ---------- Protocols ----------

// A step as it was written down ("opens Spotify", "to play lofi", "it should say good morning") -> a command to parse.
const THIRD_PERSON = { opens: 'open', launches: 'launch', starts: 'start', plays: 'play', pauses: 'pause', stops: 'stop', sets: 'set',
  turns: 'turn', switches: 'switch', puts: 'put', says: 'say', tells: 'tell', silences: 'silence', mutes: 'mute', holds: 'hold',
  runs: 'run', gives: 'give', skips: 'skip', resumes: 'resume', begins: 'begin', keeps: 'keep', makes: 'make', checks: 'check' };
function asCommand(clause) {
  let said = clause.replace(/^(?:\d+[.)]|[-•*]|step \d+[:.]?|first|second|third|next|finally|lastly|after that|and|then|also|to|you|it|you should|it should|should)[ ,:]+/, '');
  said = said.replace(/^(?:and|then|also|to|you|it|you should|it should|should|must|will) /, '');
  const [first, ...rest] = said.split(' ');
  return [THIRD_PERSON[first] ?? first, ...rest].join(' ');
}

// The steps of a protocol ("focus for 45 minutes; open Spotify and play lofi") -> its commands, or null if any step
// is something only the AI can do (then the AI runs the whole routine, as before).
export function protocolSteps(steps, options = {}) {
  const clauses = String(steps ?? '').split(/[;\n]+|\.\s+|,?\s+(?:and\s+)?then\s+|,\s*(?:and\s+)?/).map(c => c.trim()).filter(Boolean);
  if (!clauses.length || clauses.length > 12) return null;
  // A line to speak keeps its own words ("say good night, boss" is said as written); anything else is a command.
  const SAY_LINE = /^(?:(?:and|then|also|to|it should|you should|should|finally)\s+)*(?:says?|tell me|speak|announce)[:,]?\s+(.{1,200})$/i;
  const stepOf = words => {
    const line = SAY_LINE.exec(words);
    if (!line) return instantCommand(words, { ...options, step: true });
    const text = line[1].replace(/^["'“”]+|["'“”.]+$/g, '').trim();
    return text ? { kind: 'say', text } : null;
  };
  const commands = [];
  for (const clause of clauses) {
    const whole = stepOf(clause);
    if (whole) {
      commands.push(whole);
      continue;
    }
    const parts = clause.split(/\s+and\s+/);
    if (parts.length < 2) return null;
    for (const part of parts) {
      const command = stepOf(part);
      if (!command) return null;
      commands.push(command);
    }
  }
  return commands;
}

// The words of a protocol's name, for matching: "the Focus protocol" and "focus" are the same one.
export const protocolKey = name => tidy(name).replace(/^(?:the|my|a|an) /, '').replace(/ (?:protocol|routine|mode|sequence)$/, '').trim();

// "Activate focus protocol", "run my morning routine", "focus protocol", or just the phrase itself -> the routine of
// theirs it names, or null. `routines`: [{ trigger, steps }].
const RUN = /^(?:activate|run|start|begin|initiate|execute|engage|launch|trigger|do|go to|enter|switch to|put on)(?: up)? (.+)$/;
export function protocolAsked(text, routines = [], names = []) {
  const said = tidy(text, names);
  if (!said || said.split(' ').length > 9) return null;
  const run = RUN.exec(said);
  const named = / (?:protocol|routine|sequence)$/.test(said);
  const key = protocolKey(run ? run[1] : said);
  if (!key) return null;
  const found = routines.find(r => protocolKey(r.trigger) === key);
  if (!found) return null;
  // The bare phrase must be the whole message; "activate ..." or "... protocol" make it plain it is meant.
  return run || named || tidy(found.trigger) === said || protocolKey(found.trigger) === said ? found : null;
}

// "When I say focus protocol, focus for 45 minutes, open Spotify and play lofi" -> { trigger, steps }, or null.
const DEFINE_A = /^(?:when|whenever|if) i say (.{2,60}?)(?:,|:| then| you should| you must| do this| do)[ ,:]*(.{3,400})$/;
const DEFINE_B = /^(?:create|make|save|add|set up|define|new)(?: me)? (?:a |an |the )?(?:new )?(?:protocol|routine)(?: called| named)? (.{2,60}?)(?::|,| that| which| to| it should| should| means| will| does)[ ,:]*(.{3,400})$/;
export function protocolDefined(text, names = []) {
  const who = ['light ?moon', ...names.map(name => escapeRegex(String(name).toLowerCase().trim())).filter(Boolean)].join('|');
  const lower = String(text ?? '').normalize('NFC').toLowerCase().replace(/[“”"]/g, '').replace(/[’‘]/g, "'").trim()
    .replace(new RegExp(`^(?:(?:hey|hi|ok|okay|hello)[ ,]+)?(?:${who})[ ,.!:]*`), '').replace(/^(?:please|kindly)[ ,]+/, '')
    .replace(/[.!?]+$/, '').replace(/\s+/g, ' ');
  const match = DEFINE_A.exec(lower) ?? DEFINE_B.exec(lower);
  if (!match) return null;
  const trigger = match[1].trim().replace(/^the /, '');
  const steps = match[2].trim();
  return trigger && steps ? { trigger, steps } : null;
}

// "What protocols do I have", "list my routines".
export const protocolsListed = (text, names = []) => /^(?:what (?:are )?(?:my |the )?(?:protocols|routines)(?: do i have| are there| have i got)?|(?:list|show|tell me|read)(?: me)? (?:all )?(?:my |the )?(?:protocols|routines)|which (?:protocols|routines) do i have)$/.test(tidy(text, names));

// ---------- What to say ----------

const two = n => String(n).padStart(2, '0');
export function spokenClock(hour, minute) {
  const h = hour % 12 || 12;
  return `${h}${minute ? `:${two(minute)}` : ''} ${hour < 12 ? 'AM' : 'PM'}`;
}
export function spokenDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts = [h && `${h} hour${h === 1 ? '' : 's'}`, m && `${m} minute${m === 1 ? '' : 's'}`, s && `${s} second${s === 1 ? '' : 's'}`].filter(Boolean);
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0] ?? '0 seconds';
}

// A step, said back when a protocol is saved: "focus for 45 minutes", "open Spotify".
export function describe(command) {
  switch (command.kind) {
    case 'time': return 'tell the time';
    case 'date': return 'tell the date';
    case 'status': return 'give a status report';
    case 'battery': return 'tell the battery level';
    case 'timer': return `set a timer for ${spokenDuration(command.seconds)}`;
    case 'alarm': return `set an alarm for ${spokenClock(command.hour, command.minute)}`;
    case 'focus': return command.end ? 'end focus mode' : `focus for ${spokenDuration(command.minutes * 60)}`;
    case 'quiet': return `hold everything for ${spokenDuration(command.minutes * 60)}`;
    case 'torch': return `turn the torch ${command.on ? 'on' : 'off'}`;
    case 'ringer': return `put the phone on ${command.mode}`;
    case 'volume': return `set the ${command.stream === 'media' ? '' : `${command.stream} `}volume to ${command.percent} percent`;
    case 'media': return command.what ? `play ${command.what}${command.app ? ` on ${command.app}` : ''}` : { play: 'play music', pause: 'pause what is playing', next: 'skip to the next track', previous: 'go back a track' }[command.action];
    case 'say': return `say "${command.text}"`;
    case 'open': return `open ${command.name}`;
    default: return command.kind;
  }
}
