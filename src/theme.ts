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

// In VS Code, the editor's own theme: VS Code marks it on the webview's <body> (vscode-light, vscode-dark, high contrast).
const inVsCode = import.meta.env.VITE_VSCODE === '1';
const vscodeDark = () => {
  const c = document.body?.classList;
  return c?.contains('vscode-light') || c?.contains('vscode-high-contrast-light') ? false : c?.contains('vscode-dark') || c?.contains('vscode-high-contrast') ? true : null;
};
// Match VS Code theme (VS Code only, on unless turned off): its colours for surfaces, text, borders and the accent.
export const matchVsCode = () => { if (!inVsCode) return false; try { return localStorage.getItem('ads.matchVsCode') !== '0'; } catch { return true; } };

export const isDarkPref = (pref: ThemePref) =>
  pref === 'system' ? (inVsCode ? vscodeDark() ?? true : !window.matchMedia('(prefers-color-scheme: light)').matches) : pref === 'dark';

export function applyTheme(pref: ThemePref, accentId: string) {
  const match = matchVsCode();
  const dark = match ? vscodeDark() ?? true : isDarkPref(pref);
  const root = document.documentElement;
  root.classList.toggle('light', !dark);
  root.classList.toggle('ads-vscode-theme', match);
  root.style.colorScheme = dark ? 'dark' : 'light';
  try { localStorage.setItem('ads.theme', pref); localStorage.setItem('ads.accent', accentId); } catch { /* ignore */ }
  // VS Code's accent comes through the class; an inline one would win over it.
  if (match) { for (const p of ['--accent', '--accent-hover', '--accent-dim', '--accent-border', '--selection-bg']) root.style.removeProperty(p); return; }
  // Light and dark need different lightness for the same hue to stay legible.
  const a = ACCENTS.find((x) => x.id === accentId) ?? ACCENTS[0];
  const l = dark ? 72 : 55, hl = dark ? 78 : 50;
  root.style.setProperty('--accent', `oklch(${l}% ${a.chroma} ${a.hue})`);
  root.style.setProperty('--accent-hover', `oklch(${hl}% ${a.chroma} ${a.hue})`);
  root.style.setProperty('--accent-dim', `oklch(${l}% ${a.chroma} ${a.hue} / ${dark ? 0.14 : 0.1})`);
  root.style.setProperty('--accent-border', `oklch(${l}% ${a.chroma} ${a.hue} / 0.32)`);
  root.style.setProperty('--selection-bg', `oklch(${l}% ${a.chroma} ${a.hue} / ${dark ? 0.35 : 0.25})`);
}
// VS Code switches theme by changing the <body>'s class: follow it while the app matches it or follows System.
if (inVsCode && typeof MutationObserver !== 'undefined') {
  const watch = () => new MutationObserver(() => { const t = savedTheme(); if (matchVsCode() || t.pref === 'system') applyTheme(t.pref, t.accent); })
    .observe(document.body, { attributes: true, attributeFilter: ['class'] });
  if (document.body) watch(); else document.addEventListener('DOMContentLoaded', watch);
}

// Shortcuts as they're shown: Ctrl is Cmd on a Mac. Every shortcut in a tooltip, a menu or the palette goes through K.
export const MAC = typeof navigator !== 'undefined' && /Mac/.test(navigator.userAgent);
export const K = (keys: string) => (MAC ? keys.replace(/\bCtrl\b/g, 'Cmd') : keys);
