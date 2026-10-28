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

// Android's voice takes a moment to load when the app opens, and may not have the accent asked for.
async function sayOnAndroid(text, lang, rate) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await plugins.TextToSpeech.speak({ text, lang, rate });
    } catch (err) {
      const message = String(err?.message ?? err);
      if (/language/i.test(message) && lang !== 'en-US') lang = 'en-US';
      else if (/initialized/i.test(message) && attempt < 10) await wait(400);
      else throw err;
    }
  }
}

const nativeSynthesis = {
  queue: [],
  speaking: false,
  pending: false,
  interrupt: null,

  speak(utterance) {
    this.queue.push(utterance);
    this.pending = true;
    if (!this.speaking) this.next();
  },

  async next() {
    const utterance = this.queue.shift();
    this.pending = this.queue.length > 0;
    if (!utterance) {
      this.speaking = false;
      return;
    }
    this.speaking = true;
    try {
      if (utterance.text.trim()) {
        // Android drops the request on stop without answering, so cancel() ends the wait itself.
        const interrupted = new Promise(resolve => { this.interrupt = resolve; });
        await Promise.race([sayOnAndroid(utterance.text, utterance.lang || 'en-GB', utterance.rate || 1), interrupted]);
      }
      utterance.onend?.();
    } catch (err) {
      utterance.onerror?.(err);
    }
    this.next();
  },

  cancel() {
    this.queue = [];
    this.pending = false;
    plugins.TextToSpeech.stop().catch(() => {});
    this.interrupt?.();
  },

  getVoices: () => [],
  addEventListener() {},
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
        this.emit(this.heard, false);
      }));
      await recognizer.start({ language: this.lang, partialResults: true, popup: false, maxResults: 1 });
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
    const result = Object.assign([{ transcript: text }], { isFinal });
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
