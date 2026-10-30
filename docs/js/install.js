// The install page (install.html): one link for every device. It works out what opened it and offers the right
// way in: the APK on Android, the browser's own Install on computers, Add to Home Screen on iPhone and iPad.
import { drawQr } from './qr.js';

const REPO = 'rajeshpasalapudi1815-cyber/lightmoon';
const APK = `https://github.com/${REPO}/releases/latest/download/LightMoon.apk`;

const $ = selector => document.querySelector(selector);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};
const steps = items => {
  const list = el('ol');
  for (const item of items) list.append(el('li', '', item));
  return list;
};
const button = (text, href) => {
  const node = el(href ? 'a' : 'button', 'btn', text);
  if (href) node.href = href;
  else node.type = 'button';
  return node;
};

const ua = navigator.userAgent;
const android = /Android/i.test(ua);
// iPadOS says it's a Mac; a Mac with a touch screen is an iPad.
const apple = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
const installed = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true || Boolean(window.Capacitor);

function show(device, title, ...body) {
  $('#device').textContent = device;
  $('#mainTitle').textContent = title;
  $('#mainBody').replaceChildren(...body);
}

function showAndroid() {
  const download = button('Download LightMoon.apk', APK);
  const size = el('p', 'small', 'About 45 MB. Free, no Play Store needed.');
  show('Android', 'Install the Android app', download, size, steps([
    'Tap Download, then open the file when it finishes.',
    'If Android asks, allow your browser to install unknown apps, then tap Install.',
    'If Play Protect warns about an unknown app, tap More details → Install anyway.',
    'Open LightMoon and follow the first-run steps.',
  ]));
  $('#howAndroid').hidden = true;
  release().then(info => {
    if (info) size.textContent = `Version ${info.version}, ${info.megabytes} MB. Free, no Play Store needed.`;
  });
}

function showApple() {
  const safari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
  show(/iPad|Macintosh/.test(ua) ? 'iPad' : 'iPhone', 'Add LightMoon to your Home Screen', steps([
    ...(safari ? [] : ['Open this page in Safari (copy the address, or tap ⋯ → Open in Safari).']),
    'Tap the Share button (the square with an arrow) at the bottom of Safari.',
    'Scroll down and tap Add to Home Screen, then Add.',
    'Open LightMoon from its new icon.',
  ]), el('p', 'small', "Apple doesn't let apps like this hear a wake phrase or read your messages; on iPhone, tap LightMoon to talk."));
  $('#howIphone').hidden = true;
}

function showComputer() {
  const install = button('Install LightMoon');
  install.hidden = true;
  const help = el('div');
  const firefox = /Firefox/.test(ua);
  const macSafari = /Macintosh/.test(ua) && /Safari/.test(ua) && !/Chrome|Edg\//.test(ua);
  help.append(steps(firefox
    ? ["Firefox can't install apps. Open this page in Chrome or Edge to install LightMoon,", 'or just use it in a Firefox tab: it works the same.']
    : macSafari
      ? ['In the menu bar, choose File → Add to Dock.', 'Open LightMoon from the Dock.']
      : ['Click the install icon at the right end of the address bar (a screen with an arrow),', 'or in Edge: ⋯ → Apps → Install this site as an app; in Chrome: ⋮ → Cast, save and share → Install page as app.', 'LightMoon opens in its own window, with its own icon.']));
  show('Computer', 'Install on this computer', install, help);
  $('#howComputer').hidden = true;

  // Chrome and Edge offer their own install prompt: one click.
  let prompt = null;
  addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    prompt = event;
    install.hidden = false;
    help.hidden = true;
  });
  install.addEventListener('click', async () => {
    if (!prompt) return;
    prompt.prompt();
    const { outcome } = await prompt.userChoice;
    prompt = null;
    install.hidden = true;
    if (outcome !== 'accepted') help.hidden = false;
  });
  addEventListener('appinstalled', showInstalled);

  // Phones get the page from here by QR.
  $('#qrCard').hidden = false;
  const page = new URL('install.html', location.href).href;
  drawQr($('#qr'), page, 220);
  $('#pageLink').href = page;
  $('#pageLink').textContent = page;
}

function showInstalled() {
  show('Installed', 'LightMoon is installed', el('p', '', 'It has its own icon now. Open it from there, or:'), button('Open LightMoon', './'));
}

// The latest release's version and APK size from GitHub, or null.
async function release() {
  try {
    const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { signal: AbortSignal.timeout(6000) });
    if (!response.ok) return null;
    const data = await response.json();
    const apk = data.assets?.find(asset => asset.name === 'LightMoon.apk');
    return apk ? { version: String(data.tag_name ?? '').replace(/^v/, '').replace(/\.0$/, ''), megabytes: Math.round(apk.size / 1e6) } : null;
  } catch {
    return null;
  }
}

if (installed) showInstalled();
else if (android) showAndroid();
else if (apple) showApple();
else showComputer();

// The service worker makes LightMoon installable (and works offline once installed).
if (!window.Capacitor) navigator.serviceWorker?.register('./sw.js', { type: 'module', updateViaCache: 'none' }).catch(() => {});
