// Their businesses, as LightMoon knows them: what each product is, who it is for, how far along it is, what comes
// next and what is waiting on them. LightMoon does not build the products (their Claude sessions do that); it keeps
// the overview: "how are my businesses", "status of PlantPal", "what needs me" are answered at once, without the AI,
// the AI is told about them when the talk turns to business, and the systems check watches that each product's page
// still answers.
// The knowledge arrives as a "brief": a small JSON file the overview session writes, loaded in Settings → Businesses
// and synced to their other devices like everything else (encrypted with the sync code). Nothing about their
// businesses is in LightMoon's own files, which are public. tests/business.test.mjs checks it.
import { settings } from './store.js';

const KEY = 'business_brief';
export const MAX_PRODUCTS = 20;
// How far along a product is, and how that is said.
export const STAGES = {
  idea: 'an idea so far',
  demo: 'a clickable demo',
  working: 'working on your computer',
  testing: 'running in test mode', // on a server, but not yet open to real customers
  live: 'live on the internet',
  users: 'live, with people using it',
  paying: 'live, with paying customers',
  parked: 'parked for now',
};

const clean = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const list = (value, most, max) => (Array.isArray(value) ? value : []).map(item => clean(item, max)).filter(Boolean).slice(0, most);
const webAddress = value => {
  try {
    const url = new URL(String(value ?? ''));
    return url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
};

// The brief as written in the file -> the brief as LightMoon keeps it (tidied, with ceilings on every length, so a
// huge or odd file can't bloat what is synced or sent to the AI). Throws a plain sentence when it isn't a brief.
export function parseBrief(text) {
  let raw;
  try {
    raw = typeof text === 'string' ? JSON.parse(text) : text;
  } catch {
    throw new Error("That isn't a business brief: the file can't be read as one.");
  }
  if (!raw || !Array.isArray(raw.products)) throw new Error("That isn't a business brief: it has no list of products.");
  const products = raw.products.slice(0, MAX_PRODUCTS).map(p => ({
    name: clean(p?.name, 40),
    what: clean(p?.what, 220),
    for: clean(p?.for, 160),
    stage: Object.hasOwn(STAGES, p?.stage) ? p.stage : 'idea',
    status: clean(p?.status, 320),
    next: list(p?.next, 5, 180),
    needsYou: list(p?.needs_you ?? p?.needsYou, 5, 220),
    site: webAddress(p?.site),
    about: clean(p?.about, 700), // what its website says and offers, for questions about it
  })).filter(p => p.name);
  if (!products.length) throw new Error("That brief has no products in it.");
  const names = new Set(products.map(p => p.name.toLowerCase()));
  return {
    updated: clean(raw.updated, 30),
    focus: list(raw.focus, 5, 40).filter(name => names.has(name.toLowerCase())),
    needsYou: list(raw.needs_you ?? raw.needsYou, 10, 240),
    products,
  };
}

// ---------- Kept on the device (and synced) ----------

export function brief() {
  try {
    const saved = settings.get(KEY);
    return saved ? parseBrief(saved) : null;
  } catch {
    return null;
  }
}
export function saveBrief(text) {
  const parsed = parseBrief(text);
  settings.set(KEY, JSON.stringify({ ...parsed, needs_you: parsed.needsYou, products: parsed.products.map(p => ({ ...p, needs_you: p.needsYou })) }));
  return parsed;
}
export function forgetBrief() {
  settings.set(KEY, '');
}

// ---------- Is the talk about their businesses? ----------

const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const BUSINESS_WORDS = /\b(business(?:es)?|start-?ups?|products?|customers?|clients?|prospects?|leads?|launch(?:ed|ing)?|sales|revenue|pricing|wait-?list|sign-?ups?|outreach)\b/i;
// A name as it may be heard: "PlantPal" is written "plant pal" by speech recognition, "Book Nook" as "booknook",
// so a space may come or go wherever the name has one or starts a new word with a capital.
const heardAs = name => name.split(/\s+|(?<=[\p{Ll}\p{N}])(?=\p{Lu})/u).filter(Boolean).map(escapeRegex).join('\\s*');
const namePattern = known => (known?.products.length
  ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${known.products.map(p => heardAs(p.name)).join('|')})(?![\\p{L}\\p{N}])`, 'iu')
  : null);
// The product a message names ("how is plant pal doing"), or null.
export function productNamed(text, known = brief()) {
  const match = namePattern(known)?.exec(String(text ?? ''));
  if (!match) return null;
  const said = match[0].toLowerCase().replace(/\s+/g, '');
  return known.products.find(p => p.name.toLowerCase().replace(/\s+/g, '') === said) ?? null;
}
export const aboutBusiness = (text, known = brief()) => Boolean(known) && (BUSINESS_WORDS.test(String(text ?? '')) || Boolean(productNamed(text, known)));

// ---------- What the AI is told, only when the talk is about business ----------

const sentence = text => (!text || /[.!?]$/.test(text) ? text : `${text}.`);
const inFocus = (known, product) => known.focus.some(name => name.toLowerCase() === product.name.toLowerCase());

export function briefSection(known = brief()) {
  if (!known) return '';
  const lines = [
    `THEIR BUSINESSES (what you know of them${known.updated ? `, as of ${known.updated}` : ''}). You do not build these products: their Claude sessions do. `
      + 'You keep the overview: say where things stand, what comes next and what is waiting on them, and remind them. Never invent progress, customers, figures or dates that are not here; if it is not here, say you do not know yet.',
  ];
  if (known.focus.length) lines.push(`In focus now: ${known.focus.join(', ')}. The rest wait.`);
  for (const p of known.products) {
    // The ones in focus in full; the rest in a line, to keep the request small.
    if (known.focus.length && !inFocus(known, p)) {
      lines.push(`- ${p.name} (${STAGES[p.stage]}): ${sentence(p.what)}`);
      continue;
    }
    lines.push([
      `- ${p.name} (${STAGES[p.stage]}): ${sentence(p.what)}`,
      p.for && `For: ${sentence(p.for)}`,
      p.status && `Now: ${sentence(p.status)}`,
      p.next.length && `Next: ${p.next.join('; ')}.`,
      p.needsYou.length && `Waiting on them: ${p.needsYou.join('; ')}.`,
      p.site && `Its page: ${p.site}`,
      p.about && `What its page says: ${sentence(p.about)}`,
    ].filter(Boolean).join(' '));
  }
  if (known.needsYou.length) lines.push(`Waiting on them, across all of it: ${known.needsYou.join('; ')}.`);
  return lines.join('\n');
}

// ---------- Asked for at once, without the AI ----------

const ALL = /^(?:(?:give me |tell me |what(?:'s| is) )?(?:the |my |a )?(?:business(?:es)?|start-?ups?|products?) (?:status|report|brief|update|overview|summary)|(?:status|report|brief|update|overview|summary) (?:of|on|for) (?:my |the |all (?:my |the )?)?(?:business(?:es)?|start-?ups?|products?)|how (?:are|is) (?:my |the |all (?:my |the )?)?(?:business(?:es)?|start-?ups?|products?)(?: doing| going| looking)?|where (?:do|are) (?:my |the )?(?:business(?:es)?|start-?ups?|products?) stand)$/i;
const NAMES = /^(?:what (?:are )?(?:my |the )?(?:business(?:es)?|start-?ups?|products?)(?: do i have| are there)?|(?:list|name|tell me)(?: me)? (?:all )?(?:my |the )?(?:business(?:es)?|start-?ups?|products?)|which (?:business(?:es)?|start-?ups?|products?) do i have)$/i;
const TODO = /^(?:what (?:do|does) (?:my |the )?(?:business(?:es)?|start-?ups?|products?) need(?: from me)?|what (?:needs|is waiting (?:on|for)) me (?:for|in|on|from) (?:my |the )?(?:business(?:es)?|start-?ups?|products?)|what (?:is|are) (?:my |the )?(?:business(?:es)?|start-?ups?|products?) (?:waiting|stuck|blocked) (?:on|for)|what should i do (?:next )?(?:for|on|about) (?:my |the )?(?:business(?:es)?|start-?ups?|products?)|what (?:is |are )?(?:my |the )?(?:business(?:es)?|start-?ups?|products?) (?:to-?dos?|decisions?)|(?:my )?(?:business(?:es)?|start-?ups?|products?) (?:to-?dos?|decisions))$/i;
const ONE = /^(?:(?:what(?:'s| is) )?(?:the )?(?:status|state|progress|update)(?: (?:of|on|for))?|how(?:'s| is)|where (?:is|are we (?:on|with))|what(?:'s| is) (?:next|left|happening) (?:for|on|with)|what(?:'s| is) (?:up with)|tell me about|what is|what's)\b/i;

const tidyAsk = text => String(text ?? '').normalize('NFC').trim().replace(/^(?:hey |hi |ok |okay )?light ?moon[, ]*/i, '').replace(/[.!?]+$/, '').replace(/\s+/g, ' ');

// Their message, when it asks about the businesses in a way LightMoon can answer from the brief:
// { kind: 'all' | 'names' | 'todo' } or { kind: 'one', product }, or null (the AI takes it).
export function businessAsked(text, known = brief()) {
  const said = tidyAsk(text);
  if (!said || said.split(' ').length > 14) return null;
  if (ALL.test(said)) return { kind: 'all' };
  if (NAMES.test(said)) return { kind: 'names' };
  if (TODO.test(said)) return { kind: 'todo' };
  const product = productNamed(said, known);
  if (!product) return null;
  // "Status of PlantPal", "how is PlantPal doing", "what's next for PlantPal", or just its name.
  const rest = said.replace(namePattern(known), ' ').replace(/\b(?:doing|going|coming along|looking|now|today|so far|please)\b/gi, ' ').replace(/\s+/g, ' ').trim();
  return !rest || ONE.test(rest) ? { kind: 'one', product } : null;
}

const count = n => ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'][n] ?? String(n);
const Count = n => count(n).replace(/^./, first => first.toUpperCase());
const joined = (items, word = 'and') => (items.length > 1 ? `${items.slice(0, -1).join(', ')} ${word} ${items.at(-1)}` : items[0] ?? '');
const NOT_LOADED = "I don't know your businesses yet. Load the brief in Settings, Your businesses, and I will.";

function aboutOne(p) {
  return [
    `${p.name} is ${STAGES[p.stage]}.`,
    sentence(p.status),
    p.next.length && `Next: ${sentence(p.next.slice(0, 3).join('; '))}`,
    p.needsYou.length && `Waiting on you: ${sentence(p.needsYou.join('; '))}`,
  ].filter(Boolean).join(' ');
}

// What LightMoon says. `address`: how it calls them.
export function businessReport(ask, known = brief(), { address = 'boss' } = {}) {
  if (!known) return NOT_LOADED;
  const { products } = known;
  if (ask.kind === 'one') return aboutOne(ask.product);
  if (ask.kind === 'names') return `You have ${count(products.length)} product${products.length === 1 ? '' : 's'}: ${joined(products.map(p => p.name))}.`;
  if (ask.kind === 'todo') {
    const waiting = waitingOnThem(known);
    return waiting.length ? `${waiting.length === 1 ? 'One thing is' : `${Count(waiting.length)} things are`} waiting on you, ${address}. ${waiting.map(sentence).join(' ')}` : `Nothing is waiting on you right now, ${address}.`;
  }
  // The overview is heard, not read, so each product gets a breath: where it stands and the very next step. Everything
  // else ("status of" one product, "what do my businesses need from me") is a question away.
  const focus = products.filter(p => inFocus(known, p));
  const told = focus.length ? focus : products.slice(0, 3);
  const rest = products.filter(p => !told.includes(p));
  const waiting = waitingOnThem(known).length;
  return [
    `You have ${count(products.length)} product${products.length === 1 ? '' : 's'}, ${address}.${focus.length ? ` In focus: ${joined(focus.map(p => p.name))}.` : ''}`,
    ...told.map(inShort),
    rest.length && `The others wait: ${joined(rest.map(p => p.name))}.`,
    waiting && `${waiting === 1 ? 'One thing is' : `${Count(waiting)} things are`} waiting on you; ask me what your businesses need.`,
    known.updated && `That is as of ${known.updated}.`,
  ].filter(Boolean).join(' ');
}

// What waits on them: what the brief lists across all of it, then what the products in focus need (every product's,
// when none is in focus). The overview counts this same list and "what do my businesses need from me" says it, so the
// two always agree.
const MAX_WAITING = 8;
function waitingOnThem(known) {
  const theirs = known.products.filter(p => !known.focus.length || inFocus(known, p));
  return [...new Set([...known.needsYou, ...theirs.flatMap(p => p.needsYou.map(item => `${p.name}: ${item}`))])].slice(0, MAX_WAITING);
}

const firstSentence = text => /^.*?[.!?](?=\s|$)/.exec(text)?.[0] ?? text;
function inShort(p) {
  return [
    `${p.name} is ${STAGES[p.stage]}.`,
    sentence(firstSentence(p.status)),
    p.next.length && `Next: ${sentence(p.next[0])}`,
  ].filter(Boolean).join(' ');
}

// ---------- Their pages, for the systems check ----------

// [{ name, url }]: each product that has a page on the internet.
export const pagesToWatch = (known = brief()) => (known?.products ?? []).filter(p => p.site && p.stage !== 'parked').map(p => ({ name: p.name, url: p.site }));
