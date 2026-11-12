// One-time codes and other security messages never leave the device: not to the AI service, not to the other
// devices, not aloud. A message counts when it has a code-like number AND something that says what the number is:
// a security word ("OTP", "code", "verify", "password", in English, Hindi or Telugu letters), "482913 is your ...",
// or a warning never to share it. "Pin code" alone is a postal code in India, so it doesn't count.
// Bank messages keep what was spent and where, but lose the account number and the balance.
// MessageListener.java has the same code rule (looksLikeCode): change both together. tests/codes.test.mjs checks it.

const SECURITY_WORDS = /\b(otp|one[- ]?time|verif\w*|security code|passcode|password|passwd|login code|auth\w* code|(?<!pin )code|pin(?!\s*code)|mpin|tpin|cvv|sign[- ]?in|log[- ]?in|2fa|two[- ]factor)\b|ओटीपी|कोड|पासवर्ड|ఓటీపీ|ఓటిపి|కోడ్|పాస్‌?వర్డ్/i;
const NEVER_SHARE = /\b(?:do not|don'?t|never|not to) (?:share|disclose|reveal|tell)\b|\bvalid (?:for|till|until|only for)\b|\bexpires? in\b/i;
const IS_YOUR = /\b\d{4,8} is (?:your|the)\b|\b(?:use|enter) \d{4,8}\b/i;
const CODE_NUMBER = /\d{4,8}|\d{3}[- ]\d{3}/;

export const HIDDEN = '(a one-time code or security message, hidden)';

// Their company's apps, sites and names: anything with one of these in its name (an app, a window title, an account,
// an address) is work, and work never goes through LightMoon or to the AI service (their rule, 1 November 2026).
// One list, so the phone's messages, the computer's windows and notifications, email and meetings all agree.
export const WORK_WORDS = /\b(teams|outlook|sharepoint|onedrive|sarasamerica|arogya360)\b/i;

export function looksLikeCode(text) {
  const said = String(text ?? '');
  return CODE_NUMBER.test(said) && (SECURITY_WORDS.test(said) || NEVER_SHARE.test(said) || IS_YOUR.test(said));
}

// Each line that looks like a code, hidden (for what is read off the computer's screen, and its notifications).
export const hideCodes = text => String(text ?? '').split('\n').map(line => (looksLikeCode(line) ? HIDDEN : line)).join('\n');

// "A/c XX1234 debited Rs 500 at BigBasket. Avl Bal Rs 12,345.67" -> "A/c •••• debited Rs 500 at BigBasket. Balance hidden".
const ACCOUNT = /\b(a\/c|acct?|account|card)\.?\s*(?:(?:no\.?|number|ending(?: with| in)?)\s*[:#-]?\s*[x*•]*[\s-]?\d{3,}|[:#-]?\s*[x*•]+[\s-]?\d{2,}|[:#-]?\s*\d{6,})\b/gi;
const BALANCE = /\b(?:(?:avl|avail|available|clear|closing|current|total|net|a\/c|acct?|account)\.?\s*)?bal(?:ance)?\.?\s*(?:is|:|-)?\s*(?:(?:rs\.?|inr|₹)\s*)?[\d,]+(?:\.\d{1,2})?/gi;
export const maskBank = text => String(text ?? '').replace(ACCOUNT, '$1 ••••').replace(BALANCE, 'Balance hidden');

// A message as the AI (and the other devices) may see it: a code hidden, bank details masked, on one line with its
// quotes turned to single ones, so it can't pass itself off as part of what the AI is told ("...\nROUTINES: ...") or
// close its own quotes.
export const shareable = (text, max = 200) => (looksLikeCode(text)
  ? HIDDEN
  : maskBank(String(text ?? '')).replace(/\s+/g, ' ').replace(/["“”]/g, "'").trim().slice(0, max));
