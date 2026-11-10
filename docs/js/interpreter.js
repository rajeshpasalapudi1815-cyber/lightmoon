// The interpreter: "translate for me", "what is he saying?". LightMoon listens to the people around them, in any
// language (Hindi, Marathi, Malayalam, Bengali, Tamil, ... it works out which by itself), and after each pause says
// in English what was said, and shows it. Each stretch of speech is recorded on this device and sent to Groq's
// Whisper, which hears the language and translates it to English (their own Groq key, free tier). Tap the eyes, or
// say "stop translating", to end it. tests/interpreter.test.mjs checks the parts that don't need a microphone.

const GROQ = 'https://api.groq.com/openai/v1';
const MODEL = 'whisper-large-v3'; // the Whisper that translates (turbo only transcribes)

const LOUD = 0.018; // RMS above this is someone talking (after noise suppression)
const PAUSE_MS = 900; // this much quiet after speech ends a stretch
const MIN_SPEECH_MS = 450; // shorter than this is a cough or a click
const MAX_STRETCH_MS = 25_000; // a long speech is cut here, so translations keep coming
const GIVE_UP_MS = 10 * 60_000; // nobody spoke for this long: stop

// "Translate for me", "be my interpreter", "what is he saying", "translate what she says", "interpret this",
// "tell me what they're saying in English".
const START = /\b(?:be my (?:interpreter|translator)|interpret(?:er)?\b(?! (?:this )?(?:word|sentence|message|text))|translate (?:for me|what (?:he|she|they|this (?:guy|man|lady|person)|people) (?:is |are |'s |'re )?(?:say|said|saying|speak|speaking|telling)|(?:this |the )?conversation|live|in real ?time)|what(?: is|'s) (?:he|she|this (?:guy|man|lady|person)) (?:saying|telling|speaking)|what are they (?:saying|telling|speaking)|tell me what (?:he|she|they) (?:is |are |'s |'re )?(?:saying|telling|speaking))/i;
const STOP = /\b(?:stop|end|enough|finish|quit|cancel)\b[^.?!]{0,20}\b(?:translat\w*|interpret\w*|listening)\b|\bthat'?s (?:all|enough)\b|\b(?:thank you|thanks),? (?:light ?moon|that'?s all)\b/i;

export const interpreterWanted = text => START.test(String(text ?? ''));
export const interpreterStop = text => STOP.test(String(text ?? ''));

// Whisper makes these up from silence or noise: never say them.
const MADE_UP = /^(?:thank you\.?|thanks for watching[.!]?|thank you for watching[.!]?|please subscribe[.!]?|you|bye\.?|\.+|subtitles? by .*|transcribed by .*|amara\.org.*|music|\[.*\]|\(.*\))$/i;
export function cleanTranslation(text) {
  const said = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!said || said.length < 2 || MADE_UP.test(said) || !/[a-z]/i.test(said)) return '';
  return said;
}

export async function translateAudio(blob, apiKey) {
  const form = new FormData();
  form.append('file', blob, `speech.${/ogg/.test(blob.type) ? 'ogg' : /mp4/.test(blob.type) ? 'm4a' : 'webm'}`);
  form.append('model', MODEL);
  form.append('temperature', '0');
  form.append('response_format', 'json');
  let res;
  try {
    res = await fetch(`${GROQ}/audio/translations`, {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form, signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error("I can't reach the translator. Check the internet connection.");
  }
  if (res.status === 401 || res.status === 403) throw new Error('The Groq key was refused by the translator.');
  if (res.status === 429) throw new Error('rate-limit');
  if (!res.ok) throw new Error(`The translator didn't answer (${res.status}).`);
  const out = await res.json().catch(() => ({}));
  return cleanTranslation(out.text);
}

let session = null;
export const interpreting = () => Boolean(session);

// onHeard(english): a translation to show and say. onState('listening' | 'translating' | 'stopped', why?).
// isSpeaking(): LightMoon is talking, so what the mic hears now is its own voice.
export async function startInterpreter({ apiKey, onHeard, onState, onError, isSpeaking = () => false }) {
  if (session) return;
  if (!apiKey) throw new Error('The interpreter needs your Groq API key (Settings → AI).');
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error("This device can't record for the interpreter.");
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  const audio = new AudioContext();
  const analyser = audio.createAnalyser();
  analyser.fftSize = 2048;
  audio.createMediaStreamSource(stream).connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  const type = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find(t => MediaRecorder.isTypeSupported(t)) ?? '';

  const me = { stream, audio, recorder: null, speechMs: 0, lastLoud: 0, startedAt: 0, heardAt: Date.now(), timer: null, queue: Promise.resolve() };
  session = me;

  const begin = () => {
    me.speechMs = 0;
    me.lastLoud = 0;
    me.startedAt = Date.now();
    const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    recorder.chunks = []; // this recorder's own pieces (the last arrives after stop, when the next one is going)
    recorder.ondataavailable = e => { if (e.data.size) recorder.chunks.push(e.data); };
    recorder.start();
    me.recorder = recorder;
  };
  // A stretch is done: start the next one at once, and translate this one (in order).
  const cut = () => {
    const recorder = me.recorder;
    const spoke = me.speechMs >= MIN_SPEECH_MS;
    recorder.onstop = () => {
      if (!spoke || session !== me) return;
      const blob = new Blob(recorder.chunks, { type: recorder.mimeType || 'audio/webm' });
      onState?.('translating');
      me.queue = me.queue.then(async () => {
        try {
          const english = await translateAudio(blob, apiKey);
          if (session !== me) return;
          if (english) {
            me.heardAt = Date.now();
            if (interpreterStop(english)) return stopInterpreter('asked');
            onHeard?.(english);
          }
        } catch (err) {
          if (session === me) onError?.(err.message === 'rate-limit' ? 'The translator is at its free limit for a minute; I\'ll carry on.' : err.message);
          if (/refused|needs/.test(err.message)) stopInterpreter('error');
        } finally {
          if (session === me) onState?.('listening');
        }
      });
    };
    recorder.stop();
    begin();
  };

  const TICK_MS = 50;
  me.timer = setInterval(() => {
    if (session !== me) return;
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const s of samples) sum += s * s;
    const loud = Math.sqrt(sum / samples.length) > LOUD && !isSpeaking();
    const now = Date.now();
    if (loud) {
      me.speechMs += TICK_MS;
      me.lastLoud = now;
    }
    const paused = me.lastLoud && now - me.lastLoud > PAUSE_MS;
    if ((paused && me.speechMs > 0) || now - me.startedAt > MAX_STRETCH_MS) cut();
    else if (!me.speechMs && now - me.startedAt > 8000) { me.recorder.onstop = null; me.recorder.stop(); begin(); } // nothing said: start afresh, small
    if (now - me.heardAt > GIVE_UP_MS) stopInterpreter('quiet');
  }, TICK_MS);

  me.onState = onState;
  begin();
  onState?.('listening');
}

export function stopInterpreter(why = 'asked') {
  const me = session;
  if (!me) return;
  session = null;
  clearInterval(me.timer);
  try { if (me.recorder?.state !== 'inactive') { me.recorder.onstop = null; me.recorder.stop(); } } catch { /* already stopped */ }
  for (const track of me.stream.getTracks()) track.stop();
  me.audio.close().catch(() => {});
  me.onState?.('stopped', why);
}
