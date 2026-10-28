// App lock: a PIN (stored only as a salted hash) plus, optionally, the phone's own fingerprint or face unlock.
// It keeps other people out of the app; it does not encrypt what is stored on the device.
const LOCK_KEY = 'assistant.lock'; // kept apart from the data so backups never carry the lock
const PBKDF2_ITERATIONS = 210_000;
const MAX_TRIES = 5;
const COOLDOWN_MS = 30_000;

function read() {
  try {
    return JSON.parse(localStorage.getItem(LOCK_KEY) || 'null');
  } catch {
    return null;
  }
}

const write = value => localStorage.setItem(LOCK_KEY, JSON.stringify(value));
const random = size => crypto.getRandomValues(new Uint8Array(size));
const toBase64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const fromBase64 = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));

export const isEnabled = () => Boolean(read()?.pinHash);
export const hasBiometric = () => Boolean(read()?.credentialId);

export async function biometricAvailable() {
  try {
    return Boolean(await window.PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable?.());
  } catch {
    return false;
  }
}

async function hashPin(pin, salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' }, key, 256);
  return toBase64(bits);
}

export async function setPin(pin) {
  if (!/^\d{4,8}$/.test(pin)) throw new Error('Use 4 to 8 digits for your PIN.');
  const salt = random(16);
  write({ ...read(), pinHash: await hashPin(pin, salt), salt: toBase64(salt), tries: 0, lockedUntil: 0 });
}

// True when the PIN is right. After too many wrong tries, PIN entry pauses for a short while.
export async function checkPin(pin) {
  const lock = read();
  if (!lock?.pinHash) return true;
  const wait = (lock.lockedUntil ?? 0) - Date.now();
  if (wait > 0) throw new Error(`Too many wrong tries. Wait ${Math.ceil(wait / 1000)} seconds.`);
  const ok = (await hashPin(pin, fromBase64(lock.salt))) === lock.pinHash;
  const tries = ok ? 0 : (lock.tries ?? 0) + 1;
  const pause = tries >= MAX_TRIES;
  write({ ...lock, tries: pause ? 0 : tries, lockedUntil: pause ? Date.now() + COOLDOWN_MS : 0 });
  return ok;
}

// Registers the phone's screen lock (fingerprint, face or pattern) as a way to open the app.
export async function enrollBiometric(userName) {
  const name = userName || 'LightMoon';
  const credential = await navigator.credentials.create({
    publicKey: {
      challenge: random(32),
      rp: { name: 'LightMoon' },
      user: { id: random(16), name, displayName: name },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
      timeout: 60_000,
      attestation: 'none',
    },
  });
  write({ ...read(), credentialId: toBase64(credential.rawId) });
}

// Resolves only after the phone has verified the owner.
export async function unlockWithBiometric() {
  const credentialId = read()?.credentialId;
  if (!credentialId) throw new Error('Fingerprint unlock is not set up.');
  await navigator.credentials.get({
    publicKey: {
      challenge: random(32),
      allowCredentials: [{ type: 'public-key', id: fromBase64(credentialId), transports: ['internal'] }],
      userVerification: 'required',
      timeout: 60_000,
    },
  });
}

export function disable() {
  localStorage.removeItem(LOCK_KEY);
}
