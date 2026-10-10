// The find and replace widget (Ctrl F, Ctrl H): a small floating box at the top right of the editor,
// like Design Center's and VS Code's, instead of CodeMirror's full-width bar.
import { EditorView, type Panel, type ViewUpdate } from '@codemirror/view';
import {
  search, SearchQuery, setSearchQuery, openSearchPanel, getSearchQuery, findNext, findPrevious, replaceNext, replaceAll, closeSearchPanel,
} from '@codemirror/search';

const ICON = {
  case: '<text x="2" y="16" font-size="12" font-family="Inter,Segoe UI,sans-serif" font-weight="600" fill="currentColor">Aa</text>',
  word: '<text x="2.5" y="14" font-size="10.5" font-family="Inter,Segoe UI,sans-serif" font-weight="600" fill="currentColor">ab</text><path d="M2 17h16M2 14.5v2.5M18 14.5v2.5" stroke="currentColor" fill="none" stroke-width="1.4"/>',
  regex: '<text x="1.5" y="17" font-size="13" font-family="JetBrains Mono,Consolas,monospace" font-weight="700" fill="currentColor">.*</text>',
  up: '<path d="M10 15V5M5 10l5-5 5 5" stroke="currentColor" fill="none" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
  down: '<path d="M10 5v10M5 10l5 5 5-5" stroke="currentColor" fill="none" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
  close: '<path d="M5 5l10 10M15 5L5 15" stroke="currentColor" fill="none" stroke-width="1.6" stroke-linecap="round"/>',
  chev: '<path d="M7 5l5 5-5 5" stroke="currentColor" fill="none" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
  one: '<path d="M3 6h9M3 10h6M14 9l3 3-3 3M9 12h8" stroke="currentColor" fill="none" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
  all: '<path d="M3 5h9M3 9h9M3 13h5M14 10l3 3-3 3M10 13h7" stroke="currentColor" fill="none" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
};
const svg = (k: keyof typeof ICON) => `<svg width="16" height="16" viewBox="0 0 20 20">${ICON[k]}</svg>`;

// "3 of 12": counted on every change, capped so a one-letter search in a huge file stays instant.
function countMatches(view: EditorView, q: SearchQuery): { index: number; total: number } {
  if (!q.valid || !q.search) return { index: 0, total: 0 };
  const sel = view.state.selection.main;
  let total = 0, index = 0;
  const cur = q.getCursor(view.state);
  for (let r = cur.next(); !r.done; r = cur.next()) {
    total++;
    if (r.value.from === sel.from && r.value.to === sel.to) index = total;
    if (total >= 9999) break;
  }
  return { index, total };
}

function createPanel(view: EditorView): Panel {
  const dom = document.createElement('div');
  dom.className = 'ads-find';
  dom.innerHTML = `
    <button class="ads-find-toggle" data-a="expand" title="Toggle replace (Ctrl H)">${svg('chev')}</button>
    <div class="ads-find-rows">
      <div class="ads-find-row">
        <div class="ads-find-field"><input class="ads-find-input" data-f="search" placeholder="Find" spellcheck="false" main-field="true">
          <button data-a="case" title="Match case (Alt C)">${svg('case')}</button><button data-a="word" title="Match whole word (Alt W)">${svg('word')}</button><button data-a="regexp" title="Use regular expression (Alt R)">${svg('regex')}</button></div>
        <span class="ads-find-count"></span>
        <button data-a="prev" title="Previous match (Shift Enter)">${svg('up')}</button><button data-a="next" title="Next match (Enter)">${svg('down')}</button>
        <button data-a="close" title="Close (Escape)">${svg('close')}</button>
      </div>
      <div class="ads-find-row ads-find-replace">
        <div class="ads-find-field"><input class="ads-find-input" data-f="replace" placeholder="Replace" spellcheck="false"></div>
        <button data-a="one" title="Replace (Enter)">${svg('one')}</button><button data-a="all" title="Replace all (Ctrl Alt Enter)">${svg('all')}</button>
      </div>
    </div>`;
  const $ = <T extends HTMLElement>(s: string) => dom.querySelector(s) as T;
  const searchIn = $<HTMLInputElement>('[data-f=search]'), replaceIn = $<HTMLInputElement>('[data-f=replace]');
  let q = getSearchQuery(view.state);
  const read = () => { searchIn.value = q.search; replaceIn.value = q.replace; };
  const paint = () => {
    for (const k of ['case', 'word', 'regexp'] as const) {
      const on = k === 'case' ? q.caseSensitive : k === 'word' ? q.wholeWord : q.regexp;
      $<HTMLButtonElement>(`[data-a=${k}]`).classList.toggle('on', on);
    }
    const c = countMatches(view, q);
    const countEl = $<HTMLSpanElement>('.ads-find-count');
    countEl.textContent = !q.search ? 'No results' : !q.valid ? 'Invalid pattern' : c.total === 0 ? 'No results' : `${c.index || '?'} of ${c.total >= 9999 ? '9999+' : c.total}`;
    countEl.classList.toggle('none', !!q.search && c.total === 0);
  };
  const commit = (patch: Partial<{ search: string; replace: string; caseSensitive: boolean; wholeWord: boolean; regexp: boolean }>) => {
    q = new SearchQuery({ search: q.search, replace: q.replace, caseSensitive: q.caseSensitive, wholeWord: q.wholeWord, regexp: q.regexp, ...patch });
    view.dispatch({ effects: setSearchQuery.of(q) });
  };
  searchIn.addEventListener('input', () => { commit({ search: searchIn.value }); findFromCursor(); });
  replaceIn.addEventListener('input', () => commit({ replace: replaceIn.value }));
  // As you type, jump to the first match at or after the cursor, like other editors.
  const findFromCursor = () => {
    if (!q.valid || !q.search) return;
    const from = view.state.selection.main.from;
    const r = q.getCursor(view.state, from).next();
    const m = r.done ? q.getCursor(view.state).next() : r;
    if (!m.done) view.dispatch({ selection: { anchor: m.value.from, head: m.value.to }, scrollIntoView: true });
  };
  dom.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (e.key === 'Enter' && t === searchIn) { e.preventDefault(); (e.shiftKey ? findPrevious : findNext)(view); }
    else if (e.key === 'Enter' && t === replaceIn) { e.preventDefault(); if (e.ctrlKey && e.altKey) replaceAll(view); else replaceNext(view); }
    else if (e.key === 'Escape') { e.preventDefault(); closeSearchPanel(view); view.focus(); }
    // The same shortcuts work from inside the widget.
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'h') { e.preventDefault(); dom.classList.add('with-replace'); replaceIn.focus(); replaceIn.select(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); searchIn.focus(); searchIn.select(); }
    else if (e.altKey && ['c', 'w', 'r'].includes(e.key.toLowerCase())) {
      e.preventDefault();
      const k = e.key.toLowerCase();
      commit(k === 'c' ? { caseSensitive: !q.caseSensitive } : k === 'w' ? { wholeWord: !q.wholeWord } : { regexp: !q.regexp });
    }
  });
  dom.addEventListener('mousedown', (e) => { if ((e.target as HTMLElement).closest('button')) e.preventDefault(); });
  dom.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest('button')?.dataset.a; if (!a) return;
    if (a === 'expand') dom.classList.toggle('with-replace');
    else if (a === 'case') commit({ caseSensitive: !q.caseSensitive });
    else if (a === 'word') commit({ wholeWord: !q.wholeWord });
    else if (a === 'regexp') commit({ regexp: !q.regexp });
    else if (a === 'next') findNext(view);
    else if (a === 'prev') findPrevious(view);
    else if (a === 'one') replaceNext(view);
    else if (a === 'all') replaceAll(view);
    else if (a === 'close') { closeSearchPanel(view); view.focus(); }
  });
  read(); paint();
  return {
    dom,
    top: true,
    mount() {
      // Ctrl F with text selected searches for it.
      const sel = view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to);
      if (sel && !sel.includes('\n') && sel !== q.search) commit({ search: sel });
      read(); paint();
      searchIn.select();
    },
    update(u: ViewUpdate) {
      for (const tr of u.transactions) for (const ef of tr.effects) if (ef.is(setSearchQuery) && !ef.value.eq(q)) { q = ef.value; read(); }
      if (u.docChanged || u.selectionSet || u.transactions.some((t) => t.effects.some((ef) => ef.is(setSearchQuery)))) paint();
    },
  };
}

// Ctrl H opens the widget with Replace showing.
export function openReplace(view: EditorView): boolean {
  openSearchPanel(view);
  view.dom.querySelector('.ads-find')?.classList.add('with-replace');
  (view.dom.querySelector('.ads-find [data-f=replace]') as HTMLInputElement | null)?.focus();
  return true;
}

export const findWidget = [
  search({ top: true, createPanel }),
  EditorView.theme({
    '.cm-panels.cm-panels-top': { position: 'absolute', top: '6px', right: '18px', left: 'auto', border: 'none', background: 'transparent', zIndex: '30' },
    '.ads-find': {
      display: 'flex', alignItems: 'flex-start', gap: '2px', padding: '5px 6px 5px 3px', background: 'var(--surface-2)', border: '1px solid var(--line)',
      borderRadius: '6px', boxShadow: 'var(--shadow)', fontFamily: 'var(--font-sans)', fontSize: '12px', color: 'var(--content)',
    },
    '.ads-find button': {
      width: '24px', height: '24px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', border: 'none', background: 'transparent',
      color: 'var(--content-muted)', borderRadius: '4px', cursor: 'pointer', padding: '0', flexShrink: '0',
    },
    '.ads-find button:hover': { background: 'var(--surface-3)', color: 'var(--content)' },
    '.ads-find button.on': { background: 'var(--accent-dim)', color: 'var(--accent)', outline: '1px solid var(--accent-border)' },
    '.ads-find-toggle': { height: '24px !important', alignSelf: 'stretch', transition: 'transform 0.12s' },
    '.ads-find.with-replace .ads-find-toggle svg': { transform: 'rotate(90deg)' },
    '.ads-find-rows': { display: 'flex', flexDirection: 'column', gap: '4px' },
    '.ads-find-row': { display: 'flex', alignItems: 'center', gap: '2px' },
    '.ads-find-replace': { display: 'none' },
    '.ads-find.with-replace .ads-find-replace': { display: 'flex' },
    '.ads-find-field': {
      display: 'flex', alignItems: 'center', width: '270px', height: '26px', padding: '0 2px 0 8px', background: 'var(--surface-input)',
      border: '1px solid var(--line)', borderRadius: '4px', marginRight: '4px',
    },
    '.ads-find-field:focus-within': { borderColor: 'var(--accent)' },
    '.ads-find-field button': { width: '22px', height: '20px' },
    '.ads-find-input': { flex: '1', minWidth: '0', border: 'none', outline: 'none', background: 'transparent', color: 'var(--content)', fontSize: '12.5px', fontFamily: 'var(--font-sans)' },
    '.ads-find-count': { minWidth: '76px', padding: '0 6px', color: 'var(--content-faint)', fontSize: '11.5px', whiteSpace: 'nowrap' },
    '.ads-find-count.none': { color: 'var(--err)' },
  }),
];
