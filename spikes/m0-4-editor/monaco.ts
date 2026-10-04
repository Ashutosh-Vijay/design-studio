import './style.css';
import * as monaco from 'monaco-editor/esm/vs/editor/edcore.main';
import 'monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import { parseDocument, isMap, isPair, isScalar, isSeq } from 'yaml';
import { loadSpec, layout, measure, type Adapter } from './shared';

(self as any).MonacoEnvironment = { getWorker: () => new EditorWorker() };

const { text, outline, problems } = await loadSpec();
const ui = layout('Monaco 0.52');

let t0 = performance.now();
const model = monaco.editor.createModel(text, 'yaml', monaco.Uri.parse('file:///main.raml'));
const ed = monaco.editor.create(ui.big, { model, theme: 'vs-dark', automaticLayout: true, fontSize: 13, minimap: { enabled: true } });
const bigMs = Math.round(performance.now() - t0);

// Completion providers are registered per LANGUAGE for the whole page, so the
// provider has to check which model it was asked about, or every YAML editor
// on screen would offer API types.
monaco.languages.registerCompletionItemProvider('yaml', {
  triggerCharacters: [' ', '.', '[', ','],
  provideCompletionItems(m, pos) {
    if (m.uri.toString() !== model.uri.toString()) return { suggestions: [] };
    const before = m.getLineContent(pos.lineNumber).slice(0, pos.column - 1);
    const word = m.getWordUntilPosition(pos);
    const range = new monaco.Range(pos.lineNumber, before.search(/[\w.]*$/) + 1, pos.lineNumber, pos.column);
    if (/(^|\s)(type|items):\s*[\w.]*$/.test(before) || /\|\s*[\w.]*$/.test(before)) {
      return { suggestions: outline.types.map((t) => ({ label: t.label, detail: t.detail, kind: monaco.languages.CompletionItemKind.Class, insertText: t.label, range })) };
    }
    if (/is:\s*\[[^\]]*$/.test(before)) {
      return { suggestions: outline.traits.map((t) => ({ label: t, kind: monaco.languages.CompletionItemKind.Interface, insertText: t, range: { ...range, startColumn: word.startColumn } })) };
    }
    return { suggestions: [] };
  },
});

monaco.editor.setModelMarkers(model, 'amf', problems.map((p) => ({
  severity: monaco.MarkerSeverity.Error, message: p.message,
  startLineNumber: p.line, startColumn: p.from + 1, endLineNumber: p.line, endColumn: p.to + 1,
})));

// Ten small editors, like form fields. Each needs its own model.
t0 = performance.now();
const minis = ui.minis.map((el, i) => monaco.editor.create(el, {
  value: `Description for field ${i + 1}`, language: 'yaml', theme: 'vs-dark', automaticLayout: true,
  minimap: { enabled: false }, lineNumbers: 'off', scrollBeyondLastLine: false, fontSize: 12, glyphMargin: false, folding: false,
}));
const minisMs = Math.round(performance.now() - t0);

/** The breadcrumb: Monaco has no syntax tree, so re-parse the YAML text. */
function crumb(): string {
  const off = model.getOffsetAt(ed.getPosition()!);
  const doc = parseDocument(model.getValue(), { customTags: [{ tag: '!include', resolve: (s: string) => s }], uniqueKeys: false });
  const path: string[] = [];
  let node: any = doc.contents;
  while (node) {
    if (isMap(node)) {
      const pair = node.items.find((p: any) => p.key?.range && p.key.range[0] <= off && off <= (p.value?.range?.[2] ?? p.key.range[2]));
      if (!pair) break;
      path.push(String(pair.key.value));
      node = pair.value;
    } else if (isSeq(node)) {
      node = node.items.find((it: any) => it?.range && it.range[0] <= off && off <= it.range[2]);
    } else break;
  }
  return path.join(' › ');
}
ed.onDidChangeCursorPosition(() => ui.setCrumb(crumb()));

const adapter: Adapter = {
  typeAt(line, s) { const col = model.getLineMaxColumn(line); ed.executeEdits('t', [{ range: new monaco.Range(line, col, line, col), text: s }]); },
  scrollToLine(line) { ed.setScrollTop(ed.getTopForLineNumber(line)); },
  lineCount: () => model.getLineCount(),
  breadcrumb: crumb,
  setCursor(line, col) { ed.setPosition({ lineNumber: line, column: col + 1 }); },
  async completionLabels() {
    ed.focus();
    ed.trigger('t', 'editor.action.triggerSuggest', {});
    await new Promise((r) => setTimeout(r, 400));
    return [...document.querySelectorAll('.monaco-list-row')].map((r) => r.getAttribute('aria-label') ?? '');
  },
};
(window as any).__adapter = adapter;
(window as any).__minis = minis;
measure(adapter, { bigMs, minisMs });
