// Design Center's Create (New API Specification, New Fragment) for the start screen, and New file for the
// Files panel's + menu. The starter text is Design Center's own where it has one, so new files look the same.
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { documentDir } from '@tauri-apps/api/path';
import { Modal, Spinner, btn, btnPrimary } from './App';
import type { Me } from './SyncUI';
import * as S from './sync';

// Every kind of file: label, extension, and for fragments the subType Design Center's API takes (probed).
export const KINDS = {
  raml: { label: 'RAML 1.0', ext: 'raml', head: '#%RAML 1.0\ntitle: {name}\n' },
  oas3yaml: { label: 'OAS 3.0 (YAML)', ext: 'yaml', head: 'openapi: 3.0.0\ninfo:\n  title: {name}\n  version: 1.0.0\npaths: {}\n' },
  oas3json: { label: 'OAS 3.0 (JSON)', ext: 'json', head: '{\n  "openapi": "3.0.0",\n  "info": {\n    "title": "{name}",\n    "version": "1.0.0"\n  },\n  "paths": {}\n}\n' },
  oas2json: { label: 'OAS 2.0 (JSON)', ext: 'json', head: '{\n  "swagger": "2.0",\n  "info": {\n    "version": "1.0.0",\n    "title": "{name}"\n  },\n  "paths": {}\n}\n' },
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
const API_KINDS: Kind[] = ['raml', 'oas3yaml', 'oas3json', 'oas2json', 'oas2yaml'];
const FRAGMENTS: Kind[] = ['library', 'type', 'trait', 'resourceType', 'example', 'docs', 'annotationType', 'securityScheme', 'overlay', 'extension'];
export const starter = (k: Kind, name: string) => KINDS[k].head.split('{name}').join(name);
const fileName = (k: Kind, name: string) => (KINDS[k].ext && !name.toLowerCase().endsWith('.' + KINDS[k].ext) ? `${name}.${KINDS[k].ext}` : name);
const field = 'h-[28px] px-2 rounded-md border border-line bg-surface-input text-[12.5px] outline-none focus:border-accent';

// ---------- Create: a new project, in Design Center and here, or only here ----------
export function CreateDialog({ what, onClose, onCreated }: { what: 'api' | 'fragment'; onClose: () => void; onCreated: (root: string, note: string | null) => void }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<Kind>(what === 'api' ? 'raml' : 'library');
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [inDc, setInDc] = useState(true);
  const [busy, setBusy] = useState<string | null>(null); const [err, setErr] = useState<string | null>(null);
  useEffect(() => { invoke<Me | null>('anypoint_status').then(setMe, () => setMe(null)); }, []);
  const dcOk = !!me && !me.read_only;
  const dc = dcOk && inDc;
  const go = async () => {
    const n = name.trim(); setErr(null);
    try {
      if (dc) {
        setBusy('Creating it in Design Center…');
        const id = await S.createProject(n, KINDS[kind].head.startsWith('#%RAML 1.0\n') ? 'raml' : kind.startsWith('oas') ? 'oas' : 'raml-fragment', (KINDS[kind] as { sub?: string }).sub);
        const root = await S.projectFolder(me!.org_name || 'Anypoint', n, id);
        setBusy('Pulling it here…');
        await S.clone(root, id, n, 'master');
        // Design Center starts every OAS project as OAS 2.0 JSON: another flavour is written here and pushed.
        if (kind !== 'oas2json' && kind.startsWith('oas')) {
          const x = (await S.readDescriptor(root))!;
          const file = fileName(kind, n), old = x.d.main;
          await invoke('write_file_exact', { root, path: file, text: starter(kind, n) });
          if (old && old !== file) await invoke('delete_file', { root, path: old });
          await S.writeDescriptor(root, x.text, (d) => { d.main = file; });
          setBusy('Sending the starter file…');
          const paths = (await invoke<{ files: { path: string }[] }>('open_project', { root })).files.map((f) => f.path);
          await S.push(root, (await S.readLink(root))!, paths);
        }
        onCreated(root, null);
      } else {
        setBusy('Creating it…');
        const home = (await documentDir()).replace(/\\/g, '/').replace(/\/+$/, '') + '/API Designer Studio/On this computer/';
        let root = home + n.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-');
        if ((await invoke<{ files: unknown[] }>('open_project', { root }).then((p) => p.files.length, () => 0))) root += ` (${Date.now().toString(36)})`;
        const file = fileName(kind, n.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-'));
        await invoke('write_file_exact', { root, path: file, text: starter(kind, n) });
        // Design Center's descriptor, so the root file, Publish and Exchange see it the same way later.
        const classifier = KINDS[kind].head.startsWith('#%RAML 1.0\n') ? 'raml' : kind.startsWith('oas') ? 'oas' : 'raml-fragment';
        await invoke('write_file_exact', { root, path: 'exchange.json', text: JSON.stringify({ main: file, name: n, classifier, tags: [], version: '1.0.0', dependencies: [] }, null, 2) + '\n' });
        onCreated(root, null);
      }
    } catch (e) { setErr(String(e).replace(/^Error: /, '')); setBusy(null); }
  };
  const list = what === 'api' ? API_KINDS : FRAGMENTS;
  return (
    <Modal title={what === 'api' ? 'New API Specification' : 'New Fragment'} sub={what === 'api' ? 'How the API behaves and what it exchanges' : 'Pieces to reuse across APIs'} onCancel={onClose} width={500}
      footer={<><span className="flex-1 flex items-center gap-2 text-[12px] text-content-muted">{busy && <><Spinner />{busy}</>}</span><button className={btn} onClick={onClose}>Cancel</button>
        <button className={btnPrimary} disabled={!name.trim() || !!busy || me === undefined} onClick={go}>Create</button></>}>
      <div className="flex flex-col gap-3 text-[12.5px]">
        <label className="flex flex-col gap-1"><span className="text-[11.5px] text-content-faint">Project name</span>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && name.trim() && !busy) go(); }} spellCheck={false} className={field} /></label>
        <label className="flex flex-col gap-1"><span className="text-[11.5px] text-content-faint">{what === 'api' ? 'Language' : 'Fragment type'}</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as Kind)} className={field}>{list.map((k) => <option key={k} value={k}>{KINDS[k].label}</option>)}</select></label>
        <div className="flex flex-col gap-1.5">
          <span className="text-[11.5px] text-content-faint">Where</span>
          {([[true, 'In Design Center, and here to work on'], [false, 'Only on this computer']] as const).map(([v, label]) => (
            <label key={label} className={`flex items-center gap-2 ${v && !dcOk ? 'opacity-50' : 'cursor-pointer'}`}>
              <input type="radio" checked={dc === v} disabled={v && !dcOk} onChange={() => setInDc(v)} className="accent-[var(--accent)]" />{label}</label>
          ))}
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
          <select value={kind} onChange={(e) => setKind(e.target.value as Kind)} className={field}>
            <optgroup label="API specification">{API_KINDS.map((k) => <option key={k} value={k}>{KINDS[k].label}</option>)}</optgroup>
            <optgroup label="RAML fragment">{FRAGMENTS.map((k) => <option key={k} value={k}>{KINDS[k].label}</option>)}</optgroup>
            <optgroup label="Other">{(['jsonSchema', 'other'] as Kind[]).map((k) => <option key={k} value={k}>{KINDS[k].label}</option>)}</optgroup>
          </select></label>
        <label className="flex flex-col gap-1"><span className="text-[11.5px] text-content-faint">Name</span>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) go(); }} spellCheck={false} placeholder={kind === 'other' ? 'notes.md' : 'name'} className={`${field} font-mono`} />
          <span className="text-[11.5px] text-content-faint">A / makes folders, like examples/order.</span></label>
        {err && <div className="text-[12px] text-err select-text">{err}</div>}
      </div>
    </Modal>
  );
}
