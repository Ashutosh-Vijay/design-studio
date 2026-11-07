// Design Center's Create (New API Specification, New Fragment) for the start screen, and New file for the
// Files panel's + menu. The starter text is Design Center's own where it has one, so new files look the same.
import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Modal, Spinner, btn, btnPrimary } from './App';
import { Select } from './components/Popup';
import type { Me } from './SyncUI';
import * as S from './sync';
import { parse } from 'yaml';
import { quote } from './splice';
import securedRaml from './starters/secured.raml?raw';
import securedOas from './starters/secured.yaml?raw';
import securedAsync from './starters/secured-async.yaml?raw';

// Every kind of file: label, extension, and for fragments the subType Design Center's API takes (probed).
export const KINDS = {
  raml: { label: 'RAML 1.0', ext: 'raml', head: '#%RAML 1.0\ntitle: {name}\n' },
  oas3yaml: { label: 'OAS 3.0 (YAML)', ext: 'yaml', head: 'openapi: 3.0.0\ninfo:\n  title: {name}\n  version: 1.0.0\npaths: {}\n' },
  oas3json: { label: 'OAS 3.0 (JSON)', ext: 'json', head: '{\n  "openapi": "3.0.0",\n  "info": {\n    "title": "{name}",\n    "version": "1.0.0"\n  },\n  "paths": {}\n}\n' },
  oas31yaml: { label: 'OAS 3.1 (YAML)', ext: 'yaml', head: 'openapi: 3.1.0\ninfo:\n  title: {name}\n  version: 1.0.0\npaths: {}\n' },
  oas31json: { label: 'OAS 3.1 (JSON)', ext: 'json', head: '{\n  "openapi": "3.1.0",\n  "info": {\n    "title": "{name}",\n    "version": "1.0.0"\n  },\n  "paths": {}\n}\n' },
  oas2json: { label: 'OAS 2.0 (JSON)', ext: 'json', head: '{\n  "swagger": "2.0",\n  "info": {\n    "version": "1.0.0",\n    "title": "{name}"\n  },\n  "paths": {}\n}\n' },
  asyncyaml: { label: 'AsyncAPI 2.6 (YAML)', ext: 'yaml', head: "asyncapi: '2.6.0'\ninfo:\n  title: {name}\n  version: 1.0.0\nchannels: {}\n" },
  asyncjson: { label: 'AsyncAPI 2.6 (JSON)', ext: 'json', head: '{\n  "asyncapi": "2.6.0",\n  "info": {\n    "title": "{name}",\n    "version": "1.0.0"\n  },\n  "channels": {}\n}\n' },
  oas2yaml: { label: 'OAS 2.0 (YAML)', ext: 'yaml', head: "swagger: '2.0'\ninfo:\n  version: 1.0.0\n  title: {name}\npaths: {}\n" },
  library: { label: 'Library', ext: 'raml', head: '#%RAML 1.0 Library\nusage:\n', sub: 'library' },
  type: { label: 'Data Type', ext: 'raml', head: '#%RAML 1.0 DataType\n', sub: 'type' },
  trait: { label: 'Trait', ext: 'raml', head: '#%RAML 1.0 Trait\n', sub: 'trait' },
  resourceType: { label: 'Resource Type', ext: 'raml', head: '#%RAML 1.0 ResourceType\n', sub: 'resource_type' },
  example: { label: 'Example', ext: 'raml', head: '#%RAML 1.0 NamedExample\n{name}:\n', sub: 'example' },
  docs: { label: 'User Documentation', ext: 'raml', head: '#%RAML 1.0 DocumentationItem\ntitle:\ncontent:\n', sub: 'user_documentation' },
  annotationType: { label: 'Annotation Type', ext: 'raml', head: '#%RAML 1.0 AnnotationTypeDeclaration\n', sub: 'annotation_type' },
  securityScheme: { label: 'Security Scheme', ext: 'raml', head: '#%RAML 1.0 SecurityScheme\ntype:\n', sub: 'security_scheme' },
  overlay: { label: 'Overlay', ext: 'raml', head: '#%RAML 1.0 Overlay\nextends:\n', sub: 'overlay' },
  extension: { label: 'Extension', ext: 'raml', head: '#%RAML 1.0 Extension\nextends:\n', sub: 'extension' },
  jsonSchema: { label: 'JSON Schema', ext: 'json', head: '{\n  "$schema": "http://json-schema.org/draft-07/schema#",\n  "type": "object",\n  "properties": {}\n}\n' },
  other: { label: 'Other', ext: '', head: '' },
} as const;
export type Kind = keyof typeof KINDS;
const API_KINDS: Kind[] = ['raml', 'oas3yaml', 'oas3json', 'oas31yaml', 'oas31json', 'oas2json', 'oas2yaml', 'asyncyaml', 'asyncjson'];
// AsyncAPI projects are evented-api in Design Center and Exchange; OAS 3.1 ones are oas. Both proven on the trial
// org 2026-11-08: created, pushed, published to Exchange as Development, and Exchange made its own versions of them.
const isAsyncKind = (k: Kind) => k === 'asyncyaml' || k === 'asyncjson';
const FRAGMENTS: Kind[] = ['library', 'type', 'trait', 'resourceType', 'example', 'docs', 'annotationType', 'securityScheme', 'overlay', 'extension'];
// The secured starter (src/starters): HTTPS only, OAuth 2.0 on every call, errors, rate limits, correlation ids
// and patterns on every string parameter. Proven clean on AMF and MuleSoft's rulesets (Anypoint Best Practices,
// OWASP API Security, transport and authentication security, documentation, OpenAPI): scripts/starters-verify.mjs.
export const SECURED: Kind[] = ['raml', 'oas3yaml', 'oas3json', 'oas31yaml', 'oas31json', 'asyncyaml', 'asyncjson'];
export const starter = (k: Kind, name: string, secured = false) => {
  if (!secured || !SECURED.includes(k)) return KINDS[k].head.split('{name}').join(name);
  if (k === 'raml') return securedRaml.replace('title: Orders API', 'title: ' + quote(name));
  if (k === 'oas3yaml') return securedOas.replace('  title: Orders API', '  title: ' + quote(name));
  // OAS 3.1: the same starter (proven clean as 3.1 too).
  if (k === 'oas31yaml') return securedOas.replace('openapi: 3.0.0', 'openapi: 3.1.0').replace('  title: Orders API', '  title: ' + quote(name));
  if (k === 'asyncyaml') return securedAsync.replace('  title: Order Events', '  title: ' + quote(name));
  const o = parse(k === 'asyncjson' ? securedAsync : securedOas); o.info.title = name;
  if (k === 'oas31json') o.openapi = '3.1.0';
  return JSON.stringify(o, null, 2) + '\n';
};
const fileName = (k: Kind, name: string) => (KINDS[k].ext && !name.toLowerCase().endsWith('.' + KINDS[k].ext) ? `${name}.${KINDS[k].ext}` : name);
const field = 'h-[28px] px-2 rounded-md border border-line bg-surface-input text-[12.5px] outline-none focus:border-accent';

// ---------- Create: a new project, in Design Center and here, or only here ----------
// The work itself, shared by the dialog and the AI tools (create_project). Returns the new folder.
export async function makeProject(n: string, kind: Kind, dc: boolean, me: Me | null, busy: (s: string) => void = () => {}, secured = false) {
  if (dc) {
    busy('Creating it in Design Center…');
    const id = await S.createProject(n, KINDS[kind].head.startsWith('#%RAML 1.0\n') ? 'raml' : kind.startsWith('oas') ? 'oas' : isAsyncKind(kind) ? 'evented-api' : 'raml-fragment', (KINDS[kind] as { sub?: string }).sub);
    const root = await S.projectFolder(me!.org_name || 'Anypoint', n, id);
    busy('Pulling it here…');
    await S.clone(root, id, n, 'master');
    // Design Center starts every OAS project as OAS 2.0 JSON and every AsyncAPI one as AsyncAPI 2.0 YAML: another
    // flavour is written here and pushed. So is the secured starter, over Design Center's own starter file.
    if ((kind !== 'oas2json' && kind.startsWith('oas')) || isAsyncKind(kind) || (secured && SECURED.includes(kind))) {
      const x = (await S.readDescriptor(root))!;
      const file = kind === 'raml' && x.d.main ? x.d.main : fileName(kind, n), old = x.d.main;
      await invoke('write_file_exact', { root, path: file, text: starter(kind, n, secured) });
      if (old && old !== file) await invoke('delete_file', { root, path: old });
      await S.writeDescriptor(root, x.text, (d) => { d.main = file; });
      busy('Sending the starter file…');
      const paths = (await invoke<{ files: { path: string }[] }>('open_project', { root })).files.map((f) => f.path);
      await S.push(root, (await S.readLink(root))!, paths);
    }
    return root;
  }
  busy('Creating it…');
  const home = (await S.projectsDir()) + '/On this computer/';
  let root = home + n.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-');
  if ((await invoke<{ files: unknown[] }>('open_project', { root }).then((p) => p.files.length, () => 0))) root += ` (${Date.now().toString(36)})`;
  const file = fileName(kind, n.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-'));
  await invoke('write_file_exact', { root, path: file, text: starter(kind, n, secured) });
  // Design Center's descriptor, so the root file, Publish and Exchange see it the same way later.
  const classifier = KINDS[kind].head.startsWith('#%RAML 1.0\n') ? 'raml' : kind.startsWith('oas') ? 'oas' : isAsyncKind(kind) ? 'evented-api' : 'raml-fragment';
  await invoke('write_file_exact', { root, path: 'exchange.json', text: JSON.stringify({ main: file, name: n, classifier, tags: [], version: '1.0.0', dependencies: [] }, null, 2) + '\n' });
  return root;
}

export function CreateDialog({ what, onClose, onCreated }: { what: 'api' | 'fragment'; onClose: () => void; onCreated: (root: string, note: string | null) => void }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<Kind>(what === 'api' ? 'raml' : 'library');
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [inDc, setInDc] = useState(true);
  // Design Center's two ways to start an API: its visual editor or its code editor. Here it only picks
  // which is in front; the switch above the editor flips it any time.
  const [guide, setGuide] = useState(true);
  const [secured, setSecured] = useState(false);
  const [busy, setBusy] = useState<string | null>(null); const [err, setErr] = useState<string | null>(null);
  useEffect(() => { invoke<Me | null>('anypoint_status').then(setMe, () => setMe(null)); }, []);
  const dcOk = !!me && !me.read_only;
  const dc = dcOk && inDc;
  const [noName, setNoName] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const go = async () => {
    const n = name.trim(); setErr(null);
    if (!n) { setNoName(true); nameRef.current?.focus(); return; }
    try {
      const root = await makeProject(n, kind, dc, me ?? null, setBusy, secured && SECURED.includes(kind));
      try { if (what === 'api' && guide) localStorage.setItem('ads.guided:' + root, '1'); } catch { /* ignore */ }
      onCreated(root, null);
    }
    catch (e) { setErr(String(e).replace(/^Error: /, '')); setBusy(null); }
  };
  const list = what === 'api' ? API_KINDS : FRAGMENTS;
  return (
    <Modal title={what === 'api' ? 'New API Specification' : 'New Fragment'} sub={what === 'api' ? 'How the API behaves and what it exchanges' : 'Pieces to reuse across APIs'} onCancel={onClose} width={500}
      footer={<><span className="flex-1 flex items-center gap-2 text-[12px] text-content-muted">{busy && <><Spinner />{busy}</>}</span><button className={btn} onClick={onClose}>Cancel</button>
        <button className={btnPrimary} disabled={!!busy || me === undefined} onClick={go}>Create</button></>}>
      <div className="flex flex-col gap-3 text-[12.5px]">
        <label className="flex flex-col gap-1"><span className="text-[11.5px] text-content-faint">Project name <span className="text-err">*</span></span>
          <input ref={nameRef} autoFocus value={name} onChange={(e) => { setName(e.target.value); if (e.target.value.trim()) setNoName(false); }} onKeyDown={(e) => { if (e.key === 'Enter' && !busy) go(); }} spellCheck={false}
            className={field + (noName ? ' !border-err' : '')} />
          {noName && <span className="text-[11.5px] text-err">Give the project a name.</span>}</label>
        <label className="flex flex-col gap-1"><span className="text-[11.5px] text-content-faint">{what === 'api' ? 'Language' : 'Fragment type'}</span>
          <Select value={kind} onChange={(v) => setKind(v as Kind)} className="w-full" options={list.map((k) => ({ value: k, label: KINDS[k].label }))} /></label>
        {what === 'api' && SECURED.includes(kind) && <div className="flex flex-col gap-1.5">
          <span className="text-[11.5px] text-content-faint">Start from</span>
          {([[false, 'An empty spec', 'Just the title'], [true, 'A secured starter', isAsyncKind(kind) ? "Order events to rename: Kafka over TLS, SASL/SCRAM on every connection, closed message schemas, correlation ids. Passes MuleSoft's AsyncAPI best-practice and authentication rulesets." : "An Orders API to rename: HTTPS only, OAuth 2.0 on every call, error and rate-limit responses, correlation ids. Passes MuleSoft's best-practice and OWASP security rulesets."]] as const).map(([v, label, sub]) => (
            <label key={label} className="flex items-start gap-2 cursor-pointer">
              <input type="radio" checked={secured === v} onChange={() => setSecured(v)} className="mt-[3px] accent-[var(--accent)]" />
              <span>{label}<span className="block text-[11.5px] text-content-faint">{sub}</span></span></label>
          ))}
        </div>}
        {what === 'api' && <div className="flex flex-col gap-1.5">
          <span className="text-[11.5px] text-content-faint">How do you want to start?</span>
          {([[true, 'Guide me through it', 'Forms for each part, with the code next to them'], [false, "I'm comfortable designing it on my own", 'The code in front, the forms on the side']] as const).map(([v, label, sub]) => (
            <label key={label} className="flex items-start gap-2 cursor-pointer">
              <input type="radio" checked={guide === v} onChange={() => setGuide(v)} className="mt-[3px] accent-[var(--accent)]" />
              <span>{label}<span className="block text-[11.5px] text-content-faint">{sub}</span></span></label>
          ))}
        </div>}
        <div className="flex flex-col gap-1.5">
          <span className="text-[11.5px] text-content-faint">Where</span>
          {([[true, 'In Design Center, and here to work on'], [false, 'Only on this computer']] as const).map(([v, label]) => (
            <label key={label} className={`flex items-center gap-2 ${v && !dcOk ? 'opacity-50' : 'cursor-pointer'}`}>
              <input type="radio" checked={dc === v} disabled={v && !dcOk} onChange={() => setInDc(v)} className="accent-[var(--accent)]" />{label}</label>
          ))}
          {!dc && me !== undefined && <span className="text-[11.5px] text-content-faint">Publishing to Exchange goes through Design Center. You can put it there later from the project menu.</span>}
          {!dcOk && me !== undefined && <span className="text-[11.5px] text-content-faint">{!me ? 'Sign in to Anypoint to create it in Design Center too.' : 'The connection is read only, so it can only be made here. Turn read only off in settings to create it in Design Center.'}</span>}
        </div>
        {err && <div className="text-[12px] text-err select-text">{err}</div>}
      </div>
    </Modal>
  );
}

// ---------- New file (Files, +) ----------
export function NewFileDialog({ folder, hasRoot, onClose, onMake }: { folder: string; hasRoot: boolean; onClose: () => void; onMake: (path: string, text: string) => Promise<void> }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<Kind>(hasRoot ? 'library' : 'raml');
  const [err, setErr] = useState<string | null>(null);
  const path = (folder ? folder + '/' : '') + fileName(kind, name.trim());
  const go = async () => { setErr(null); try { await onMake(path, starter(kind, name.trim().replace(/\.[^.]+$/, '').split('/').pop()!)); } catch (e) { setErr(String(e).replace(/^Error: /, '')); } };
  return (
    <Modal title="New file" sub={folder ? `In ${folder}` : undefined} onCancel={onClose} width={460}
      footer={<><span className="flex-1 min-w-0 truncate font-mono text-[11.5px] text-content-faint">{name.trim() ? path : ''}</span><button className={btn} onClick={onClose}>Cancel</button>
        <button className={btnPrimary} disabled={!name.trim()} onClick={go}>Create</button></>}>
      <div className="flex flex-col gap-3 text-[12.5px]">
        <label className="flex flex-col gap-1"><span className="text-[11.5px] text-content-faint">Format</span>
          <Select value={kind} onChange={(v) => setKind(v as Kind)} className="w-full" options={[
            ...API_KINDS.map((k) => ({ value: k, label: KINDS[k].label, group: 'API specification' })),
            ...FRAGMENTS.map((k) => ({ value: k, label: KINDS[k].label, group: 'RAML fragment' })),
            ...(['jsonSchema', 'other'] as Kind[]).map((k) => ({ value: k, label: KINDS[k].label, group: 'Other' }))]} /></label>
        <label className="flex flex-col gap-1"><span className="text-[11.5px] text-content-faint">Name</span>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) go(); }} spellCheck={false} placeholder={kind === 'other' ? 'notes.md' : 'name'} className={`${field} font-mono`} />
          <span className="text-[11.5px] text-content-faint">A / makes folders, like examples/order.</span></label>
        {err && <div className="text-[12px] text-err select-text">{err}</div>}
      </div>
    </Modal>
  );
}
