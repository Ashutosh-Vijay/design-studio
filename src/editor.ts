// CodeMirror 6 setup: theme from our CSS variables, RAML-aware highlighting, and the cursor's YAML path.
import { EditorState, type Extension } from '@codemirror/state';
import {
  EditorView, Decoration, MatchDecorator, ViewPlugin, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter,
  drawSelection, highlightSpecialChars, rectangularSelection, crosshairCursor, dropCursor, type DecorationSet, type ViewUpdate,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { HighlightStyle, syntaxHighlighting, indentOnInput, bracketMatching, foldGutter, foldKeymap, syntaxTree, indentUnit } from '@codemirror/language';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
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
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--selection-bg) !important' },
  '.cm-selectionMatch': { backgroundColor: 'var(--accent-dim)' },
  '.cm-matchingBracket': { backgroundColor: 'var(--accent-dim)', outline: '1px solid var(--accent-border)' },
  '.cm-foldGutter .cm-gutterElement': { color: 'var(--content-ghost)', padding: '0 4px' },
  '.cm-tooltip': { backgroundColor: 'var(--surface-2)', border: '1px solid var(--line)', color: 'var(--content)', borderRadius: '6px', boxShadow: 'var(--shadow)' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--accent-dim)', color: 'var(--content)' },
  '.cm-completionMatchedText': { color: 'var(--accent)', textDecoration: 'none', fontWeight: '700' },
  '.cm-completionDetail': { color: 'var(--content-faint)', fontStyle: 'normal', marginLeft: '12px' },
  '.cm-panels': { backgroundColor: 'var(--surface-2)', color: 'var(--content)', borderColor: 'var(--line)' },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in oklch, var(--warn) 30%, transparent)' },
  '.cm-searchMatch-selected': { backgroundColor: 'color-mix(in oklch, var(--warn) 55%, transparent)' },
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

export function languageFor(path: string): Extension {
  if (/\.json$/i.test(path)) return json();
  if (/\.(raml|ya?ml)$/i.test(path)) return [yaml(), ramlPlugin];
  return [];
}

// Everything except the per-file language and the app's own listeners.
export function baseExtensions(): Extension[] {
  return [
    lineNumbers(), foldGutter(), highlightActiveLineGutter(), highlightSpecialChars(), history(), drawSelection(), dropCursor(),
    EditorState.allowMultipleSelections.of(true), indentOnInput(), bracketMatching(), closeBrackets(),
    rectangularSelection(), crosshairCursor(), highlightActiveLine(), highlightSelectionMatches(),
    indentUnit.of('  '), EditorState.tabSize.of(2),
    syntaxHighlighting(highlight), theme,
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, indentWithTab]),
  ];
}

// The keys of the YAML pairs around the cursor, from the live Lezer tree (M0.4: about 0.01 ms).
export function yamlPathAt(state: EditorState, pos: number): { key: string; from: number }[] {
  const out: { key: string; from: number }[] = [];
  for (let n: ReturnType<ReturnType<typeof syntaxTree>['resolveInner']> | null = syntaxTree(state).resolveInner(pos, -1); n; n = n.parent) {
    if (n.name === 'Pair') {
      const k = n.getChild('Key');
      if (k) out.unshift({ key: state.sliceDoc(k.from, k.to), from: n.from });
    }
  }
  return out;
}
