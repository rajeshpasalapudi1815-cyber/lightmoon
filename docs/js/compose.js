// Messages written for the user in other personal apps (Telegram, Signal, Instagram...), ready for them to check
// and send, through the app's "share to" screen. Nothing is sent from here: the user picks the chat and taps Send.
// Work apps (Teams, Outlook) are not handled at all: company data stays out of LightMoon (tools.js WORK_APPS).
// Also: the last draft LightMoon opened, for "send it". tools.js runs the plan; tests/compose.test.mjs checks it.

import { either, NATIVE_YES_ONLY, NATIVE_SEND_NOW } from './language.js';

// The last draft LightMoon opened in an app the Send helper works in (Android packages), so "send it" can tap Send
// on that one, and only that one, for ten minutes.
export const SEND_APPS = {
  whatsapp: ['com.whatsapp', 'com.whatsapp.w4b'],
  email: ['com.google.android.gm'],
};
const DRAFT_FOR_MS = 10 * 60_000;
// A message that is only a yes ("yes", "ok send it", "haan ji", "sare"), nothing more: it answers LightMoon's
// read-back on the phone itself (tools.js quickReply). "Yes, but make it Friday" is not one.
const YES_ONLY_WORDS = /^[^\p{L}\p{M}\p{N}]*(?:(?:yes|yeah|yep|yup|ya|ok(?:ay)?|sure|haan|ha|ji|sare|sari|avunu|theek hai|go ahead|do it|confirm(?:ed)?|correct|please)[\s,.!]*)+(?:(?:send|pampu|pampinchu)(?:\s+(?:it|now|please|cheyyi|chey))*)?[^\p{L}\p{M}\p{N}]*$/iu;
// A plain "send it" (also in Telugu: "pampu", "send cheyyi"), answered without the AI (tools.js quickReply).
const SEND_NOW_WORDS = /^[^\p{L}\p{M}\p{N}]*(?:(?:ok(?:ay)?|yes|ya|haan|ha|sare|please|ji)[\s,.!]+)*(?:send|pampu|pampinchu)(?:\s+(?:it|that|this|now|please|cheyyi|chey|cheyandi|the (?:message|msg|mail|email|draft)))*[^\p{L}\p{M}\p{N}]*$/iu;
// Also in Telugu, Hindi or Tamil letters (language.js), when LightMoon listens in that language.
export const YES_ONLY = either(YES_ONLY_WORDS, NATIVE_YES_ONLY);
export const SEND_NOW = either(SEND_NOW_WORDS, NATIVE_SEND_NOW);
let lastDraft = null;
let draftListener = null;
// Told about each new draft (tools.js: the phone then listens for "send it" for a while).
export const onDraft = listener => { draftListener = listener; };
// chat: the chat it was typed into (when known), which must be the one on screen when Send is tapped.
export function rememberDraft(kind, text, chat = '') {
  lastDraft = SEND_APPS[kind] && String(text ?? '').trim() ? { kind, apps: SEND_APPS[kind], text: String(text).trim(), chat, at: Date.now() } : null;
  if (lastDraft) draftListener?.(lastDraft);
}
export const recentDraft = (now = Date.now()) => (lastDraft && now - lastDraft.at < DRAFT_FOR_MS ? lastDraft : null);

// A plan for compose_message: { kind: 'share', app, text, note } | { ask }.
export function planCompose({ app, to = '', text }) {
  const words = String(text ?? '').trim();
  const where = String(app ?? '').trim();
  if (!words) return { ask: 'What should the message say?' };
  if (!where) return { ask: 'Which app should it go in?' };
  return {
    kind: 'share', app: where, text: words,
    note: `${where} is open on its "share to" screen with the message in it (it's on the clipboard too): they pick ${to ? `the chat with ${to}` : 'the chat'} and tap Send. You can't pick the chat or send it for them.`,
  };
}
