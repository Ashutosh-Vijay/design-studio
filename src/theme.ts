// Theme and accent, as in DataWeave Studio (accents.ts + ThemeContext), without the VS Code parts.
// Called before React mounts too, so the first paint already has the saved theme.

export type ThemePref = 'dark' | 'light' | 'system';

export const ACCENTS = [
  { id: 'emerald', hue: 158, chroma: 0.15, name: 'Emerald' },
  { id: 'sky', hue: 220, chroma: 0.13, name: 'Sky' },
  { id: 'violet', hue: 290, chroma: 0.14, name: 'Violet' },
  { id: 'amber', hue: 80, chroma: 0.14, name: 'Amber' },
  { id: 'rose', hue: 20, chroma: 0.18, name: 'Rose' },
];

export function savedTheme(): { pref: ThemePref; accent: string } {
  let pref: ThemePref = 'dark', accent = 'emerald';
  try {
    const p = localStorage.getItem('ads.theme');
    if (p === 'dark' || p === 'light' || p === 'system') pref = p;
    accent = localStorage.getItem('ads.accent') || 'emerald';
  } catch { /* storage can be unavailable; defaults are fine */ }
  return { pref, accent };
}

export const isDarkPref = (pref: ThemePref) =>
  pref === 'system' ? !window.matchMedia('(prefers-color-scheme: light)').matches : pref === 'dark';

export function applyTheme(pref: ThemePref, accentId: string) {
  const dark = isDarkPref(pref);
  const root = document.documentElement;
  root.classList.toggle('light', !dark);
  root.style.colorScheme = dark ? 'dark' : 'light';
  // Light and dark need different lightness for the same hue to stay legible.
  const a = ACCENTS.find((x) => x.id === accentId) ?? ACCENTS[0];
  const l = dark ? 72 : 55, hl = dark ? 78 : 50;
  root.style.setProperty('--accent', `oklch(${l}% ${a.chroma} ${a.hue})`);
  root.style.setProperty('--accent-hover', `oklch(${hl}% ${a.chroma} ${a.hue})`);
  root.style.setProperty('--accent-dim', `oklch(${l}% ${a.chroma} ${a.hue} / ${dark ? 0.14 : 0.1})`);
  root.style.setProperty('--accent-border', `oklch(${l}% ${a.chroma} ${a.hue} / 0.32)`);
  root.style.setProperty('--selection-bg', `oklch(${l}% ${a.chroma} ${a.hue} / ${dark ? 0.35 : 0.25})`);
  try { localStorage.setItem('ads.theme', pref); localStorage.setItem('ads.accent', accentId); } catch { /* ignore */ }
}

// Shortcuts as they're shown: Ctrl is Cmd on a Mac. Every shortcut in a tooltip, a menu or the palette goes through K.
export const MAC = typeof navigator !== 'undefined' && /Mac/.test(navigator.userAgent);
export const K = (keys: string) => (MAC ? keys.replace(/\bCtrl\b/g, 'Cmd') : keys);
