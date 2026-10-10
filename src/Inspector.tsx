// The Inspector (M2): a form for whatever the cursor is in (the API root, a resource, a method, a type,
// a trait), next to the code. It reads the text, and every change it makes is a minimal splice of the
// text (src/splice.ts) applied through the editor, so Ctrl Z undoes it and the code stays the master.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Icons } from './components/Icons';
import { METHODS, BUILTIN_TYPES, entries, kids, kid, keyPathAt, libraryPaths, type Outline } from './raml';
import * as S from './splice';

type Node =
  | { kind: 'root' }
  | { kind: 'res'; path: string[]; url: string }
  | { kind: 'method'; path: string[]; url: string; m: string }
  | { kind: 'decl'; sect: string; path: string[]; name: string }
  | { kind: 'none' };

const DECL_SECTS: Record<string, string> = { types: 'Type', traits: 'Trait', resourceTypes: 'Resource type', securitySchemes: 'Security scheme', annotationTypes: 'Annotation type' };

export function nodeAt(text: string, line: number, isMain: boolean): Node {
  const kp = keyPathAt(text, line);
  if (kp.length && kp[0].key.startsWith('/')) {
    let i = 0; while (i < kp.length && kp[i].key.startsWith('/')) i++;
    const res = kp.slice(0, i).map((e) => e.key);
    if (i < kp.length && METHODS.includes(kp[i].key)) return { kind: 'method', path: [...res, kp[i].key], url: res.join(''), m: kp[i].key };
    return { kind: 'res', path: res, url: res.join('') };
  }
  if (kp.length >= 2 && DECL_SECTS[kp[0].key]) return { kind: 'decl', sect: kp[0].key, path: [kp[0].key, kp[1].key], name: kp[1].key };
  return isMain ? { kind: 'root' } : { kind: 'none' };
}

const CODES: Record<string, string> = { 200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No content', 400: 'Bad request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not found', 409: 'Conflict', 422: 'Unprocessable', 500: 'Server error', 502: 'Bad gateway', 503: 'Unavailable' };
const MEDIA = ['application/json', 'application/xml', 'text/plain', 'multipart/form-data', 'application/x-www-form-urlencoded'];
const METHOD_STYLE: Record<string, string> = {
  get: 'text-cyan bg-cyan-tint', post: 'text-[var(--ok)] bg-[color-mix(in_oklch,var(--ok)_14%,transparent)]', put: 'text-warn bg-warn-tint',
  patch: 'text-violet bg-violet-tint', delete: 'text-err bg-err-tint', head: 'text-content-muted bg-surface-3', options: 'text-content-muted bg-surface-3',
};
const Badge = ({ m }: { m: string }) => <span className={`font-mono text-[9.5px] font-bold w-[38px] h-4 rounded-[3px] shrink-0 inline-flex items-center justify-center ${METHOD_STYLE[m] ?? ''}`}>{m.toUpperCase()}</span>;
const codeColor = (c: string) => (c[0] === '2' ? 'var(--ok)' : c[0] === '4' ? 'var(--warn)' : c[0] === '5' ? 'var(--err)' : 'var(--content-muted)');

// A text box that writes on Enter or when you leave it; Escape puts the old value back.
function Field({ value, onCommit, placeholder, mono, multiline, list, className = '' }: {
  value: string; onCommit: (v: string) => void; placeholder?: string; mono?: boolean; multiline?: boolean; list?: string; className?: string;
}) {
  const [v, setV] = useState(value);
  const skip = useRef(false);
  useEffect(() => setV(value), [value]);
  const cls = `w-full min-w-0 px-2 rounded border border-line bg-surface-input text-content outline-none focus:border-accent placeholder:text-content-ghost ${mono ? 'font-mono text-[11.5px]' : 'text-[12.5px]'} ${className}`;
  // The box's own value, not state: a change and a blur can arrive before React has re-rendered.
  const onBlur = (e: { currentTarget: HTMLInputElement | HTMLTextAreaElement }) => { if (skip.current) { skip.current = false; return; } const nv = e.currentTarget.value; if (nv !== value) onCommit(nv); };
  const esc = (e: { key: string; currentTarget: HTMLElement }) => { if (e.key === 'Escape') { skip.current = true; setV(value); e.currentTarget.blur(); } };
  return multiline
    ? <textarea value={v} placeholder={placeholder} spellCheck={false} rows={Math.min(8, Math.max(2, v.split('\n').length))} onChange={(e) => setV(e.target.value)} onBlur={onBlur}
        onKeyDown={(e) => { esc(e); if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) e.currentTarget.blur(); }} className={cls + ' py-1 resize-y leading-snug'} />
    : <input value={v} placeholder={placeholder} spellCheck={false} list={list} onChange={(e) => setV(e.target.value)} onBlur={onBlur}
        onKeyDown={(e) => { esc(e); if (e.key === 'Enter') e.currentTarget.blur(); }} className={cls + ' h-[26px]'} />;
}

const IconBtn = ({ title, onClick, children }: { title: string; onClick: () => void; children: ReactNode }) => (
  <button title={title} onClick={(e) => { e.stopPropagation(); onClick(); }} className="w-[22px] h-[22px] shrink-0 rounded flex items-center justify-center text-content-faint hover:bg-surface-3 hover:text-content">{children}</button>
);

function Sec({ title, count, add, children }: { title: string; count?: number; add?: ReactNode; children: ReactNode }) {
  return (
    <div className="mt-[18px]">
      <h4 className="m-0 mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.5px] text-content-faint">
        {title}{count != null && <span className="text-content-ghost tracking-normal">{count}</span>}
        <span className="flex-1" />{add}
      </h4>
      {children}
    </div>
  );
}

// A small picker that looks like a button: "+ Add response" with the choices in a native select.
function AddSelect({ label, options, onPick }: { label: string; options: string[]; onPick: (v: string) => void }) {
  if (!options.length) return null;
  return (
    <label className="relative normal-case tracking-normal font-medium text-[11px] text-accent hover:underline cursor-pointer flex items-center gap-0.5">
      <Icons.Plus size={11} />{label}
      <select value="" onChange={(e) => { if (e.target.value) onPick(e.target.value); }} className="absolute inset-0 opacity-0 cursor-pointer">
        <option value="" />
        {options.map((o) => <option key={o} value={o}>{o}{CODES[o] ? `  ${CODES[o]}` : ''}</option>)}
      </select>
    </label>
  );
}

export function Inspector({ file, text, line, isMain, rootFile, outline, textOf, onEdit, onGoLine, onOpen, onRename }: {
  file: string; text: string; line: number; isMain: boolean; rootFile: string; outline: Outline | null; textOf: (path: string) => string | undefined;
  onEdit: (fn: (t: string) => string) => void; onGoLine: (line: number) => void; onOpen: (file: string, from: number) => void;
  onRename: (from: number) => void;
}) {
  const E = useMemo(() => entries(text), [text]);
  const L = useMemo(() => text.split('\n'), [text]);
  const node = useMemo(() => nodeAt(text, line, isMain), [text, line, isMain]);
  const own = outline?.libraries.find((l) => l.path === file)?.alias ?? null;
  // Names this file can refer to: its own declarations bare, the others through the root's aliases.
  const typeNames = useMemo(() => [...(outline?.types ?? []).map((d) => (d.alias && d.alias !== own ? `${d.alias}.${d.name}` : d.name)), ...BUILTIN_TYPES], [outline, own]);
  const traitNames = (outline?.traits ?? []).map((d) => (d.alias && d.alias !== own ? `${d.alias}.${d.name}` : d.name));
  const findType = (t: string) => {
    const name = t.replace(/\[\]$/, '').replace(/\?$/, '');
    const [a, n] = name.includes('.') ? name.split('.') : [own, name];
    return outline?.types.find((d) => d.name === n && (d.alias ?? null) === (a ?? null)) ?? null;
  };

  // The rows of a block, with the lines they cover, so the row under the cursor is highlighted.
  const at = (path: string[]) => S.find(E, path);
  const span = (k: number) => [E[k].line, S.blockEnd(E, L, k)];
  const here = (k: number) => { const [a, b] = span(k); return line >= a && line < b; };
  const rowCls = (k: number) => `group/r rounded-md px-1.5 -mx-1.5 ${here(k) ? 'bg-accent-dim' : 'hover:bg-[var(--hover-overlay)]'}`;
  const unique = (base: string, have: string[]) => { let n = base, i = 2; while (have.includes(n) || have.includes(n + '?')) n = base + i++; return n; };

  const typeCell = (path: string[]) => {
    const t = S.typeOf(text, path), d = t && findType(t);
    const known = !t || d || BUILTIN_TYPES.includes(t.replace(/\[\]$/, '')) || /[|(]/.test(t);
    return (
      <span className="flex items-center gap-0.5 min-w-0 flex-1">
        <Field value={t} mono list="ads-types" placeholder="string" onCommit={(v) => onEdit((x) => S.setType(x, path, v))} className={known ? 'text-[var(--syn-type)]' : 'text-err'} />
        {d && <IconBtn title={`Go to ${d.name}`} onClick={() => onOpen(d.file, d.from)}><Icons.ChevronRight size={12} /></IconBtn>}
      </span>
    );
  };

  // Query parameters, headers, URI parameters and type properties share one editor: name, type, required.
  const params = (parent: string[], key: string, title: string, addLabel: string, hint?: string) => {
    const k = at([...parent, key]);
    const rows = k < 0 ? [] : kids(E, k);
    const names = rows.map((j) => E[j].key);
    return (
      <Sec title={title} count={rows.length || undefined}
        add={<button onClick={() => onEdit((x) => S.addChild(x, [...parent, key], [`${unique(key === 'properties' ? 'property' : key === 'headers' ? 'X-Header' : 'param', names)}: string`]))}
          className="normal-case tracking-normal font-medium text-[11px] text-accent hover:underline flex items-center gap-0.5"><Icons.Plus size={11} />{addLabel}</button>}>
        {rows.length === 0 && <div className="text-[11.5px] text-content-faint">{hint ?? 'None.'}</div>}
        {rows.map((j) => {
          const p = [...parent, key, E[j].key];
          const r = kid(E, j, 'required');
          const optional = E[j].key.endsWith('?') || (r != null && E[r].val === 'false');
          const name = E[j].key.replace(/\?$/, '');
          return (
            <div key={E[j].key} className={rowCls(j) + ' flex items-center gap-1 py-[3px]'} onClick={() => onGoLine(E[j].line)}>
              <span className="w-[38%] shrink-0"><Field value={name} mono onCommit={(v) => v && onEdit((x) => S.renameKey(x, p, E[j].key.endsWith('?') ? v + '?' : v))} /></span>
              {typeCell(p)}
              <label title="Required" className="shrink-0 flex items-center gap-1 text-[10.5px] text-content-faint cursor-pointer" onClick={(e) => e.stopPropagation()}>
                <input type="checkbox" checked={!optional} onChange={(e) => onEdit((x) => S.setOptional(x, p, !e.target.checked))} className="accent-[var(--accent)]" />req
              </label>
              <span className="opacity-0 group-hover/r:opacity-100"><IconBtn title="Remove" onClick={() => onEdit((x) => S.remove(x, p))}><Icons.X size={11} /></IconBtn></span>
            </div>
          );
        })}
      </Sec>
    );
  };

  const example = (path: string[]) => {
    const k = at(path); if (k < 0) return null;
    const inc = E[k].val.match(/^!include\s+(\S+)/);
    if (!inc) return <div className="mt-1 text-[11px] text-content-faint">Example written inline</div>;
    const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/') + 1) : '';
    const target = inc[1].startsWith('/') ? inc[1].slice(1) : (dir + inc[1]).split('/').reduce<string[]>((a, s) => (s === '..' ? a.slice(0, -1) : s && s !== '.' ? [...a, s] : a), []).join('/');
    return <button onClick={() => onOpen(target, 0)} title={target} className="mt-1 flex items-center gap-1.5 max-w-full text-[11px] text-[var(--syn-string)] hover:underline"><Icons.File size={11} /><span className="font-mono truncate">{inc[1].split('/').pop()}</span></button>;
  };

  // A body: one row per media type, or the default media type when the body names a type directly.
  const body = (parent: string[], compact = false) => {
    const k = at([...parent, 'body']);
    const media = k < 0 ? [] : kids(E, k).filter((j) => E[j].key.includes('/'));
    const direct = k >= 0 && !media.length && kids(E, k).length > 0;
    const have = media.map((j) => E[j].key);
    const rows = (
      <>
        {direct && <div className="flex items-center gap-1.5"><span className="text-[11px] font-mono text-content-faint shrink-0">default</span>{typeCell([...parent, 'body'])}</div>}
        {media.map((j) => {
          const p = [...parent, 'body', E[j].key];
          return (
            <div key={E[j].key} className={rowCls(j) + ' py-[3px]'} onClick={() => onGoLine(E[j].line)}>
              <div className="flex items-center gap-1.5">
                <span className="text-[11px] font-mono text-content-faint shrink-0 max-w-[45%] truncate" title={E[j].key}>{E[j].key}</span>
                {typeCell(p)}
                <span className="opacity-0 group-hover/r:opacity-100"><IconBtn title="Remove" onClick={() => onEdit((x) => S.remove(x, p))}><Icons.X size={11} /></IconBtn></span>
              </div>
              {example([...p, 'example'])}
            </div>
          );
        })}
      </>
    );
    const add = !direct ? <AddSelect label={compact ? 'Body' : 'Add'} options={MEDIA.filter((m) => !have.includes(m))} onPick={(m) => onEdit((x) => S.addChild(x, [...parent, 'body'], [`${m}:`]))} /> : null;
    if (compact) return <div className="mt-1.5 flex flex-col gap-0.5">{rows}{!direct && !media.length && <div className="flex">{add}</div>}</div>;
    return <Sec title="Request body" add={add}>{rows}{k < 0 && <div className="text-[11.5px] text-content-faint">No body.</div>}</Sec>;
  };

  const traits = (parent: string[]) => {
    const k = at([...parent, 'is']);
    const raw = k >= 0 ? E[k].val : '';
    const cur = S.list(text, [...parent, 'is']) ?? [];
    const fixed = raw.includes('{'); // traits with parameters: edit those in the code
    return (
      <Sec title="Traits" count={cur.length || undefined} add={fixed ? null : <AddSelect label="Add" options={traitNames.filter((t) => !cur.includes(t))} onPick={(t) => onEdit((x) => S.setList(x, [...parent, 'is'], [...cur, t]))} />}>
        {fixed ? <div className="font-mono text-[11.5px] text-content-secondary break-all">{raw}</div>
          : cur.length ? <div className="flex flex-wrap gap-[5px]">{cur.map((t) => {
            const d = outline?.traits.find((x) => (x.alias && x.alias !== own ? `${x.alias}.${x.name}` : x.name) === t);
            return (
              <span key={t} className="inline-flex items-center gap-1 h-[22px] pl-2 pr-0.5 rounded font-mono text-[11.5px] text-violet bg-violet-tint border border-[color-mix(in_oklch,var(--violet)_25%,transparent)]">
                <span className={d ? 'cursor-pointer hover:underline' : ''} onClick={() => d && onOpen(d.file, d.from)}>{t}</span>
                <IconBtn title="Remove" onClick={() => onEdit((x) => S.setList(x, [...parent, 'is'], cur.filter((c) => c !== t)))}><Icons.X size={10} /></IconBtn>
              </span>
            );
          })}</div>
          : <div className="text-[11.5px] text-content-faint">None.</div>}
      </Sec>
    );
  };

  const docs = (path: string[], what: string) => (
    <div className="mt-3 flex flex-col gap-1.5">
      <Field value={S.scalar(text, [...path, 'displayName']) ?? ''} placeholder={`Display name for this ${what}`} onCommit={(v) => onEdit((x) => S.setScalar(x, path, 'displayName', v || null))} />
      <Field multiline value={S.scalar(text, [...path, 'description']) ?? ''} placeholder="Description" onCommit={(v) => onEdit((x) => S.setScalar(x, path, 'description', v || null))} />
    </div>
  );

  const loc = (k: number) => <button onClick={() => onGoLine(E[k].line)} className="mt-0.5 block font-mono text-[11px] text-content-faint hover:text-accent">{file}:{E[k].line + 1}</button>;
  const title = (inner: ReactNode) => <div className="flex items-center gap-2 min-w-0">{inner}</div>;
  let h: ReactNode;

  if (node.kind === 'method') {
    const k = at(node.path);
    const rk = at([...node.path, 'responses']);
    const codes = rk < 0 ? [] : kids(E, rk);
    // URI parameters come from the resources above: declared ones, and {names} in the path that aren't declared.
    const uri: { name: string; type: string; declared: boolean }[] = [];
    for (let i = 1; i < node.path.length; i++) {
      const rp = node.path.slice(0, i), uk = at([...rp, 'uriParameters']);
      if (uk >= 0) kids(E, uk).forEach((j) => uri.push({ name: E[j].key.replace(/\?$/, ''), type: S.typeOf(text, [...rp, 'uriParameters', E[j].key]) || 'string', declared: true }));
    }
    for (const m of node.url.matchAll(/\{(\w+)\}/g)) if (!uri.some((u) => u.name === m[1])) uri.push({ name: m[1], type: 'string', declared: false });
    h = (
      <>
        {title(<><Badge m={node.m} /><span className="font-mono text-[13.5px] font-bold break-all">{node.url}</span></>)}
        {k >= 0 && loc(k)}
        {docs(node.path, 'method')}
        {traits(node.path)}
        {uri.length > 0 && (
          <Sec title="URI parameters" count={uri.length}>
            {uri.map((u) => <div key={u.name} className="flex items-center gap-2 py-[3px] text-[12px]"><span className="font-mono">{u.name}</span><span className="font-mono text-[var(--syn-type)]">{u.type}</span>{!u.declared && <span className="ml-auto text-[10.5px] text-content-faint">from the path</span>}</div>)}
            <div className="text-[11px] text-content-faint">Edit them on the resource.</div>
          </Sec>
        )}
        {params(node.path, 'queryParameters', 'Query parameters', 'Add')}
        {params(node.path, 'headers', 'Headers', 'Add')}
        {['post', 'put', 'patch'].includes(node.m) || at([...node.path, 'body']) >= 0 ? body(node.path) : null}
        <Sec title="Responses" count={codes.length || undefined}
          add={<AddSelect label="Add response" options={Object.keys(CODES).filter((c) => !codes.some((j) => E[j].key === c))} onPick={(c) => onEdit((x) => S.addChild(x, [...node.path, 'responses'], [`${c}:`]))} />}>
          {codes.length === 0 && <div className="text-[11.5px] text-content-faint">No responses yet.</div>}
          {codes.map((j) => {
            const p = [...node.path, 'responses', E[j].key];
            return (
              <div key={E[j].key} className={rowCls(j) + ' border border-line rounded-md p-2 mb-1.5 mx-0 bg-bg'} onClick={() => onGoLine(E[j].line)}>
                <div className="flex items-center gap-2">
                  <span className="font-mono font-bold text-[11.5px] px-1.5 rounded-[3px]" style={{ color: codeColor(E[j].key), background: `color-mix(in oklch, ${codeColor(E[j].key)} 13%, transparent)` }}>{E[j].key}</span>
                  <Field value={S.scalar(text, [...p, 'description']) ?? ''} placeholder={CODES[E[j].key] ?? 'Description'} onCommit={(v) => onEdit((x) => S.setScalar(x, p, 'description', v || null))} />
                  <span className="opacity-0 group-hover/r:opacity-100"><IconBtn title="Remove this response" onClick={() => onEdit((x) => S.remove(x, p, false))}><Icons.X size={11} /></IconBtn></span>
                </div>
                {body(p, true)}
              </div>
            );
          })}
        </Sec>
      </>
    );
  } else if (node.kind === 'res') {
    const k = at(node.path);
    const ch = k < 0 ? [] : kids(E, k);
    const methods = ch.filter((j) => METHODS.includes(E[j].key));
    const nested = ch.filter((j) => E[j].key.startsWith('/'));
    const rt = k >= 0 ? kid(E, k, 'type') : undefined;
    h = (
      <>
        {title(<span className="font-mono text-[13.5px] font-bold break-all">{node.url}</span>)}
        {k >= 0 && loc(k)}
        <div className="mt-1 text-[12.5px] text-content-secondary">{methods.length} {methods.length === 1 ? 'method' : 'methods'}{nested.length ? `, ${nested.length} nested` : ''}</div>
        {docs(node.path, 'resource')}
        <Sec title="Resource type">
          {rt != null && E[rt].val.includes('{') ? <div className="font-mono text-[11.5px] text-content-secondary break-all">{E[rt].val}</div>
            : <Field value={rt != null ? S.unquote(E[rt].val) : ''} mono list="ads-rtypes" placeholder="None" onCommit={(v) => onEdit((x) => S.setScalar(x, node.path, 'type', v || null))} />}
        </Sec>
        {traits(node.path)}
        <Sec title="Methods" count={methods.length || undefined} add={<AddSelect label="Add method" options={METHODS.filter((m) => !methods.some((j) => E[j].key === m))} onPick={(m) => onEdit((x) => S.addChild(x, node.path, [`${m}:`]))} />}>
          {methods.map((j) => <div key={E[j].key} onClick={() => onGoLine(E[j].line)} className="flex items-center gap-2 px-1.5 -mx-1.5 py-1 rounded-md cursor-pointer hover:bg-[var(--hover-overlay)]"><Badge m={E[j].key} /><span className="text-[12px] truncate">{S.scalar(text, [...node.path, E[j].key, 'displayName']) ?? ''}</span></div>)}
          {!methods.length && <div className="text-[11.5px] text-content-faint">None yet.</div>}
        </Sec>
        {params(node.path, 'uriParameters', 'URI parameters', 'Add', 'None declared. Names in {braces} are strings.')}
        <Sec title="Nested resources" count={nested.length || undefined}>
          {nested.map((j) => <div key={E[j].key} onClick={() => onGoLine(E[j].line)} className="flex items-center gap-2 px-1.5 -mx-1.5 py-1 rounded-md cursor-pointer hover:bg-[var(--hover-overlay)]"><span className="font-mono text-[11.5px]">{E[j].key}</span><span className="ml-auto text-[10.5px] text-content-faint">{kids(E, j).filter((x) => METHODS.includes(E[x].key)).map((x) => E[x].key.toUpperCase()).join(' ')}</span></div>)}
          <div className="mt-1"><Field value="" mono placeholder="Add one, like /{id}" onCommit={(v) => { const r = v.trim(); if (r) onEdit((x) => S.addChild(x, node.path, [`${r.startsWith('/') ? r : '/' + r}:`])); }} /></div>
        </Sec>
      </>
    );
  } else if (node.kind === 'decl') {
    const k = at(node.path);
    const d = outline && [...outline.types, ...outline.traits, ...outline.resourceTypes, ...outline.securitySchemes].find((x) => x.file === file && x.name === node.name);
    const isType = node.sect === 'types';
    const enumK = at([...node.path, 'enum']);
    const used = isType && d ? usages(d.name, d.file, rootFile, textOf, outline) : [];
    h = (
      <>
        {title(<><span className="font-mono text-[13.5px] font-bold break-all">{node.name}</span>{d?.alias && <span className="ml-auto text-[11.5px] text-content-faint">{d.alias}</span>}</>)}
        <div className="mt-1 text-[12.5px] text-content-secondary">{DECL_SECTS[node.sect]}</div>
        {k >= 0 && loc(k)}
        <div className="mt-3 flex gap-1.5">
          {d && <button onClick={() => onRename(d.from)} className="h-[26px] px-2.5 rounded-md text-[12px] border border-line bg-surface-2 text-content-secondary hover:text-content">Rename…</button>}
        </div>
        {isType && <Sec title="Type">{typeCell(node.path)}</Sec>}
        <div className="mt-3"><Field multiline value={S.scalar(text, [...node.path, 'description']) ?? ''} placeholder="Description" onCommit={(v) => onEdit((x) => S.setScalar(x, node.path, 'description', v || null))} /></div>
        {node.sect === 'traits' && <div className="mt-1.5"><Field value={S.scalar(text, [...node.path, 'usage']) ?? ''} placeholder="Usage" onCommit={(v) => onEdit((x) => S.setScalar(x, node.path, 'usage', v || null))} /></div>}
        {isType && enumK >= 0 && (
          <Sec title="Values" count={(S.list(text, [...node.path, 'enum']) ?? []).length}>
            <Field mono value={(S.list(text, [...node.path, 'enum']) ?? []).join(', ')} onCommit={(v) => onEdit((x) => S.setList(x, [...node.path, 'enum'], v.split(',').map((s) => s.trim()).filter(Boolean)))} />
            <div className="mt-1 text-[11px] text-content-faint">Separated by commas.</div>
          </Sec>
        )}
        {isType && enumK < 0 && params(node.path, 'properties', 'Properties', 'Add property', 'No properties.')}
        {isType && (
          <Sec title="Used by" count={used.length}>
            {used.slice(0, 40).map((u, i) => (
              <div key={i} onClick={() => onOpen(u.file, u.from)} className="flex items-center gap-2 px-1.5 -mx-1.5 py-1 rounded-md cursor-pointer hover:bg-[var(--hover-overlay)] text-[12px]">
                {u.m ? <Badge m={u.m} /> : <span className="font-mono text-[9.5px] font-bold w-4 h-4 rounded-[3px] inline-flex items-center justify-center text-[var(--syn-number)] bg-[color-mix(in_oklch,var(--syn-number)_16%,transparent)]">T</span>}
                <span className="font-mono text-[11.5px] truncate">{u.label}</span><span className="ml-auto text-[11px] text-content-faint whitespace-nowrap">{u.where}</span>
              </div>
            ))}
            {used.length === 0 && <div className="text-[11.5px] text-content-faint">Nothing uses this type.</div>}
          </Sec>
        )}
      </>
    );
  } else if (node.kind === 'root') {
    const field = (key: string, placeholder: string, mono = false) => (
      <label className="flex items-center gap-2 py-[3px]"><span className="w-[72px] shrink-0 text-[11.5px] text-content-faint">{key}</span>
        <Field value={S.scalar(text, [key]) ?? ''} mono={mono} placeholder={placeholder} onCommit={(v) => onEdit((x) => S.setScalar(x, [], key, v || null))} /></label>
    );
    const all: number[] = []; const walk = (k: number) => { all.push(k); kids(E, k).filter((j) => E[j].key.startsWith('/')).forEach(walk); };
    E.forEach((e, i) => { if (e.ind === 0 && e.key.startsWith('/')) walk(i); });
    const nMethods = all.reduce((a, k) => a + kids(E, k).filter((j) => METHODS.includes(E[j].key)).length, 0);
    h = (
      <>
        {title(<span className="text-[13.5px] font-bold">{S.scalar(text, ['title']) || 'Untitled API'}</span>)}
        <div className="mt-1 text-[12.5px] text-content-secondary">{all.length} resources, {nMethods} methods, {outline?.types.length ?? 0} types</div>
        <Sec title="API">
          {field('title', 'Name of the API')}
          {field('version', 'v1', true)}
          {field('baseUri', 'https://api.example.com/{version}', true)}
          {field('mediaType', 'application/json', true)}
        </Sec>
        <div className="mt-3"><Field multiline value={S.scalar(text, ['description']) ?? ''} placeholder="Description" onCommit={(v) => onEdit((x) => S.setScalar(x, [], 'description', v || null))} /></div>
        <div className="mt-4 text-[11.5px] text-content-faint">Put the cursor in a resource, method or type, or pick one in the API tree, to edit it here.</div>
      </>
    );
  } else {
    h = <div className="text-content-faint text-[12.5px] text-center px-4 pt-10"><span className="inline-flex"><Icons.Target size={22} /></span><div className="mt-2">Put the cursor in a resource, method or type, or pick one in the tree, to see it here.</div></div>;
  }

  return (
    <div className="flex-1 overflow-auto px-3.5 pt-3.5 pb-6 select-none">
      {h}
      <datalist id="ads-types">{typeNames.map((t) => <option key={t} value={t} />)}</datalist>
      <datalist id="ads-rtypes">{(outline?.resourceTypes ?? []).map((d) => { const n = d.alias && d.alias !== own ? `${d.alias}.${d.name}` : d.name; return <option key={n} value={n} />; })}</datalist>
    </div>
  );
}

// Where a type is used: through each file's aliases for its library, and bare inside its own file.
// Only value positions count (type:, items:, "name: Type", unions), never descriptions.
function usages(name: string, declFile: string, rootFile: string, textOf: (p: string) => string | undefined, outline: Outline | null) {
  if (!outline) return [];
  const out: { file: string; from: number; m: string | null; label: string; where: string }[] = [];
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const files = [...new Set([rootFile, ...outline.libraries.map((l) => l.path), declFile])];
  for (const f of files) {
    const t = textOf(f); if (t == null) continue;
    const names = libraryPaths(f, t).filter((l) => l.path === declFile).map((l) => `${esc(l.alias)}\\.${esc(name)}`);
    if (f === declFile) names.push(esc(name));
    if (!names.length) continue;
    const re = new RegExp(`(^|[\\s|(\\[,:])(${names.join('|')})(?=(\\[\\])?\\??($|[\\s|),\\]]))`);
    let pos = 0;
    t.split('\n').forEach((l, i) => {
      const m = l.match(/^(\s*(?:- )?[^:#]+?\s*:\s*)(.+)$/);
      if (m && !/^\s*(description|displayName|usage|title|example|examples|pattern)\s*:/.test(l) && re.test(m[2])) {
        const kp = keyPathAt(t, i), mi = kp.findIndex((e) => METHODS.includes(e.key));
        const decl = kp[0] && DECL_SECTS[kp[0].key] && kp[1];
        if (!(f === declFile && decl && kp.length === 2 && kp[1].key === name)) {
          out.push({
            file: f, from: pos + l.match(/^\s*/)![0].length,
            m: mi >= 0 ? kp[mi].key : null,
            label: mi >= 0 ? kp.slice(0, mi).map((e) => e.key).join('') : decl ? (decl.key + (kp.length > 3 ? '.' + kp[kp.length - 1].key : '')) : kp.map((e) => e.key).join('.'),
            where: mi >= 0 ? kp.slice(mi + 1).map((e) => e.key).filter((x) => !['body', 'type', 'properties'].includes(x)).slice(0, 2).join(' ') : f === declFile ? '' : f.split('/').pop()!,
          });
        }
      }
      pos += l.length + 1;
    });
  }
  return out;
}
