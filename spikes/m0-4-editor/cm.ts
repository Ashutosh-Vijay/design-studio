import './style.css';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { yaml } from '@codemirror/lang-yaml';
import { autocompletion, startCompletion, type CompletionContext } from '@codemirror/autocomplete';
import { setDiagnostics } from '@codemirror/lint';
import { syntaxTree } from '@codemirror/language';
import { oneDarkish } from './cm-theme';
import { loadSpec, layout, measure, type Adapter } from './shared';

const { text, outline, problems } = await loadSpec();
const ui = layout('CodeMirror 6');

/** API-aware completion. It's an extension of THIS editor only, so other
 *  editors on the page never see it. */
function apiCompletions(ctx: CompletionContext) {
  const line = ctx.state.doc.lineAt(ctx.pos);
  const before = line.text.slice(0, ctx.pos - line.from);
  const word = ctx.matchBefore(/[\w.]*/);
  const from = word ? word.from : ctx.pos;
  if (/(^|\s)(type|items):\s*[\w.]*$/.test(before) || /\|\s*[\w.]*$/.test(before)) {
    return { from, options: outline.types.map((t) => ({ label: t.label, detail: t.detail, type: 'class' })), validFor: /^[\w.]*$/ };
  }
  if (/is:\s*\[[^\]]*$/.test(before)) {
    return { from, options: outline.traits.map((t) => ({ label: t, type: 'interface' })), validFor: /^\w*$/ };
  }
  return null;
}

/** The breadcrumb from the incremental syntax tree: walk up from the cursor
 *  collecting the keys of the pairs we're inside. No re-parse. */
function crumbOf(view: EditorView): string {
  const pos = view.state.selection.main.head;
  const path: string[] = [];
  for (let n: any = syntaxTree(view.state).resolveInner(pos, -1); n; n = n.parent) {
    if (n.name === 'Pair') {
      const key = n.getChild('Key');
      if (key) path.unshift(view.state.sliceDoc(key.from, key.to));
    }
  }
  return path.join(' › ');
}

let t0 = performance.now();
const big = new EditorView({
  parent: ui.big,
  state: EditorState.create({
    doc: text,
    extensions: [
      basicSetup, yaml(), oneDarkish,
      autocompletion({ override: [apiCompletions] }),
      EditorView.updateListener.of((u) => { if (u.selectionSet || u.docChanged) ui.setCrumb(crumbOf(u.view)); }),
    ],
  }),
});
const bigMs = Math.round(performance.now() - t0);

big.dispatch(setDiagnostics(big.state, problems.map((p) => {
  const l = big.state.doc.line(p.line);
  return { from: l.from + p.from, to: Math.min(l.from + p.to, l.to), severity: 'error' as const, message: p.message };
})));

t0 = performance.now();
const minis = ui.minis.map((el, i) => new EditorView({
  parent: el,
  state: EditorState.create({ doc: `Description for field ${i + 1}`, extensions: [oneDarkish, EditorView.lineWrapping] }),
}));
const minisMs = Math.round(performance.now() - t0);

const adapter: Adapter = {
  typeAt(line, s) { const l = big.state.doc.line(line); big.dispatch({ changes: { from: l.to, insert: s } }); },
  scrollToLine(line) { big.dispatch({ effects: EditorView.scrollIntoView(big.state.doc.line(line).from, { y: 'start' }) }); },
  lineCount: () => big.state.doc.lines,
  breadcrumb: () => crumbOf(big),
  setCursor(line, col) { const l = big.state.doc.line(line); big.dispatch({ selection: { anchor: Math.min(l.from + col, l.to) } }); },
  async completionLabels() {
    big.focus();
    startCompletion(big);
    await new Promise((r) => setTimeout(r, 400));
    return [...document.querySelectorAll('.cm-tooltip-autocomplete li')].map((li) => li.textContent ?? '');
  },
};
(window as any).__adapter = adapter;
(window as any).__minis = minis;
measure(adapter, { bigMs, minisMs });
