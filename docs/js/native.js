// Inside the LightMoon Android app (Capacitor), the browser's speech features aren't available, so this
// provides stand-ins with the same shape (speechSynthesis, SpeechSynthesisUtterance, SpeechRecognition)
// backed by Android's own text-to-speech and speech recognition. In a normal browser it does nothing.
// It also exposes the app's native reminder alarms, which speak reminders even when LightMoon is closed.

const capacitor = window.Capacitor;
export const isNativeApp = Boolean(capacitor?.isNativePlatform?.());
const plugins = capacitor?.Plugins ?? {};

// Speaks reminders at their time even when the app is closed (android/.../ReminderAlarmsPlugin.java).
export const nativeAlarms = isNativeApp ? plugins.ReminderAlarms ?? null : null;

// The phone's fingerprint, face or screen-lock check for the app lock (android/.../DeviceUnlockPlugin.java).
export const deviceUnlock = isNativeApp ? plugins.DeviceUnlock ?? null : null;

// Listens for "LightMoon" while the app is closed and opens it ready to talk (android/.../WakeWordPlugin.java).
export const wakeWord = isNativeApp ? plugins.WakeWord ?? null : null;

// Saves a file through Android's "Save to" screen; the app's web view can't download (FileSaverPlugin.java).
export const fileSaver = isNativeApp ? plugins.FileSaver ?? null : null;

// The phone itself: calendar, calls, texts and chat messages, apps, alarms, flashlight (PhonePlugin.java).
export const phone = isNativeApp ? plugins.Phone ?? null : null;

// The Microsoft work account (android/.../WorkAccountPlugin.java): sign-in and tokens for js/graph.js.
export const workAccount = isNativeApp ? plugins.WorkAccount ?? null : null;

// ---------- Talking: a speechSynthesis stand-in on Android text-to-speech ----------

class NativeUtterance {
  constructor(text = '') {
    this.text = text;
    this.lang = '';
    this.rate = 1;
    this.voice = null;
    this.onend = null;
    this.onerror = null;
  }
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// Android's voices, shaped like the browser's (name, lang, localService), in the plugin's order: the plugin picks
// a voice by its position in this list. Loaded once Android's text-to-speech has started (a moment after opening).
let androidVoices = [];
const voiceListeners = [];
const engineReady = (async () => {
  if (!isNativeApp || !plugins.TextToSpeech) return;
  for (let attempt = 0; attempt < 25; attempt++) {
    try {
      const { voices } = await plugins.TextToSpeech.getSupportedVoices();
      androidVoices = voices.map(v => ({ name: v.voiceURI, voiceURI: v.voiceURI, lang: v.lang, localService: v.localService, default: false }));
      for (const listener of voiceListeners) listener();
      return;
    } catch {
      await wait(400);
    }
  }
})();

// Queued behind what is already being said, so sentences follow each other without a gap. If an online voice
// fails (no connection), the app says this sentence and the ones after it again with an offline voice, in order;
// if another voice fails, the phone's own voice for that language says it instead.
async function sayOnAndroid(text, utterance, wasStopped) {
  const voice = utterance.voice ? androidVoices.findIndex(v => v.name === utterance.voice.name) : -1;
  const lang = utterance.voice?.lang || utterance.lang || 'en-GB';
  const options = { text, lang, rate: utterance.rate || 1, voice, queueStrategy: 1 };
  try {
    return await plugins.TextToSpeech.speak(options);
  } catch (err) {
    if (utterance.voice?.localService === false) throw Object.assign(new Error('network'), { type: 'error', error: 'network' });
    if (wasStopped() || (voice < 0 && lang === 'en-US')) throw err;
    const fallbackLang = /language/i.test(String(err?.message ?? err)) ? 'en-US' : lang;
    return plugins.TextToSpeech.speak({ ...options, voice: -1, lang: fallbackLang });
  }
}

const nativeSynthesis = {
  inFlight: new Set(), // for each sentence handed to Android and not finished: ends its wait when cancelled
  pending: false,

  get speaking() {
    return this.inFlight.size > 0;
  },

  speak(utterance) {
    const text = utterance.text.trim();
    if (!text) {
      setTimeout(() => utterance.onend?.());
      return;
    }
    // Android drops queued sentences on stop without answering, so cancel() ends their waits itself (and one
    // cancelled while the voice was still starting up is never said).
    let stopped = false;
    let interrupt;
    const interrupted = new Promise(resolve => {
      interrupt = () => {
        stopped = true;
        resolve();
      };
    });
    this.inFlight.add(interrupt);
    engineReady
      .then(() => (stopped ? null : Promise.race([sayOnAndroid(text, utterance, () => stopped), interrupted])))
      .then(() => utterance.onend?.(), err => utterance.onerror?.(err))
      .finally(() => this.inFlight.delete(interrupt));
  },

  cancel() {
    plugins.TextToSpeech.stop().catch(() => {});
    for (const interrupt of this.inFlight) interrupt();
    this.inFlight.clear();
  },

  getVoices: () => androidVoices,
  addEventListener(type, listener) {
    if (type === 'voiceschanged') voiceListeners.push(listener);
  },
};

// ---------- Listening: a SpeechRecognition stand-in on Android speech recognition ----------
// Android stops listening after each pause and reports the words as it goes; this turns that into the
// browser's result/end events so the app's own "wait until you've finished talking" logic works unchanged.

class NativeRecognition {
  constructor() {
    this.lang = 'en-US';
    this.continuous = false;
    this.interimResults = true;
    this.onresult = null;
    this.onerror = null;
    this.onend = null;
    this.heard = '';
    this.done = false;
    this.handles = [];
  }

  async start() {
    const recognizer = plugins.SpeechRecognition;
    try {
      let permission = await recognizer.checkPermissions();
      if (permission.speechRecognition !== 'granted') permission = await recognizer.requestPermissions();
      if (permission.speechRecognition !== 'granted') return this.fail('not-allowed');
      this.handles.push(await recognizer.addListener('partialResults', ({ matches }) => {
        if (this.done || !matches?.[0]) return;
        this.heard = matches[0];
        this.others = matches.slice(1, 3);
        this.emit(this.heard, false);
      }));
      await recognizer.start({ language: this.lang, partialResults: true, popup: false, maxResults: 3 });
    } catch {
      return this.fail('network');
    }
    // Android doesn't always say when it stops (e.g. nothing was said), so check.
    this.poll = setInterval(async () => {
      const { listening } = await recognizer.isListening().catch(() => ({ listening: false }));
      if (!listening) this.finishSoon();
    }, 600);
  }

  // The final words arrive just after the microphone stops.
  finishSoon() {
    if (this.finishing || this.done) return;
    this.finishing = setTimeout(() => this.finish(), 700);
  }

  finish() {
    if (this.done) return;
    this.cleanup();
    if (this.heard) this.emit(this.heard, true);
    this.onend?.();
  }

  emit(text, isFinal) {
    const result = Object.assign([{ transcript: text }, ...(this.others ?? []).map(other => ({ transcript: other }))], { isFinal });
    this.onresult?.({ resultIndex: 0, results: [result] });
  }

  fail(error) {
    this.cleanup();
    this.onerror?.({ error });
    this.onend?.();
  }

  cleanup() {
    this.done = true;
    clearInterval(this.poll);
    clearTimeout(this.finishing);
    for (const handle of this.handles) handle.remove?.();
    this.handles = [];
  }

  stop() {
    plugins.SpeechRecognition.stop().catch(() => {});
    this.finishSoon();
  }

  abort() {
    this.cleanup();
    plugins.SpeechRecognition.stop().catch(() => {});
  }
}

if (isNativeApp) {
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: nativeSynthesis });
  window.SpeechSynthesisUtterance = NativeUtterance;
  window.SpeechRecognition = NativeRecognition;
  window.webkitSpeechRecognition = NativeRecognition;
}
