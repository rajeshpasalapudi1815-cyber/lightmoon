// LightMoon's face: two eyes in place of the old spinning rings. They follow what LightMoon is doing (the page's
// body[data-state]) and behave like someone paying attention:
//   - awake: open, blinking now and then, glancing about, and looking towards the pointer on a computer
//   - resting: after a while with nothing to do they close into two soft curves that breathe; anything opens them
//   - listening: wide open and warm (amber), pupils big, looking straight at you
//   - thinking: narrowed and violet, looking up and away, the iris turning
//   - speaking: a smiling squint, the iris brightening with the words
// Drawn as one SVG (two almond eyes clipped by their lids), moved a little each frame; colours come from styles.css
// (.eyes[data-mood]). Opening on start-up: mountEyes(host, { intro: true }).

const SVG = 'http://www.w3.org/2000/svg';
const EYES = [72, 168]; // centres across a 240 x 120 face
const MID = 60;
const HALF_WIDTH = 44;
const HALF_HEIGHT = 30; // lid height when fully open
const LOOK_X = 13, LOOK_Y = 8; // how far the irises move
const REST_AFTER_MS = 12_000;
const calm = matchMedia('(prefers-reduced-motion: reduce)');
const finePointer = matchMedia('(pointer: fine)');

// How each state holds the face: top / bottom lid opening (1 = fully open), pupil size, iris turn speed.
const POSES = {
  awake:     { top: 1, bottom: 1, pupil: 1, spin: 0.15 },
  resting:   { top: 0, bottom: 0, pupil: 0.9, spin: 0.05 },
  listening: { top: 1.12, bottom: 1.05, pupil: 1.35, spin: 0.3 },
  thinking:  { top: 0.7, bottom: 0.82, pupil: 0.8, spin: 2.6 },
  speaking:  { top: 0.96, bottom: 0.58, pupil: 1.05, spin: 0.4 },
};

const node = (name, attrs = {}, parent) => {
  const el = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  parent?.append(el);
  return el;
};

// The almond outline of one eye. Shut, both lids bend into the same downward curve: a contented, closed eye.
function lidPath(cx, top, bottom) {
  const up = MID - 2 * (HALF_HEIGHT * top - 4 * (1 - top));
  const down = MID + 2 * (HALF_HEIGHT * bottom + 4 * (1 - bottom));
  const l = cx - HALF_WIDTH, r = cx + HALF_WIDTH;
  return `M${l} ${MID}Q${cx} ${up.toFixed(2)} ${r} ${MID}Q${cx} ${down.toFixed(2)} ${l} ${MID}Z`;
}

let count = 0;

export function mountEyes(host, { intro = false, rest = true } = {}) {
  const id = `eyes${++count}`;
  for (const child of [...host.children]) child.remove();
  const svg = node('svg', { viewBox: '0 0 240 120', class: 'eyes', 'aria-hidden': 'true', focusable: 'false' });
  const defs = node('defs', {}, svg);
  const glass = node('radialGradient', { id: `${id}g`, cx: '50%', cy: '42%', r: '65%' }, defs);
  node('stop', { offset: '0', class: 'glass-in' }, glass);
  node('stop', { offset: '1', class: 'glass-out' }, glass);
  const iris = node('radialGradient', { id: `${id}i`, cx: '50%', cy: '50%', r: '50%' }, defs);
  node('stop', { offset: '0.28', 'stop-color': 'var(--eye-core)' }, iris);
  node('stop', { offset: '0.62', 'stop-color': 'currentColor' }, iris);
  node('stop', { offset: '1', 'stop-color': 'currentColor', 'stop-opacity': '0.15' }, iris);

  const parts = EYES.map((cx, i) => {
    const clip = node('clipPath', { id: `${id}c${i}` }, defs);
    const shape = node('path', {}, clip);
    const eye = node('g', { class: 'eye' }, svg);
    const inside = node('g', { 'clip-path': `url(#${id}c${i})` }, eye);
    node('rect', { x: cx - HALF_WIDTH, y: MID - 40, width: HALF_WIDTH * 2, height: 80, fill: `url(#${id}g)` }, inside);
    const look = node('g', {}, inside);
    node('circle', { cx, cy: MID, r: 23, class: 'iris-halo' }, look);
    node('circle', { cx, cy: MID, r: 20, fill: `url(#${id}i)` }, look);
    const ring = node('circle', { cx, cy: MID, r: 15, class: 'iris-ring' }, look);
    const pupil = node('circle', { cx, cy: MID, r: 7.5, class: 'pupil' }, look);
    node('circle', { cx: cx - 6, cy: MID - 7, r: 3.2, class: 'shine' }, look);
    node('circle', { cx: cx + 5, cy: MID + 5, r: 1.4, class: 'shine' }, look);
    const outline = node('path', { class: 'lid' }, eye);
    return { cx, shape, outline, look, ring, pupil };
  });
  host.append(svg);

  // Where the face is now (eased towards the pose each frame).
  const now = { top: intro ? 0 : 1, bottom: intro ? 0 : 1, pupil: 1, x: 0, y: 0, glow: 0 };
  let mood = intro ? 'resting' : 'awake';
  let lastActive = performance.now();
  let blinkAt = 0, blinkStart = -1;
  let glanceAt = 0, glance = { x: 0, y: 0 };
  let pointer = null, pointerAt = 0;
  let spin = 0, talk = 0, talkTarget = 0, talkAt = 0;
  let lastFrame = performance.now();
  let frame = 0;

  const pageState = () => document.body.dataset.state || 'idle';
  const wake = () => {
    lastActive = performance.now();
    if (mood === 'resting') blinkStart = -1; // open without a blink first
  };

  function pick(t) {
    const state = pageState();
    if (state !== 'idle') lastActive = t;
    if (state === 'listening' || state === 'thinking' || state === 'speaking') return state;
    if (intro && t - lastActive < 900) return 'resting'; // a moment shut, then they open on start-up
    return rest && t - lastActive > REST_AFTER_MS ? 'resting' : 'awake';
  }

  // Where the eyes want to look: at the pointer (computer), up and away while thinking, else small glances.
  function aim(t) {
    if (mood === 'listening') return { x: 0, y: 0.05 };
    if (mood === 'thinking') {
      if (t > glanceAt) { glance = { x: glance.x > 0 ? -0.75 : 0.75, y: -0.75 }; glanceAt = t + 650 + Math.random() * 500; }
      return glance;
    }
    if (pointer && t - pointerAt < 4000 && mood === 'awake') {
      const box = svg.getBoundingClientRect();
      const dx = (pointer.x - (box.left + box.width / 2)) / Math.max(innerWidth / 2, 1);
      const dy = (pointer.y - (box.top + box.height / 2)) / Math.max(innerHeight / 2, 1);
      return { x: Math.max(-1, Math.min(1, dx * 1.6)), y: Math.max(-1, Math.min(1, dy * 1.6)) };
    }
    if (calm.matches || mood === 'resting') return { x: 0, y: 0 };
    if (t > glanceAt) {
      const still = Math.random() < 0.45; // often back to looking at you
      glance = still ? { x: 0, y: 0 } : { x: (Math.random() * 2 - 1) * 0.7, y: (Math.random() * 2 - 1) * 0.45 };
      glanceAt = t + 1400 + Math.random() * 2600;
    }
    return mood === 'speaking' ? { x: glance.x * 0.35, y: glance.y * 0.25 } : glance;
  }

  // 0 = lids where the pose has them, 1 = shut: down in 80 ms, up in 150 ms.
  function blink(t) {
    if (mood === 'resting' || calm.matches) return 0;
    if (blinkStart < 0 && t > blinkAt) {
      blinkStart = t;
      blinkAt = t + 2400 + Math.random() * 3800;
      if (Math.random() < 0.18) blinkAt = t + 260; // now and then a double blink
    }
    if (blinkStart < 0) return 0;
    const since = t - blinkStart;
    if (since < 80) return since / 80;
    if (since < 230) return 1 - (since - 80) / 150;
    blinkStart = -1;
    return 0;
  }

  function draw(t) {
    frame = requestAnimationFrame(draw);
    const dt = Math.min(100, t - lastFrame);
    lastFrame = t;
    if (!svg.isConnected || !svg.getClientRects().length) return; // out of sight (quick panel, settings)
    mood = pick(t);
    svg.dataset.mood = mood;
    const pose = POSES[mood];
    const ease = 1 - Math.exp(-dt / (mood === 'resting' ? 260 : 90));
    const want = aim(t);
    now.top += (pose.top - now.top) * ease;
    now.bottom += (pose.bottom - now.bottom) * ease;
    now.pupil += (pose.pupil - now.pupil) * ease;
    const look = 1 - Math.exp(-dt / (mood === 'thinking' ? 70 : 55)); // quick, like real eye movements
    now.x += (want.x - now.x) * look;
    now.y += (want.y - now.y) * look;
    spin = (spin + pose.spin * dt * 0.06) % 360;
    // Speaking: the iris swells a little with each "syllable".
    if (mood === 'speaking' && !calm.matches) {
      if (t > talkAt) { talkTarget = Math.random(); talkAt = t + 90 + Math.random() * 140; }
    } else talkTarget = 0;
    talk += (talkTarget - talk) * (1 - Math.exp(-dt / 60));
    const shut = blink(t);
    const breathe = mood === 'resting' ? 0.5 + 0.5 * Math.sin(t / 900) : 0;
    svg.style.setProperty('--breathe', breathe.toFixed(3));

    for (const [i, part] of parts.entries()) {
      const top = Math.max(0, now.top * (1 - shut));
      const bottom = Math.max(0, now.bottom * (1 - shut * 0.6));
      const d = lidPath(part.cx, top, bottom);
      part.shape.setAttribute('d', d);
      part.outline.setAttribute('d', d);
      const inward = mood === 'listening' ? (i ? -1.2 : 1.2) : 0; // a little cross-eyed focus on you
      const scale = 1 + talk * 0.07;
      part.look.setAttribute('transform', `translate(${(now.x * LOOK_X + inward).toFixed(2)} ${(now.y * LOOK_Y).toFixed(2)}) translate(${part.cx} ${MID}) scale(${scale.toFixed(3)}) translate(${-part.cx} ${-MID})`);
      part.pupil.setAttribute('r', (7.5 * now.pupil * (1 - talk * 0.12)).toFixed(2));
      part.ring.setAttribute('transform', `rotate(${(i ? -spin : spin).toFixed(1)} ${part.cx} ${MID})`);
    }
  }

  const onPointer = event => { pointer = { x: event.clientX, y: event.clientY }; pointerAt = performance.now(); if (finePointer.matches) wake(); };
  const onAny = () => wake();
  addEventListener('pointermove', onPointer, { passive: true });
  addEventListener('pointerdown', onAny, { passive: true });
  addEventListener('keydown', onAny);
  frame = requestAnimationFrame(draw);

  return {
    wake,
    // A quick blink, e.g. when tapped.
    blink() { blinkStart = performance.now(); },
    stop() {
      cancelAnimationFrame(frame);
      removeEventListener('pointermove', onPointer);
      removeEventListener('pointerdown', onAny);
      removeEventListener('keydown', onAny);
    },
  };
}
