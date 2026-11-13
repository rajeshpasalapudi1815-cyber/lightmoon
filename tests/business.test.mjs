// Checks docs/js/business.js: the business brief LightMoon loads, what it says about the businesses without the AI,
// what the AI is told, and which pages it watches. The brief here is made up. Run: npm test
import assert from 'node:assert/strict';
const mem = new Map();
globalThis.localStorage = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k) };
const { pathToFileURL, fileURLToPath } = await import('node:url');
const repo = fileURLToPath(new URL('..', import.meta.url)).replace(/[\/]$/, '');
const b = await import(pathToFileURL(`${repo}/docs/js/business.js`));
let failed = 0;
const test = (name, fn) => {
  try { fn(); console.log('ok  ', name); } catch (err) { failed++; console.log('FAIL', name, '\n     ', err.message); }
};

const FILE = JSON.stringify({
  updated: '13 November 2026',
  focus: ['PlantPal'],
  needs_you: ['Buy the web address', 'Choose the price'],
  products: [
    { name: 'PlantPal', what: 'Reminds people to water their plants', for: 'People with houseplants', stage: 'working', status: 'Sign-in and reminders work; payments are not connected', next: ['Connect payments', 'Put it on the internet'], needs_you: ['Open a payments account'], site: 'https://plantpal.example/', about: 'One plan at 3 dollars a month; a 14-day free trial' },
    { name: 'Book Nook', what: 'A shelf where a street lends its books', for: 'Neighbours', stage: 'demo', status: 'A clickable demo only' },
    { name: 'Old Idea', what: 'Something set aside', stage: 'parked', site: 'https://old.example/' },
    { name: '', what: 'no name: dropped' },
  ],
});

test('a brief is tidied as it is loaded, and anything that is not one is refused in plain words', () => {
  const brief = b.parseBrief(FILE);
  assert.deepEqual(brief.products.map(p => p.name), ['PlantPal', 'Book Nook', 'Old Idea']);
  assert.deepEqual(brief.focus, ['PlantPal']);
  assert.equal(brief.products[1].stage, 'demo');
  assert.throws(() => b.parseBrief('not json'), /isn't a business brief/);
  assert.throws(() => b.parseBrief('{"hello":1}'), /no list of products/);
  assert.throws(() => b.parseBrief('{"products":[{"what":"x"}]}'), /no products/);
  const huge = b.parseBrief(JSON.stringify({ products: Array.from({ length: 50 }, (_, i) => ({ name: `P${i}`, what: 'x'.repeat(5000), site: 'http://not-https.example', stage: 'made-up' })) }));
  assert.equal(huge.products.length, b.MAX_PRODUCTS);
  assert.equal(huge.products[0].what.length, 220);
  assert.equal(huge.products[0].site, '', 'only https pages');
  assert.equal(huge.products[0].stage, 'idea', 'an unknown stage is just an idea');
  const onServer = b.parseBrief(JSON.stringify({ products: [{ name: 'Trial', stage: 'testing', status: 'Nothing is sent to real phones yet' }] }));
  assert.equal(b.businessReport({ kind: 'one', product: onServer.products[0] }, onServer), 'Trial is running in test mode. Nothing is sent to real phones yet.');
});

test('it is kept, and comes back the same', () => {
  assert.equal(b.brief(), null);
  b.saveBrief(FILE);
  const kept = b.brief();
  assert.equal(kept.products[0].needsYou[0], 'Open a payments account');
  assert.deepEqual(kept.needsYou, ['Buy the web address', 'Choose the price']);
});

test('which talk is about their businesses', () => {
  for (const said of ['how are my businesses', 'any new customers?', 'what about plantpal', 'is Plant Pal live', 'tell me about book nook']) assert.ok(b.aboutBusiness(said), said);
  for (const said of ['what time is it', 'remind me to call mom', 'play some music']) assert.ok(!b.aboutBusiness(said), said);
  assert.equal(b.productNamed('status of plant pal please').name, 'PlantPal');
  assert.equal(b.productNamed('booknook?').name, 'Book Nook');
});

test('asked for at once, without the AI', () => {
  for (const said of ['business status', 'how are my businesses doing', 'status of my startups', 'give me a business update', 'LightMoon, business report']) assert.deepEqual(b.businessAsked(said), { kind: 'all' }, said);
  for (const said of ['what are my products', 'list my businesses']) assert.deepEqual(b.businessAsked(said), { kind: 'names' }, said);
  for (const said of ['what do my businesses need from me', 'what are my businesses waiting on', 'what needs me for my startups', 'business decisions']) assert.deepEqual(b.businessAsked(said), { kind: 'todo' }, said);
  for (const said of ['what needs me', 'what is waiting on me']) assert.equal(b.businessAsked(said), null, `${said}: about their day, not their businesses`);
  for (const said of ['status of PlantPal', 'how is plant pal doing', "what's next for PlantPal", 'PlantPal']) assert.equal(b.businessAsked(said)?.product?.name, 'PlantPal', said);
  for (const said of ['write a pricing page for PlantPal', 'email the PlantPal prospects about the launch', 'what time is it', 'status report']) assert.equal(b.businessAsked(said), null, said);
});

test('what it says', () => {
  const say = text => b.businessReport(b.businessAsked(text), b.brief(), { address: 'boss' });
  assert.equal(say('status of PlantPal'), 'PlantPal is working on your computer. Sign-in and reminders work; payments are not connected. Next: Connect payments; Put it on the internet. Waiting on you: Open a payments account.');
  assert.equal(say('what are my products'), 'You have three products: PlantPal, Book Nook and Old Idea.');
  assert.equal(say('what do my businesses need from me'), 'Three things are waiting on you, boss. Buy the web address. Choose the price. PlantPal: Open a payments account.');
  const all = say('business status');
  assert.match(all, /^You have three products, boss\. In focus: PlantPal\. PlantPal is working on your computer\./);
  assert.match(all, /The others wait: Book Nook and Old Idea\./);
  assert.match(all, /Sign-in and reminders work; payments are not connected\. Next: Connect payments\. The others wait/, 'the overview is heard: one next step each, not the whole list');
  assert.match(all, /Three things are waiting on you; ask me what your businesses need\./);
  assert.match(all, /That is as of 13 November 2026\.$/);
});

test('with no brief it says so instead of guessing', () => {
  assert.equal(b.businessReport({ kind: 'all' }, null), "I don't know your businesses yet. Load the brief in Settings, Your businesses, and I will.");
});

test('what the AI is told: the ones in focus in full, the rest in a line, and never to invent', () => {
  const told = b.briefSection();
  assert.match(told, /^THEIR BUSINESSES \(what you know of them, as of 13 November 2026\)\. You do not build these products/);
  assert.match(told, /Never invent progress, customers, figures or dates/);
  assert.match(told, /- PlantPal \(working on your computer\): Reminds people to water their plants\. For: People with houseplants\. Now: Sign-in and reminders work/);
  assert.match(told, /What its page says: One plan at 3 dollars a month/);
  assert.match(told, /- Book Nook \(a clickable demo\): A shelf where a street lends its books\.$/m, 'not in focus: one line');
  assert.ok(told.length < 1500, `small enough to send (${told.length})`);
});

test('pages to watch: those on the internet, not the parked ones', () => {
  assert.deepEqual(b.pagesToWatch(), [{ name: 'PlantPal', url: 'https://plantpal.example/' }]);
});

test('forgetting it', () => {
  b.forgetBrief();
  assert.equal(b.brief(), null);
  assert.ok(!b.aboutBusiness('how are my businesses'), 'nothing to say about business without a brief');
});

if (failed) { console.log(`${failed} failed`); process.exit(1); }
