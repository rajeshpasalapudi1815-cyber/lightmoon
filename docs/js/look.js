// The look chosen in Settings (Night HUD, Calm, Daylight, Forest, or Automatic), put on the page before it is
// drawn, so it never flashes the original look first. Loaded as a plain script in <head>; app.js calls
// window.applyLook(look) when it changes. The colours themselves are in styles.css (html[data-look]).
(function () {
  const BARS = { hud: '#04070d', calm: '#15161a', daylight: '#f6f4ef', forest: '#0d1512' };
  const dark = window.matchMedia('(prefers-color-scheme: dark)');

  function apply(look) {
    const chosen = look || 'hud';
    const shown = chosen === 'auto' ? (dark.matches ? 'calm' : 'daylight') : chosen;
    document.documentElement.dataset.look = shown;
    const bar = document.querySelector('meta[name="theme-color"]');
    if (bar) bar.setAttribute('content', BARS[shown] || BARS.hud);
    window.currentLook = chosen;
  }

  let saved = 'hud';
  try {
    saved = JSON.parse(localStorage.getItem('assistant.prefs') || '{}').look || 'hud';
  } catch (err) {
    // Unreadable preferences: the original look.
  }
  apply(saved);
  dark.addEventListener('change', () => {
    if (window.currentLook === 'auto') apply('auto');
  });
  window.applyLook = apply;
})();
