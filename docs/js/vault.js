// Encryption for sync. A sync code (100 random bits) gives two things: the space id the cloud files the
// data under, and the AES key that encrypts it on the device. The cloud never sees the code itself.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32: no I, L, O or U to misread
const CODE_LENGTH = 20;
const encoder = new TextEncoder();

const toHex = bytes => Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
const toBase64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const fromBase64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));

export function newSyncCode() {
  const chars = Array.from(crypto.getRandomValues(new Uint8Array(CODE_LENGTH)), byte => ALPHABET[byte % 32]);
  return chars.join('').match(/.{4}/g).join('-');
}

// Accepts the code however it was typed: any case, with or without dashes or spaces.
export function normalizeCode(text) {
  const clean = String(text ?? '').toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (clean.length !== CODE_LENGTH || [...clean].some(c => !ALPHABET.includes(c))) {
    throw new Error('That sync code looks wrong. It has 20 letters and numbers, like ABCD-EFGH-JKMN-PQRS-TVWX.');
  }
  return clean.match(/.{4}/g).join('-');
}

export async function spaceIdFor(code) {
  return toHex(await crypto.subtle.digest('SHA-256', encoder.encode(`lightmoon-space:${code}`)));
}

export async function keyFor(code) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(code), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('lightmoon-sync'), info: encoder.encode('data-key-v1') },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptJson(key, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(JSON.stringify(value)));
  const out = new Uint8Array(iv.length + cipher.byteLength);
  out.set(iv);
  out.set(new Uint8Array(cipher), iv.length);
  return toBase64(out);
}

export async function decryptJson(key, text) {
  const bytes = fromBase64(text);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, key, bytes.slice(12));
  return JSON.parse(new TextDecoder().decode(plain));
}
