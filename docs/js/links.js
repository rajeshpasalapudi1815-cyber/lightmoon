// A scam check for links in messages ("Your SBI account is blocked, update KYC at sbi-kyc-update.xyz") and links
// the user pastes. It looks only at the link and the words around it, never opens the link or sends it anywhere,
// so it can't say a link is safe: only that it looks risky, worth care, or like the real site. phone.js marks
// messages with it, and check_link (tools.js) answers "is this link safe?". tests/links.test.mjs checks it.

// Real sites of the names scams pretend to be most, by their registered domain.
const BRANDS = {
  sbi: ['sbi', 'onlinesbi.sbi', 'sbi.co.in', 'onlinesbi.com', 'sbicard.com', 'yonobusiness.sbi'],
  hdfc: ['hdfcbank.com', 'hdfc.com', 'hdfclife.com', 'hdfcergo.com'],
  icici: ['icicibank.com', 'icicidirect.com', 'iciciprulife.com'],
  axis: ['axisbank.com'],
  kotak: ['kotak.com', 'kotaksecurities.com'],
  paytm: ['paytm.com', 'paytm.in', 'paytmbank.com'],
  phonepe: ['phonepe.com'],
  amazon: ['amazon.in', 'amazon.com', 'amazon.co.uk', 'amzn.in', 'amzn.to', 'primevideo.com'],
  flipkart: ['flipkart.com', 'fkrt.it'],
  paypal: ['paypal.com', 'paypal.me'],
  google: ['google.com', 'google.co.in', 'g.co', 'goo.gle', 'youtube.com', 'youtu.be', 'gmail.com'],
  apple: ['apple.com', 'icloud.com', 'apple.co'],
  microsoft: ['microsoft.com', 'live.com', 'office.com', 'outlook.com', 'microsoftonline.com', 'aka.ms'],
  netflix: ['netflix.com'],
  whatsapp: ['whatsapp.com', 'wa.me', 'whatsapp.net'],
  facebook: ['facebook.com', 'fb.com', 'fb.me', 'meta.com'],
  instagram: ['instagram.com'],
  irctc: ['irctc.co.in'],
  incometax: ['incometax.gov.in'],
  uidai: ['uidai.gov.in'],
  aadhaar: ['uidai.gov.in'],
  epfo: ['epfindia.gov.in'],
  indiapost: ['indiapost.gov.in'],
  fedex: ['fedex.com'],
  dhl: ['dhl.com', 'dhl.co.in'],
  bluedart: ['bluedart.com'],
  airtel: ['airtel.in', 'airtel.com'],
  jio: ['jio.com'],
};
const SHORTENERS = new Set(['bit.ly', 'tinyurl.com', 'cutt.ly', 'is.gd', 'rb.gy', 'shorturl.at', 'goo.gl', 'ow.ly', 'tiny.cc',
  'rebrand.ly', 's.id', 'v.gd', 'bitly.com', 't.ly', 'shorte.st', 'adf.ly', 'u.to', 'qr.ae', 'surl.li', 'tinyurl.at']);
// Endings cheap enough that scams favour them; a real company's link rarely uses one.
const CHEAP_ENDINGS = /\.(xyz|top|click|icu|buzz|rest|cfd|sbs|monster|zip|mov|gq|tk|ml|cf|ga|work|live|support|cyou|bond|lat|win|loan|vip)$/;
// Two-part endings, so "sbi.co.in" is the domain and not "co.in".
const TWO_PART = /\.(co|gov|org|net|ac|nic|res|edu|com)\.(in|uk|au|nz|za|jp)$/;

// Words scams use to rush or scare people, and things no real company asks for over a link.
const PRESSURE = /\b(blocked|suspended|deactivat\w*|expir\w*|last (chance|warning|day)|immediately|urgent\w*|within 24 ?h\w*|disconnect\w*|penalty|legal action|account (will be|is) (closed|locked|on hold))\b/i;
const BAIT = /\b(won|winner|lottery|prize|cash ?back|reward points?|refund|free (gift|recharge)|claim (your|now)|lucky draw|selected for|work from home.{0,20}(earn|daily))\b/i;
const ASKS_SECRETS = /\b(kyc|pan (card )?update|update (your )?(pan|kyc|aadhaar|bank details)|otp|one[- ]?time password|cvv|card (number|details)|upi pin|net ?banking (password|login)|password|verify your account)\b/i;

const LINK = /\b((?:https?:\/\/|www\.)[^\s<>"']+|(?:[a-z0-9-]+\.)+(?:[a-z]{2,24})(?:\/[^\s<>"']*)?)/gi;

// The links in a piece of text, as written (trailing punctuation dropped). Bare "word.word" only counts with a
// real-looking ending, so "e.g." and "5.30" aren't links.
export function findLinks(text) {
  const found = [];
  for (const match of String(text ?? '').matchAll(LINK)) {
    const link = match[0].replace(/[).,!?;:'"\]]+$/, '');
    const host = hostOf(link);
    const numbered = /^https?:\/\//i.test(link) && /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
    if (!host || !(numbered || /\.[a-z]{2,24}$/.test(host))) continue;
    if (!/^(https?:\/\/|www\.)/i.test(link) && !/\.(com|in|net|org|co|me|ly|gd|to|io|app|info|biz|link|site|online|xyz|top|click|icu|buzz|live|shop|gl|at|id|cc|it|be|ms|me|ae|li)$/.test(host)) continue;
    if (!found.includes(link)) found.push(link);
  }
  return found.slice(0, 5);
}

function hostOf(link) {
  try {
    const url = new URL(/^https?:\/\//i.test(link) ? link : `http://${link}`);
    return url.hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return '';
  }
}

export function registeredDomain(host) {
  const parts = host.split('.');
  return parts.slice(TWO_PART.test(host) ? -3 : -2).join('.');
}

// amaz0n, paypa1, rnicrosoft: read as they look.
const asLooks = text => text.replace(/0/g, 'o').replace(/1/g, 'l').replace(/3/g, 'e').replace(/5/g, 's').replace(/rn/g, 'm').replace(/vv/g, 'w');

// { link, host, verdict: 'risky' | 'careful' | 'looks-real' | 'unknown', reasons: [...] } for one link;
// `around` is the message it came in, for the scare and bait words.
export function checkLink(link, around = '') {
  const host = hostOf(link);
  const reasons = [];
  let strong = 0;
  let weak = 0;
  const flag = (reason, isStrong) => { reasons.push(reason); if (isStrong) strong++; else weak++; };
  if (!host) return { link, host, verdict: 'unknown', reasons: ["it isn't a link that can be read"] };
  const domain = registeredDomain(host);
  const name = asLooks(host.replace(/\.[a-z]+$/, ''));
  const official = Object.values(BRANDS).flat().some(d => host === d || host.endsWith(`.${d}`));

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) flag('it goes to a bare number instead of a site name', true);
  if (host.includes('xn--')) flag('the address uses look-alike letters from another alphabet', true);
  if (/@/.test(link.replace(/^https?:\/\//i, '').split('/')[0])) flag('it hides the real address behind an @', true);
  if (/\.apk(\?|$)/i.test(link)) flag('it downloads an app file, which can take over a phone', true);
  if (!official) {
    const pretends = Object.keys(BRANDS).find(brand => name.split(/[.-]/).some(part => part === brand
      || (brand.length >= 4 && part.startsWith(brand)) || (brand.length >= 6 && part.includes(brand))));
    if (pretends) flag(`it uses the name ${pretends.toUpperCase()} but isn't ${pretends.toUpperCase()}'s real site`, true);
  }
  if (SHORTENERS.has(domain) || SHORTENERS.has(host)) flag('it is a shortened link, so the real address is hidden', false);
  if (CHEAP_ENDINGS.test(host)) flag(`it ends in .${host.split('.').pop()}, an ending scams often use`, false);
  if (host.split('.').length > 4 || host.length > 40) flag('the address is unusually long', false);
  if ((host.match(/-/g) ?? []).length >= 3) flag('the address is strung together with dashes', false);
  if (/^http:\/\//i.test(link) && !official) flag("it isn't a secure (https) link", false);

  const words = String(around);
  const pressure = PRESSURE.test(words);
  const bait = BAIT.test(words);
  const secrets = ASKS_SECRETS.test(words);
  if (!official && (pressure || bait || secrets)) {
    if (secrets) flag('the message asks for details like KYC, a PIN, a password or an OTP through a link', true);
    if (pressure) flag('the message tries to rush or scare them', false);
    if (bait) flag('the message promises a prize, refund or easy money', false);
  }

  let verdict = 'unknown';
  if (strong || weak >= 2) verdict = 'risky';
  else if (weak) verdict = 'careful';
  else if (official) verdict = 'looks-real';
  return { link, host, verdict, reasons };
}

// A short note for a message with links, or '' when nothing about them stands out.
export function linkNote(text) {
  const checks = findLinks(text).map(link => checkLink(link, text));
  const risky = checks.filter(c => c.verdict === 'risky');
  const careful = checks.filter(c => c.verdict === 'careful');
  if (risky.length) return `LINK LOOKS LIKE A SCAM: ${risky[0].host}, because ${risky[0].reasons.slice(0, 3).join('; ')}`;
  if (careful.length) return `link needs care: ${careful[0].host}, ${careful[0].reasons[0]}`;
  return '';
}
