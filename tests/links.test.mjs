// Checks docs/js/links.js: scam links in messages are caught, and everyday links and text are left alone.
// Run: npm test
import { pathToFileURL, fileURLToPath } from 'node:url';
const repo = fileURLToPath(new URL('..', import.meta.url)).replace(/[\/]$/, '');
import assert from 'node:assert/strict';
const { findLinks, checkLink, linkNote, registeredDomain } = await import(pathToFileURL(`${repo}/docs/js/links.js`));

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log('ok  ', name); } catch (err) { failed++; console.log('FAIL', name, '\n     ', err.message); }
};
const verdict = (link, around) => checkLink(link, around).verdict;

console.log('-- finding links');
check('a full link', () => assert.deepEqual(findLinks('see https://example.com/a?b=1.'), ['https://example.com/a?b=1']));
check('a bare one', () => assert.deepEqual(findLinks('go to sbi-kyc-update.xyz now'), ['sbi-kyc-update.xyz']));
check('not "e.g." or times or amounts', () => assert.deepEqual(findLinks('e.g. at 5.30, Rs. 1.5 lakh, file.txt'), []));
check('two-part endings', () => assert.equal(registeredDomain('www.onlinesbi.sbi.co.in'), 'sbi.co.in'));

console.log('-- scams are caught');
const scams = [
  ['Dear customer your SBI account will be blocked today. Update KYC: http://sbi-kyc-update.xyz/login', 'a fake bank KYC'],
  ['Your HDFC netbanking is suspended. Verify at https://hdfcbank-secure-login.top', 'a fake HDFC site'],
  ['Congratulations! You won an Amazon lucky draw, claim now: amaz0n-gift.in/claim', 'a look-alike spelling'],
  ['Your parcel is on hold, pay Rs 25: http://192.168.4.7/indiapost', 'a bare number address'],
  ['Install the new WhatsApp gold: https://files.example.net/whatsapp-gold.apk', 'an app download'],
  ['Electricity will be disconnected tonight, update here bit.ly/3xYz12', 'a shortened link with a threat'],
  ['Login to see the document https://www.google.com@evil.example.ru/', 'an @ hiding the address'],
  ['Your refund is ready https://xn--pypal-4ve.com/refund', 'look-alike letters'],
];
for (const [text, what] of scams) check(`${what}`, () => assert.match(linkNote(text), /LINK LOOKS LIKE A SCAM/));
check('the reason names the brand it pretends to be', () => assert.match(linkNote(scams[0][0]), /SBI/));

console.log('-- everyday links are left alone');
const fine = [
  'Here is the doc https://docs.google.com/document/d/abc',
  'Your Amazon order has shipped: https://www.amazon.in/gp/your-account/order-details',
  'Meeting link https://teams.microsoft.com/l/meetup-join/xyz',
  'Pay via https://paytm.com/offer',
  'Check this out https://www.youtube.com/watch?v=abc',
  'pineapple recipe at https://pineapple-recipes.com/cake',
  'Hey are we still on for 5.30? Bring the file.',
];
for (const text of fine) check(`no warning: ${text.slice(0, 40)}`, () => assert.equal(linkNote(text), ''));
check('a real bank site looks real', () => assert.equal(verdict('https://www.onlinesbi.sbi/'), 'looks-real'));
check('a real site still looks real with scary words', () => assert.equal(verdict('https://www.hdfcbank.com', 'your account is blocked'), 'looks-real'));
check('a shortener alone only needs care', () => assert.equal(verdict('https://bit.ly/abc', 'photos from the trip'), 'careful'));
check('an unknown site is not called safe', () => assert.equal(verdict('https://some-blog.com/post'), 'unknown'));

process.exit(failed ? 1 : 0);
