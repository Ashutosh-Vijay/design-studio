// A small dark theme so both pages look comparable. CodeMirror ships none by
// default; @codemirror/theme-one-dark exists, but this keeps dependencies equal.
import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

export const oneDarkish = [
  EditorView.theme({
    '&': { color: '#d4d4d4', backgroundColor: '#1e1e1e', fontSize: '13px' },
    '.cm-content': { caretColor: '#aeafad', fontFamily: 'Consolas, ui-monospace, monospace' },
    '.cm-gutters': { backgroundColor: '#1e1e1e', color: '#858585', border: 'none' },
    '.cm-activeLine': { backgroundColor: '#ffffff0a' },
    '.cm-activeLineGutter': { backgroundColor: '#ffffff0a' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: '#264f78' },
    '.cm-tooltip': { backgroundColor: '#252526', border: '1px solid #454545', color: '#d4d4d4' },
  }, { dark: true }),
  syntaxHighlighting(HighlightStyle.define([
    { tag: t.definition(t.propertyName), color: '#9cdcfe' },
    { tag: t.propertyName, color: '#9cdcfe' },
    { tag: [t.string, t.special(t.string)], color: '#ce9178' },
    { tag: t.number, color: '#b5cea8' },
    { tag: [t.bool, t.null, t.keyword], color: '#569cd6' },
    { tag: t.comment, color: '#6a9955' },
    { tag: [t.typeName, t.labelName, t.meta], color: '#4ec9b0' },
    { tag: t.punctuation, color: '#808080' },
  ])),
];
