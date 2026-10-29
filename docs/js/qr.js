// Pairing by QR code instead of typing a sync code: one device shows the code as a QR, the other scans it with its
// camera. Life Levelling's phone app scans the same QR to connect. Drawing works everywhere; scanning needs the
// browser's barcode reader (Android has it; Windows browsers don't, so a computer shows the QR and a phone scans it).
import qrcode from './vendor/qrcode.js';

const PREFIX = 'lightmoon-sync:';

export const pairingText = code => `${PREFIX}${code}`;

// The sync code in a scanned QR (or null): ours, or a bare code someone made a QR of.
export function codeFromScan(text) {
  const raw = String(text ?? '').trim();
  const code = raw.toLowerCase().startsWith(PREFIX) ? raw.slice(PREFIX.length) : raw;
  return /^[0-9A-Za-z]{4}(-?[0-9A-Za-z]{4}){4}$/.test(code) ? code : null;
}

// Draws `text` as a QR code on the canvas, black on white with a quiet border, `size` pixels square.
export function drawQr(canvas, text, size = 260) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount();
  const cell = Math.floor(size / (count + 8));
  const border = Math.floor((size - cell * count) / 2);
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, size, size);
  g.fillStyle = '#000';
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) if (qr.isDark(row, col)) g.fillRect(border + col * cell, border + row * cell, cell, cell);
  }
}

export const canScan = () => 'BarcodeDetector' in window && Boolean(navigator.mediaDevices?.getUserMedia);

// Opens the back camera in `video` and resolves with the first QR code's text; `signal` stops it.
export async function scanQr(video, signal) {
  const formats = await BarcodeDetector.getSupportedFormats().catch(() => []);
  if (!formats.includes('qr_code')) throw new Error("This device can't read QR codes. Type the code instead.");
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
  } catch {
    throw new Error('LightMoon needs the camera to scan. Allow it, or type the code instead.');
  }
  video.srcObject = stream;
  await video.play().catch(() => {});
  const detector = new BarcodeDetector({ formats: ['qr_code'] });
  try {
    while (!signal?.aborted) {
      const found = await detector.detect(video).catch(() => []);
      if (found[0]?.rawValue) return found[0].rawValue;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    return null;
  } finally {
    for (const track of stream.getTracks()) track.stop();
    video.srcObject = null;
  }
}
