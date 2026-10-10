// Dev only: the app's editor on a sample spec, in a plain browser, for checking how it looks.
import '../src/index.css';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { baseExtensions, languageFor } from '../src/editor';
import { applyTheme } from '../src/theme';

const sample = `#%RAML 1.0
title: experiment
uses:
  caseLib: data-types/case.raml

/name:
  post:
    is: [ client-id-policy, global-errors, correlation-headers ]
    body:
      application/json:
        type: caseLib.Case
        example: !include examples/post-name.json
    responses:
      200:
        body:
          application/json:
            type: caseLib.Case
`;
const params = new URLSearchParams(location.search);
applyTheme(params.get('theme') === 'light' ? 'light' : 'dark', 'emerald');
const view = new EditorView({ parent: document.getElementById('ed')!, state: EditorState.create({ doc: sample, extensions: [...baseExtensions(), languageFor('a.raml')] }) });
(window as unknown as { __view: EditorView }).__view = view;
document.getElementById('bar')!.innerHTML = `<a href="?theme=dark">Dusk</a><a href="?theme=light">Paper</a>`;
