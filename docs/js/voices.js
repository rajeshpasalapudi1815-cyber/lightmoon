// Male and female voices. Neither Android nor browsers say which a voice is, so this knows the common ones by
// name: Google's Android voices ("en-in-x-ena-local"), Edge's natural voices, Chrome's, Windows' and Apple's.
// The phone speaks with a female voice and the computer with a male one, unless the user picks another in
// Settings (app.js). tests/voices.test.mjs checks it.

// Google text-to-speech voice codes on Android, by language.
const ANDROID = {
  female: ['gba', 'gbc', 'gbg', 'ena', 'enc', 'iob', 'iog', 'sfg', 'tpc', 'tpf', 'aua', 'auc', 'afh', 'cfs', 'hia', 'hic', 'tea', 'tad'],
  male: ['gbb', 'gbd', 'rjs', 'end', 'ene', 'iol', 'iom', 'tpd', 'aub', 'aud', 'hid', 'hie', 'tec', 'tae'],
};
// First names in Edge, Chrome, Windows and Apple voice names ("Microsoft Ryan Online (Natural) - English...").
const NAMED = {
  female: ['sonia', 'libby', 'maisie', 'hollie', 'neerja', 'aria', 'jenny', 'michelle', 'ana', 'emma', 'ava', 'natasha', 'clara',
    'emily', 'molly', 'leah', 'yan', 'rosa', 'ezinne', 'imani', 'asilia', 'zira', 'hazel', 'susan', 'heera', 'catherine', 'linda',
    'swara', 'shruti', 'pallavi', 'serena', 'kate', 'samantha', 'karen', 'moira', 'tessa', 'veena', 'fiona', 'victoria', 'allison'],
  male: ['ryan', 'thomas', 'prabhat', 'guy', 'davis', 'andrew', 'brian', 'christopher', 'eric', 'roger', 'steffan', 'william', 'liam',
    'connor', 'mitchell', 'luke', 'sam', 'wayne', 'james', 'abeo', 'chilemba', 'elimu', 'david', 'mark', 'george', 'ravi', 'richard',
    'sean', 'madhur', 'mohan', 'valluvar', 'daniel', 'arthur', 'alex', 'rishi', 'fred', 'oliver', 'aaron', 'tom'],
};

// 'female', 'male', or null when it isn't known.
export function genderOf(voice) {
  const name = String(voice?.name ?? voice ?? '').toLowerCase();
  const android = name.match(/^[a-z]{2,3}-[a-z]{2}-x-([a-z]+)-(local|network)$/);
  if (android) {
    if (ANDROID.female.includes(android[1])) return 'female';
    if (ANDROID.male.includes(android[1])) return 'male';
    return null;
  }
  if (/\bfemale\b/.test(name)) return 'female';
  if (/\bmale\b/.test(name)) return 'male';
  if (/^google (us|uk|india)? ?english$/.test(name.replace(/\s+/g, ' ').trim()) || /^google us english/.test(name)) return 'female';
  const words = name.replace(/^microsoft\s+/, '').split(/[\s(),-]+/);
  if (NAMED.female.includes(words[0])) return 'female';
  if (NAMED.male.includes(words[0])) return 'male';
  return null;
}

// The phone gets a female voice, the computer a male one.
export const wantedGender = phone => (phone ? 'female' : 'male');

// The most natural voices of each kind, best first; a name matches as its start. On the phone, Google's Indian
// English voice, online (with its offline twin when there's no connection), then the British ones; on the
// computer, Edge's natural voices, then Chrome's, Windows' and Apple's.
export const BEST = {
  female: ['en-in-x-ena-network', 'en-in-x-ena-local', 'en-gb-x-gba-local', 'en-gb-x-gbc-local', 'Microsoft Sonia Online', 'Microsoft Neerja Online',
    'Microsoft Libby Online', 'Google UK English Female', 'Microsoft Hazel', 'Microsoft Heera', 'Serena', 'Kate', 'Microsoft Zira', 'Samantha'],
  male: ['Microsoft Ryan Online', 'Microsoft Thomas Online', 'Microsoft Prabhat Online', 'en-gb-x-rjs-local', 'en-gb-x-gbd-local', 'en-in-x-end-local',
    'Google UK English Male', 'Microsoft George', 'Microsoft Ravi', 'Daniel', 'Microsoft David', 'Microsoft Mark'],
};

// The best voice of that kind among those available, else null.
export function bestVoice(voices, gender) {
  for (const preferred of BEST[gender] ?? []) {
    const hit = voices.find(v => v.name.startsWith(preferred));
    if (hit) return hit;
  }
  return voices.find(v => v.lang.startsWith('en') && genderOf(v) === gender && !/-language$/.test(v.name)) ?? null;
}
