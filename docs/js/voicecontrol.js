// Spoken commands about LightMoon itself, answered without the AI (tools.js quickReply):
//   "turn off the wake word", "wake word off"      -> the wake word stops (the phone's, or the computer's Listener)
//   "turn on the wake word"                         -> back on (said in LightMoon, since without it nothing hears it)
//   "go to the background", "hide yourself"         -> on the computer, LightMoon's window goes out of sight
//   "show yourself", "come back"                    -> and comes back
// tests/voicecontrol.test.mjs checks the phrases.

const WAKE = String.raw`wake[\s-]?(?:up\s+)?(?:word|phrase|up)`;
const WAKE_OFF = new RegExp(String.raw`\b(?:turn|switch|put|shut)\s+(?:the\s+)?${WAKE}\s+off\b|\b(?:turn|switch|put|shut)\s+off\s+(?:the\s+)?${WAKE}\b|\b${WAKE}\s+(?:off|stop)\b|\b(?:stop|disable)\s+(?:the\s+)?${WAKE}\b|\boff\s+(?:the\s+)?${WAKE}\b`, 'i');
const WAKE_ON = new RegExp(String.raw`\b(?:turn|switch|put)\s+(?:the\s+)?${WAKE}\s+(?:back\s+)?on\b|\b(?:turn|switch|put)\s+(?:back\s+)?on\s+(?:the\s+)?${WAKE}\b|\b${WAKE}\s+(?:back\s+)?on\b|\b(?:start|enable)\s+(?:the\s+)?${WAKE}\b`, 'i');
const HIDE = /\b(?:go\s+(?:back\s+)?(?:to|in(?:to)?)\s+(?:the\s+)?background|hide\s+(?:your\s*self|yourself)|go\s+(?:and\s+)?hide|stay\s+hidden|be\s+hidden|minimi[sz]e\s+(?:your\s*self|yourself)|run\s+in\s+(?:the\s+)?background)\b/i;
const SHOW = /\b(?:show\s+(?:your\s*self|yourself|up)|come\s+(?:back|to\s+the\s+front|out)|stop\s+hiding|un-?hide)\b/i;

// A short message (a command, not a sentence that mentions these) -> 'wake-off' | 'wake-on' | 'hide' | 'show' | null.
export function voiceCommand(text) {
  const said = String(text ?? '').trim();
  if (!said || said.split(/\s+/).length > 9) return null;
  if (WAKE_OFF.test(said)) return 'wake-off';
  if (WAKE_ON.test(said)) return 'wake-on';
  if (HIDE.test(said)) return 'hide';
  if (SHOW.test(said)) return 'show';
  return null;
}
