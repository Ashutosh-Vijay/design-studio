// CodeMirror 6 setup: theme from our CSS variables, RAML-aware highlighting, and the cursor's YAML path.
import { EditorState, EditorSelection, StateEffect, StateField, type Extension, type Range } from '@codemirror/state';
import {
  EditorView, Decoration, WidgetType, MatchDecorator, ViewPlugin, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter,
  drawSelection, highlightSpecialChars, rectangularSelection, crosshairCursor, dropCursor, type DecorationSet, type ViewUpdate,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, selectParentSyntax } from '@codemirror/commands';
import { HighlightStyle, syntaxHighlighting, indentOnInput, bracketMatching, foldGutter, foldKeymap, syntaxTree, indentUnit } from '@codemirror/language';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { findWidget, openReplace } from './find';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { yaml } from '@codemirror/lang-yaml';
import { json } from '@codemirror/lang-json';
import { tags as t } from '@lezer/highlight';

export const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

// Colours come from CSS variables, so Dusk, Paper and the accent all apply without rebuilding the editor.
const theme = EditorView.theme({
  '&': { height: '100%', color: 'var(--content)', backgroundColor: 'var(--surface)', fontSize: '12.5px' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '20px' },
  '.cm-content': { caretColor: 'var(--accent)', padding: '6px 0 40vh' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '.cm-gutters': { backgroundColor: 'var(--surface)', color: 'var(--content-ghost)', border: 'none' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 14px' },
  '.cm-activeLine': { backgroundColor: 'var(--surface-2)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--surface-2)', color: 'var(--content-muted)' },
  // Selection keeps the syntax colours readable: a light wash, stronger while the editor has focus.
  '.cm-selectionBackground': { backgroundColor: 'var(--editor-sel-blur) !important' },
  '&.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--editor-sel) !important' },
  '.cm-content ::selection': { backgroundColor: 'transparent' },
  '.cm-selectionMatch': { backgroundColor: 'transparent', outline: '1px solid var(--accent-border)', borderRadius: '2px' },
  '.cm-matchingBracket': { backgroundColor: 'var(--accent-dim)', outline: '1px solid var(--accent-border)' },
  '.cm-foldGutter .cm-gutterElement': { color: 'var(--content-ghost)', padding: '0 4px' },
  '.cm-tooltip': { backgroundColor: 'var(--surface-2)', border: '1px solid var(--line)', color: 'var(--content)', borderRadius: '6px', boxShadow: 'var(--shadow)' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--accent-dim)', color: 'var(--content)' },
  '.cm-completionMatchedText': { color: 'var(--accent)', textDecoration: 'none', fontWeight: '700' },
  '.cm-completionDetail': { color: 'var(--content-faint)', fontStyle: 'normal', marginLeft: '12px' },
  '.cm-panels': { backgroundColor: 'var(--surface-2)', color: 'var(--content)', borderColor: 'var(--line)' },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in oklch, var(--warn) 24%, transparent)', borderRadius: '2px' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'color-mix(in oklch, var(--warn) 45%, transparent)', outline: '1px solid var(--warn)' },
  '.cm-textfield, .cm-button': { backgroundColor: 'var(--surface-input)', color: 'var(--content)', border: '1px solid var(--line)', borderRadius: '4px', backgroundImage: 'none' },
  '.cm-lintRange-error': { backgroundImage: 'none', textDecoration: 'underline wavy var(--err)', textUnderlineOffset: '3px' },
  '.cm-lintRange-warning': { backgroundImage: 'none', textDecoration: 'underline wavy var(--warn)', textUnderlineOffset: '3px' },
  // RAML-aware marks, added by the decorator below
  '.ads-res, .ads-res *': { color: 'var(--content)', fontWeight: '700' },
  '.ads-m-get, .ads-m-get *': { color: 'var(--cyan)', fontWeight: '700' },
  '.ads-m-post, .ads-m-post *': { color: 'var(--ok)', fontWeight: '700' },
  '.ads-m-put, .ads-m-put *': { color: 'var(--warn)', fontWeight: '700' },
  '.ads-m-patch, .ads-m-patch *': { color: 'var(--violet)', fontWeight: '700' },
  '.ads-m-delete, .ads-m-delete *': { color: 'var(--err)', fontWeight: '700' },
  '.ads-m-head, .ads-m-options, .ads-m-head *, .ads-m-options *': { color: 'var(--content-secondary)', fontWeight: '700' },
  '.ads-code, .ads-code *': { color: 'var(--syn-number)' },
  '.ads-alias, .ads-alias *': { color: 'var(--content-muted)' },
  '.ads-type, .ads-type *': { color: 'var(--syn-type)' },
  '.ads-include, .ads-include *': { color: 'var(--syn-fn)', fontStyle: 'italic' },
  '.ads-path': { textDecoration: 'underline dotted', textUnderlineOffset: '3px' },
  '.ads-use': { backgroundColor: 'color-mix(in oklch, var(--accent) 16%, transparent)', borderRadius: '2px', outline: '1px solid var(--accent-border)' },
  '.ads-conflict-mark': { backgroundColor: 'color-mix(in oklch, var(--warn) 22%, transparent)', color: 'var(--content-muted)' },
  '.ads-conflict-mine': { backgroundColor: 'color-mix(in oklch, var(--accent) 12%, transparent)' },
  '.ads-conflict-theirs': { backgroundColor: 'color-mix(in oklch, var(--cyan) 12%, transparent)' },
  '.ads-conflict-btns': { marginLeft: '14px', display: 'inline-flex', gap: '6px', fontFamily: 'var(--font-sans, system-ui)' },
  '.ads-conflict-btns button': { height: '18px', padding: '0 8px', borderRadius: '4px', border: '1px solid var(--line)', backgroundColor: 'var(--surface-2)', color: 'var(--content-secondary)', fontSize: '11px', cursor: 'pointer' },
  '.ads-conflict-btns button:hover': { borderColor: 'var(--accent-border)', color: 'var(--content)' },
});

const highlight = HighlightStyle.define([
  { tag: [t.propertyName, t.definition(t.propertyName)], color: 'var(--violet)' },
  { tag: [t.string, t.special(t.string), t.content], color: 'var(--syn-string)' },
  { tag: t.number, color: 'var(--syn-number)' },
  { tag: [t.bool, t.null, t.keyword], color: 'var(--syn-number)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--content-faint)', fontStyle: 'italic' },
  { tag: [t.typeName, t.labelName, t.meta, t.tagName], color: 'var(--syn-fn)', fontStyle: 'italic' },
  { tag: [t.punctuation, t.separator, t.brace, t.squareBracket], color: 'var(--content-muted)' },
]);

// RAML on top of plain YAML: resource keys, method keys, status codes, !include paths and alias.Type references.
const ramlMarks = new MatchDecorator({
  regexp: /^(\s*)(\/[^\s:]*|get|post|put|patch|delete|head|options|\d{3})(?=\s*:)|(!include)(\s+)(\S+)|(?<=(?:type|items):\s*)([a-z]\w*\.)([A-Z]\w*)/gm,
  decorate: (add, from, _to, m) => {
    if (m[2]) {
      const s = from + m[1].length;
      const cls = m[2].startsWith('/') ? 'ads-res' : /^\d{3}$/.test(m[2]) ? 'ads-code' : 'ads-m-' + m[2];
      add(s, s + m[2].length, Decoration.mark({ class: cls }));
    } else if (m[3]) {
      add(from, from + 8, Decoration.mark({ class: 'ads-include' }));
      const s = from + 8 + m[4].length;
      add(s, s + m[5].length, Decoration.mark({ class: 'ads-path' }));
    } else if (m[6]) {
      add(from, from + m[6].length, Decoration.mark({ class: 'ads-alias' }));
      add(from + m[6].length, from + m[6].length + m[7].length, Decoration.mark({ class: 'ads-type' }));
    }
  },
});
const ramlPlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = ramlMarks.createDeco(view); }
  update(u: ViewUpdate) { this.decorations = ramlMarks.updateDeco(u, this.decorations); }
}, { decorations: (v) => v.decorations });

// Conflicts left by a Pull (sync.ts merge3): each block gets Keep mine / Keep theirs / Keep both on its
// first line, and the two versions are tinted.
class ConflictButtons extends WidgetType {
  constructor(readonly from: number, readonly to: number, readonly mine: string[], readonly theirs: string[]) { super(); }
  eq(o: ConflictButtons) { return o.from === this.from && o.to === this.to && o.mine.join('\n') === this.mine.join('\n') && o.theirs.join('\n') === this.theirs.join('\n'); }
  toDOM(view: EditorView) {
    const box = document.createElement('span');
    box.className = 'ads-conflict-btns';
    for (const [label, lines] of [['Keep mine', this.mine], ['Keep theirs', this.theirs], ['Keep both', [...this.mine, ...this.theirs]]] as const) {
      const b = document.createElement('button');
      b.textContent = label;
      b.onmousedown = (e) => {
        e.preventDefault();
        // Nothing kept: the block's lines go, with the line break after them.
        const to = !lines.length && this.to < view.state.doc.length ? this.to + 1 : this.to;
        view.dispatch({ changes: { from: this.from, to, insert: lines.join('\n') }, selection: { anchor: this.from }, userEvent: 'input' });
        view.focus();
      };
      box.append(b);
    }
    return box;
  }
  ignoreEvent() { return true; }
}
function conflictDeco(view: EditorView): DecorationSet {
  const doc = view.state.doc, out: Range<Decoration>[] = [];
  if (!doc.toString().includes('<<<<<<< yours')) return Decoration.none;
  for (let n = 1; n <= doc.lines; n++) {
    if (doc.line(n).text !== '<<<<<<< yours') continue;
    let mid = 0, end = 0;
    for (let k = n + 1; k <= doc.lines && !end; k++) { const t = doc.line(k).text; if (t === '=======' && !mid) mid = k; else if (t === '>>>>>>> Design Center' && mid) end = k; }
    if (!end) continue;
    const lines = (a: number, b: number) => { const r: string[] = []; for (let k = a; k < b; k++) r.push(doc.line(k).text); return r; };
    out.push(Decoration.widget({ widget: new ConflictButtons(doc.line(n).from, doc.line(end).to, lines(n + 1, mid), lines(mid + 1, end)), side: 1 }).range(doc.line(n).to));
    for (let k = n; k <= end; k++) out.push(Decoration.line({ class: k === n || k === mid || k === end ? 'ads-conflict-mark' : k < mid ? 'ads-conflict-mine' : 'ads-conflict-theirs' }).range(doc.line(k).from));
    n = end;
  }
  return Decoration.set(out, true);
}
const conflictPlugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = conflictDeco(view); }
  update(u: ViewUpdate) { if (u.docChanged) this.decorations = conflictDeco(u.view); }
}, { decorations: (v) => v.decorations });

// Highlight uses (Design Center's): the app sends the declaration and its uses in this file for the name under
// the cursor; edits move the marks until the next update.
export const setUses = StateEffect.define<[number, number][]>();
const useMark = Decoration.mark({ class: 'ads-use' });
const usesField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(v, tr) {
    v = v.map(tr.changes);
    for (const e of tr.effects) if (e.is(setUses)) v = Decoration.set(e.value.filter(([a, b]) => b > a && b <= tr.state.doc.length).map(([a, b]) => useMark.range(a, b)), true);
    return v;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export function languageFor(path: string): Extension {
  if (/\.json$/i.test(path)) return json();
  if (/\.(raml|ya?ml)$/i.test(path)) return [yaml(), ramlPlugin];
  return [];
}

// Grow and shrink the selection by syntax (Design Center's Ctrl Shift Right and Left). Shrinking walks back
// through the grows; any other selection change starts over.
const grown = new WeakMap<EditorView, { stack: EditorSelection[]; last: EditorSelection }>();
export const growSelection = (v: EditorView) => {
  const before = v.state.selection, g = grown.get(v);
  if (!selectParentSyntax(v)) return false;
  const stack = g && g.last.eq(before) ? g.stack : [];
  grown.set(v, { stack: [...stack, before], last: v.state.selection });
  return true;
};
export const shrinkSelection = (v: EditorView) => {
  const g = grown.get(v);
  if (!g || !g.last.eq(v.state.selection) || !g.stack.length) return false;
  const prev = g.stack[g.stack.length - 1];
  grown.set(v, { stack: g.stack.slice(0, -1), last: prev });
  v.dispatch({ selection: prev, scrollIntoView: true });
  return true;
};

// Everything except the per-file language and the app's own listeners.
export function baseExtensions(): Extension[] {
  return [
    lineNumbers(), foldGutter(), highlightActiveLineGutter(), highlightSpecialChars(), history(), drawSelection(), dropCursor(),
    EditorState.allowMultipleSelections.of(true), indentOnInput(), bracketMatching(), closeBrackets(),
    rectangularSelection(), crosshairCursor(), highlightActiveLine(), highlightSelectionMatches(),
    indentUnit.of('  '), EditorState.tabSize.of(2),
    syntaxHighlighting(highlight), theme, findWidget, conflictPlugin, usesField,
    keymap.of([{ key: 'Mod-h', run: openReplace }, { key: 'Mod-Shift-ArrowRight', run: growSelection }, { key: 'Mod-Shift-ArrowLeft', run: shrinkSelection }, ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, indentWithTab]),
  ];
}

// The keys of the YAML pairs around the cursor, from the live Lezer tree (M0.4: about 0.01 ms).
export function yamlPathAt(state: EditorState, pos: number): { key: string; from: number }[] {
  const out: { key: string; from: number }[] = [];
  // At the start of a line (or in its indent) look to the right, so the cursor counts as inside that line's key.
  const line = state.doc.lineAt(pos);
  const side = /^\s*$/.test(state.sliceDoc(line.from, pos)) ? 1 : -1;
  for (let n: ReturnType<ReturnType<typeof syntaxTree>['resolveInner']> | null = syntaxTree(state).resolveInner(pos, side); n; n = n.parent) {
    if (n.name === 'Pair') {
      const k = n.getChild('Key');
      if (k) out.unshift({ key: state.sliceDoc(k.from, k.to), from: n.from });
    }
  }
  return out;
}
