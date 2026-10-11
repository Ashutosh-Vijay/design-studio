// The Inspector (M2): a form for whatever the cursor is in (the API root, a resource, a method, a type,
// a trait), next to the code. It reads the text, and every change it makes is a minimal splice of the
// text (src/splice.ts) applied through the editor, so Ctrl Z undoes it and the code stays the master.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Icons } from './components/Icons';
import { METHODS, BUILTIN_TYPES, entries, kids, kid, keyPathAt, type Outline, type Decl } from './raml';
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
function Field({ value, onCommit, placeholder, mono, multiline, list, className = '', focus, onFocused }: {
  value: string; onCommit: (v: string) => void; placeholder?: string; mono?: boolean; multiline?: boolean; list?: string; className?: string; focus?: boolean; onFocused?: () => void;
}) {
  // A row just added through "Add" takes the focus with its name selected, ready to type over.
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (focus && ref.current) { ref.current.focus(); ref.current.select(); onFocused?.(); } }, [focus]); // eslint-disable-line react-hooks/exhaustive-deps
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
    : <input ref={ref} value={v} placeholder={placeholder} spellCheck={false} list={list} onChange={(e) => setV(e.target.value)} onBlur={onBlur}
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

// The API as AMF reads it (amf-server's check with model:true). Positions: [line from 1, column from 0, end line, end column].
export type At = { file: string; r: [number, number, number, number] };
type AmfField = { v: string; at?: At };
type AmfPayload = { media: string; type: string; at?: At };
export type AmfModel = {
  title?: AmfField; version?: AmfField; description?: AmfField;
  endpoints: { path: string; at?: At; summary?: AmfField; description?: AmfField; operations: {
    method: string; at?: At; summary?: AmfField; description?: AmfField; operationId?: AmfField; tags: string[];
    parameters: { name: string; in: string; required: boolean; type: string; at?: At }[]; body: AmfPayload[];
    responses: { code: string; at?: AmfField['at']; description?: AmfField; body: AmfPayload[] }[];
  }[] }[];
  types: { id: string; name: string; type: string; at?: At; properties?: { name: string; type: string; required: boolean; at?: At }[]; usedBy: { where: string; at?: At }[] }[];
};

// Where a type is used, as AMF links say: "GET /orders 200", "Customer.address", "resource type item".
function UsedBy({ uses, onOpenAt }: { uses: AmfModel['types'][number]['usedBy'] | null; onOpenAt: (at: At) => void }) {
  if (!uses) return <Sec title="Used by"><div className="text-[11.5px] text-content-faint">Shown after the next check.</div></Sec>;
  return (
    <Sec title="Used by" count={uses.length}>
      {uses.slice(0, 60).map((u, i) => {
        const m = u.where.match(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) (\S+)\s*(.*)$/);
        return (
          <div key={i} onClick={() => u.at && onOpenAt(u.at)} title={u.at ? `${u.at.file}:${u.at.r[0]}` : undefined}
            className="flex items-center gap-2 px-1.5 -mx-1.5 py-1 rounded-md cursor-pointer hover:bg-[var(--hover-overlay)] text-[12px]">
            {m ? <Badge m={m[1].toLowerCase()} /> : <span className="font-mono text-[9.5px] font-bold w-4 h-4 shrink-0 rounded-[3px] inline-flex items-center justify-center text-[var(--syn-number)] bg-[color-mix(in_oklch,var(--syn-number)_16%,transparent)]">T</span>}
            <span className="font-mono text-[11.5px] truncate">{m ? m[2] : u.where}</span>
            {m && <span className="ml-auto text-[11px] text-content-faint whitespace-nowrap">{m[3]}</span>}
          </div>
        );
      })}
      {uses.length === 0 && <div className="text-[11.5px] text-content-faint">Nothing uses this type.</div>}
    </Sec>
  );
}

const BTN = 'h-[26px] px-2.5 rounded-md text-[12px] border border-line bg-surface-2 text-content-secondary hover:text-content disabled:opacity-40';
// What can go into an extracted trait, in the order RAML usually writes them.
const TRAIT_PARTS = ['queryParameters', 'queryString', 'headers', 'securedBy', 'body', 'responses'];

export function Inspector({ file, text, line, isMain, readOnly, outline, model, onEdit, onGoLine, onOpen, onOpenAt, onRename, onMove, onDelete, onJsonSchema }: {
  file: string; text: string; line: number; isMain: boolean; readOnly: boolean; outline: Outline | null; model: AmfModel | null;
  onEdit: (fn: (t: string) => string) => void; onGoLine: (line: number) => void; onOpen: (file: string, from: number) => void;
  onRename: (from: number) => void; onMove: (d: Decl) => void; onDelete: (d: Decl) => void;
  onOpenAt: (at: At) => void; onJsonSchema: (name: string, file: string) => void;
}) {
  const E = useMemo(() => entries(text), [text]);
  const L = useMemo(() => text.split('\n'), [text]);
  const node = useMemo(() => nodeAt(text, line, isMain), [text, line, isMain]);
  // "Used by" is AMF's: its links follow aliases, $refs, libraries and templates exactly. It refreshes with
  // each full check; null until the first one.
  const amfType = node.kind === 'decl' && node.sect === 'types' ? model?.types.find((t) => t.name === node.name && t.at?.file === file) : undefined;
  const used = model ? amfType?.usedBy ?? [] : null;
  const own = outline?.libraries.find((l) => l.path === file)?.alias ?? null;
  // Names this file can refer to: its own declarations bare, the others through the root's aliases.
  const typeNames = useMemo(() => [...(outline?.types ?? []).map((d) => (d.alias && d.alias !== own ? `${d.alias}.${d.name}` : d.name)), ...BUILTIN_TYPES], [outline, own]);
  // The suggestion lists for type boxes, built once per outline rather than on every keystroke.
  const lists = useMemo(() => (
    <>
      <datalist id="ads-types">{typeNames.map((t) => <option key={t} value={t} />)}</datalist>
      <datalist id="ads-rtypes">{(outline?.resourceTypes ?? []).map((d) => { const n = d.alias && d.alias !== own ? `${d.alias}.${d.name}` : d.name; return <option key={n} value={n} />; })}</datalist>
    </>
  ), [typeNames, outline, own]);
  const traitNames =(outline?.traits ?? []).map((d) => (d.alias && d.alias !== own ? `${d.alias}.${d.name}` : d.name));
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
  const [justAdded, setJustAdded] = useState<string | null>(null);
  // The open extract panel, tied to the node it was opened on (moving away closes it).
  const [panel, setPanel] = useState<{ id: 'trait' | 'rt'; at: string; name: string; parts: string[] } | null>(null);
  const nodeKey = node.kind === 'none' || node.kind === 'root' ? node.kind : node.path.join('\0');
  const unique = (base: string, have: string[]) => { let n = base, i = 2; while (have.includes(n) || have.includes(n + '?')) n = base + i++; return n; };

  // A type written out in place (properties, items, enum, facets) rather than named: it can be extracted.
  const TYPE_FACETS = ['properties', 'items', 'enum', 'pattern', 'minLength', 'maxLength', 'minimum', 'maximum', 'format', 'additionalProperties', 'discriminator', 'minItems', 'maxItems'];
  const isInline = (path: string[]) => { const k = at(path); return k >= 0 && kids(E, k).some((j) => TYPE_FACETS.includes(E[j].key)); };
  // Design Center names the new declaration after the original; for a body, after its resource and method.
  const extractName = (path: string[]) => {
    const last = path[path.length - 1].replace(/\?$/, '');
    if (!last.includes('/') && last !== 'body') return S.freeName(text, 'types', last);
    const seg = [...path].reverse().find((p) => p.startsWith('/') && !p.includes('{'))?.replace(/^\//, '').replace(/[^\w]+(\w)/g, (_m, c) => c.toUpperCase()) ?? 'new';
    const m = path.find((p) => METHODS.includes(p)) ?? '';
    return S.freeName(text, 'types', seg + m.charAt(0).toUpperCase() + m.slice(1) + (path.includes('responses') ? 'Response' : 'Request'));
  };

  const typeCell = (path: string[]) => {
    const t = S.typeOf(text, path), d = t && findType(t);
    const known = !t || d || BUILTIN_TYPES.includes(t.replace(/\[\]$/, '')) || /[|(]/.test(t);
    return (
      <span className="flex items-center gap-0.5 min-w-0 flex-1">
        <Field value={t} mono list="ads-types" placeholder="string" onCommit={(v) => onEdit((x) => S.setType(x, path, v))} className={known ? 'text-[var(--syn-type)]' : 'text-err'} />
        {d && <IconBtn title={`Go to ${d.name}`} onClick={() => onOpen(d.file, d.from)}><Icons.ChevronRight size={12} /></IconBtn>}
        {isInline(path) && path.join('\0') !== (node.kind === 'decl' ? node.path.join('\0') : '') && (
          <IconBtn title="Extract to Declaration: make this a named type" onClick={() => onEdit((x) => S.extractType(x, path, extractName(path)))}><Icons.Braces size={12} /></IconBtn>
        )}
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
        add={<button onClick={() => {
          const n = unique(key === 'properties' ? 'property' : key === 'headers' ? 'X-Header' : 'param', names);
          setJustAdded([...parent, key, n].join('\0'));
          onEdit((x) => S.addChild(x, [...parent, key], [`${n}: string`]));
        }}
          className="normal-case tracking-normal font-medium text-[11px] text-accent hover:underline flex items-center gap-0.5"><Icons.Plus size={11} />{addLabel}</button>}>
        {rows.length === 0 && <div className="text-[11.5px] text-content-faint">{hint ?? 'None.'}</div>}
        {rows.map((j) => {
          const p = [...parent, key, E[j].key];
          const r = kid(E, j, 'required');
          const optional = E[j].key.endsWith('?') || (r != null && E[r].val === 'false');
          const name = E[j].key.replace(/\?$/, '');
          return (
            <div key={E[j].key} className={rowCls(j) + ' flex items-center gap-1 py-[3px]'} onClick={() => onGoLine(E[j].line)}>
              <span className="w-[38%] shrink-0"><Field value={name} mono focus={justAdded === p.join('\0')} onFocused={() => setJustAdded(null)} onCommit={(v) => v && onEdit((x) => S.renameKey(x, p, E[j].key.endsWith('?') ? v + '?' : v))} /></span>
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

  // Traits a method gets from its resource (RAML applies a resource's is: to that resource's own methods).
  const inherited = (parent: string[]) => (METHODS.includes(parent[parent.length - 1]) ? S.list(text, [...parent.slice(0, -1), 'is']) ?? [] : []);
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
        {inherited(parent).length > 0 && <div className="mt-1.5 text-[11px] text-content-faint">Also from the resource: <span className="font-mono text-content-muted">{inherited(parent).join(', ')}</span></div>}
      </Sec>
    );
  };

  const docs = (path: string[], what: string) => (
    <div className="mt-3 flex flex-col gap-1.5">
      <Field value={S.scalar(text, [...path, 'displayName']) ?? ''} placeholder={`Display name for this ${what}`} onCommit={(v) => onEdit((x) => S.setScalar(x, path, 'displayName', v || null))} />
      <Field multiline value={S.scalar(text, [...path, 'description']) ?? ''} placeholder="Description" onCommit={(v) => onEdit((x) => S.setScalar(x, path, 'description', v || null))} />
    </div>
  );

  // Extract to trait / resource type: a button that opens a small panel (which parts, what name) in place.
  const extractPanel = (id: 'trait' | 'rt', label: string, parts: string[], defName: string, run: (name: string, parts: string[]) => void, blocked: boolean) => {
    if (panel?.id !== id || panel.at !== nodeKey) {
      return <div className="mt-2.5"><button disabled={blocked} title={blocked ? 'Its is: has traits with parameters. Edit those in the code.' : undefined}
        onClick={() => setPanel({ id, at: nodeKey, name: defName, parts: parts.filter((p) => p !== 'responses' && p !== 'body') })} className={BTN}>{label}</button></div>;
    }
    if (id === 'trait' && !parts.length) return <div className="mt-2.5 text-[11.5px] text-content-faint">Nothing to extract: add query parameters, headers or responses first.</div>;
    return (
      <div className="mt-2.5 p-2.5 rounded-md border border-line bg-bg flex flex-col gap-2">
        {id === 'trait' && <div className="flex flex-wrap gap-x-3 gap-y-1">{parts.map((p) => (
          <label key={p} className="flex items-center gap-1 text-[11.5px] font-mono cursor-pointer">
            <input type="checkbox" checked={panel.parts.includes(p)} className="accent-[var(--accent)]"
              onChange={(e) => setPanel({ ...panel, parts: e.target.checked ? [...panel.parts, p] : panel.parts.filter((x) => x !== p) })} />{p}
          </label>
        ))}</div>}
        <label className="flex items-center gap-2"><span className="text-[11.5px] text-content-faint shrink-0">Name</span>
          <Field value={panel.name} mono focus onCommit={(v) => setPanel({ ...panel, name: v.trim() })} /></label>
        <div className="flex gap-1.5 justify-end">
          <button onClick={() => setPanel(null)} className={BTN}>Cancel</button>
          <button disabled={!/^[A-Za-z_][\w-]*$/.test(panel.name) || (id === 'trait' && !panel.parts.length)}
            onClick={() => { run(panel.name, panel.parts); setPanel(null); }}
            className="h-[26px] px-2.5 rounded-md text-[12px] font-semibold bg-accent text-accent-ink hover:bg-accent-hover disabled:opacity-40">Extract</button>
        </div>
      </div>
    );
  };

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
        {extractPanel('trait', 'Extract to trait…', TRAIT_PARTS.filter((p) => at([...node.path, p]) >= 0), S.freeName(text, 'traits', 'newTrait'),
          (name, parts) => onEdit((x) => S.extractTrait(x, node.path, parts, name)), at([...node.path, 'is']) >= 0 && E[at([...node.path, 'is'])].val.includes('{'))}
        {docs(node.path, 'method')}
        {traits(node.path)}
        {uri.length > 0 && (
          <Sec title="URI parameters" count={uri.length}>
            {uri.map((u) => <div key={u.name} className="flex items-center gap-2 py-[3px] text-[12px]"><span className="font-mono">{u.name}</span><span className="font-mono text-[var(--syn-type)]">{u.type}</span>{!u.declared && <span className="ml-auto text-[10.5px] text-content-faint">from the path</span>}</div>)}
            <div className="text-[11px] text-content-faint">Edit them on the resource.</div>
          </Sec>
        )}
        {/* RAML allows queryParameters or queryString, not both. */}
        {at([...node.path, 'queryString']) >= 0
          ? <Sec title="Query string">{typeCell([...node.path, 'queryString'])}<div className="mt-1 text-[11px] text-content-faint">A type for the whole query string, so no separate query parameters.</div></Sec>
          : params(node.path, 'queryParameters', 'Query parameters', 'Add')}
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
        {rt == null && methods.length > 0 && extractPanel('rt', 'Extract to resource type…', [],
          // Named after the resource: /orders gives orders, /orders/{id} gives ordersItem.
          S.freeName(text, 'resourceTypes', (() => {
            const camel = (s: string) => s.replace(/^\//, '').replace(/[^\w]+(\w)/g, (_m, c) => c.toUpperCase());
            const last = node.path[node.path.length - 1], stat = [...node.path].reverse().find((p) => !p.includes('{'));
            return last.includes('{') ? (stat ? camel(stat) : 'new') + 'Item' : camel(last) || 'newResourceType';
          })()),
          (name) => onEdit((x) => S.extractResourceType(x, node.path, name)), false)}
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
    const included = k >= 0 && /^!include\s/.test(E[k].val);
    h = (
      <>
        {title(<><span className="font-mono text-[13.5px] font-bold break-all">{node.name}</span>{d?.alias && <span className="ml-auto text-[11.5px] text-content-faint">{d.alias}</span>}</>)}
        <div className="mt-1 text-[12.5px] text-content-secondary">{DECL_SECTS[node.sect]}</div>
        {k >= 0 && loc(k)}
        <div className="mt-3 flex flex-wrap gap-1.5">
          {d && <button onClick={() => onRename(d.from)} className={BTN}>Rename…</button>}
          {d && isType && isMain && <button onClick={() => onMove(d)} className={BTN}>Move to library…</button>}
          {isType && amfType && <button onClick={() => onJsonSchema(node.name, file)} className={BTN} title="AMF renders this type as JSON Schema and puts it on the clipboard">Copy as JSON Schema</button>}
          {d && node.sect !== 'securitySchemes' && node.sect !== 'annotationTypes' && <button onClick={() => onDelete(d)} className={BTN + ' hover:!text-err'}>Delete…</button>}
        </div>
        {/* Declared in its own file (name: !include file.raml): the form for it is in that file. */}
        {included && <Sec title="Defined in">{example(node.path)}<div className="mt-1 text-[11px] text-content-faint">Open the file to edit it.</div></Sec>}
        {!included && isType && <Sec title="Type">{typeCell(node.path)}</Sec>}
        {!included && <div className="mt-3"><Field multiline value={S.scalar(text, [...node.path, 'description']) ?? ''} placeholder="Description" onCommit={(v) => onEdit((x) => S.setScalar(x, node.path, 'description', v || null))} /></div>}
        {!included && node.sect === 'traits' && <>
          <div className="mt-1.5"><Field value={S.scalar(text, [...node.path, 'usage']) ?? ''} placeholder="Usage" onCommit={(v) => onEdit((x) => S.setScalar(x, node.path, 'usage', v || null))} /></div>
          {/* A trait is the part of a method it adds: parameters, headers, responses. */}
          {params(node.path, 'queryParameters', 'Query parameters', 'Add')}
          {params(node.path, 'headers', 'Headers', 'Add')}
          <Sec title="Responses" count={kids(E, at([...node.path, 'responses'])).length || undefined}
            add={<AddSelect label="Add response" options={Object.keys(CODES).filter((c) => at([...node.path, 'responses', c]) < 0)} onPick={(c) => onEdit((x) => S.addChild(x, [...node.path, 'responses'], [`${c}:`]))} />}>
            {at([...node.path, 'responses']) >= 0 && kids(E, at([...node.path, 'responses'])).map((j) => (
              <div key={E[j].key} onClick={() => onGoLine(E[j].line)} className={rowCls(j) + ' flex items-center gap-2 py-[3px] cursor-pointer'}>
                <span className="font-mono font-bold text-[11.5px] px-1.5 rounded-[3px]" style={{ color: codeColor(E[j].key), background: `color-mix(in oklch, ${codeColor(E[j].key)} 13%, transparent)` }}>{E[j].key}</span>
                <span className="text-[12px] truncate">{S.scalar(text, [...node.path, 'responses', E[j].key, 'description']) ?? ''}</span>
              </div>
            ))}
          </Sec>
        </>}
        {!included && node.sect === 'resourceTypes' && (
          <Sec title="Methods" add={<AddSelect label="Add method" options={METHODS.filter((m) => at([...node.path, m]) < 0 && at([...node.path, m + '?']) < 0)} onPick={(m) => onEdit((x) => S.addChild(x, node.path, [`${m}:`]))} />}>
            {kids(E, k).filter((j) => METHODS.includes(E[j].key.replace(/\?$/, ''))).map((j) => (
              <div key={E[j].key} onClick={() => onGoLine(E[j].line)} className="flex items-center gap-2 px-1.5 -mx-1.5 py-1 rounded-md cursor-pointer hover:bg-[var(--hover-overlay)]">
                <Badge m={E[j].key.replace(/\?$/, '')} />{E[j].key.endsWith('?') && <span className="text-[11px] text-content-faint">optional</span>}
              </div>
            ))}
          </Sec>
        )}
        {!included && node.sect === 'securitySchemes' && <>
          <Sec title="Scheme type">
            <select value={S.scalar(text, [...node.path, 'type']) ?? ''} onChange={(e) => onEdit((x) => S.setScalar(x, node.path, 'type', e.target.value || null))}
              className="w-full h-[26px] rounded border border-line bg-surface-input text-[12px] font-mono text-content px-1.5">
              {['', 'OAuth 2.0', 'OAuth 1.0', 'Basic Authentication', 'Digest Authentication', 'Pass Through'].concat((S.scalar(text, [...node.path, 'type']) ?? '').startsWith('x-') ? [S.scalar(text, [...node.path, 'type'])!] : []).map((t) => <option key={t} value={t}>{t || 'Choose a type'}</option>)}
            </select>
          </Sec>
          {params([...node.path, 'describedBy'], 'headers', 'Headers it needs', 'Add')}
          {params([...node.path, 'describedBy'], 'queryParameters', 'Query parameters it needs', 'Add')}
        </>}
        {!included && isType && enumK >= 0 && (
          <Sec title="Values" count={(S.list(text, [...node.path, 'enum']) ?? []).length}>
            <Field mono value={(S.list(text, [...node.path, 'enum']) ?? []).join(', ')} onCommit={(v) => onEdit((x) => S.setList(x, [...node.path, 'enum'], v.split(',').map((s) => s.trim()).filter(Boolean)))} />
            <div className="mt-1 text-[11px] text-content-faint">Separated by commas.</div>
          </Sec>
        )}
        {!included && isType && enumK < 0 && params(node.path, 'properties', 'Properties', 'Add property', 'No properties.')}
        {isType && <UsedBy uses={used} onOpenAt={onOpenAt} />}
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
      {readOnly && <div className="mb-3 flex items-center gap-1.5 text-[11.5px] text-content-faint"><Icons.Lock size={12} />Read-only: managed by Exchange</div>}
      {/* A disabled fieldset turns every box, button and picker inside it off at once. */}
      <fieldset disabled={readOnly} className="m-0 p-0 border-0 min-w-0">{h}</fieldset>
      {lists}
    </div>
  );
}

// ---------- OAS 3.0 (YAML) ----------
// The same idea for OpenAPI files: a form for the operation, path, schema or API under the cursor, every
// change a minimal splice. Parameters and servers are "- " lists, addressed as #n in a path.
const OAS_BUILTIN = ['string', 'integer', 'number', 'boolean', 'object', 'array'];
const REF = '#/components/schemas/';

// A schema's type as one word: Pet (a $ref), Pet[] or string[] (an array), string, object.
function oasType(text: string, p: string[]): string {
  const E = entries(text), k = S.find(E, p); if (k < 0) return '';
  const ref = kid(E, k, '$ref'); if (ref != null) return S.unquote(E[ref].val).replace(REF, '');
  const t = kid(E, k, 'type'); const tv = t != null ? S.unquote(E[t].val) : '';
  if (tv === 'array') { const it = oasType(text, [...p, 'items']); return it ? it + '[]' : 'array'; }
  return tv || (kids(E, k).some((j) => E[j].key === 'properties') ? 'object' : '');
}
// Write a type back: built-in names as type:, others as a $ref to components/schemas, X[] as an array of X.
function setOasType(text: string, p: string[], t: string): string {
  for (const key of ['$ref', 'type', 'items', 'format']) text = S.remove(text, [...p, key], false);
  if (!t) return text;
  const arr = t.endsWith('[]'), b = arr ? t.slice(0, -2) : t;
  const one = (x: string) => (OAS_BUILTIN.includes(x) ? [`type: ${x}`] : [`$ref: '${REF}${x}'`]);
  return S.addChild(text, p, arr ? ['type: array', 'items:', ...one(b).map((l) => '  ' + l)] : one(b), true);
}

export function OasInspector({ file, text, line, readOnly, model, onEdit, onGoLine, onOpenAt, onJsonSchema }: {
  file: string; text: string; line: number; readOnly: boolean; model: AmfModel | null;
  onEdit: (fn: (t: string) => string) => void; onGoLine: (line: number) => void; onOpenAt: (at: At) => void; onJsonSchema: (name: string, file: string) => void;
}) {
  const E = useMemo(() => entries(text), [text]);
  const L = useMemo(() => text.split('\n'), [text]);
  const kp = useMemo(() => keyPathAt(text, line).map((e) => e.key), [text, line]);
  const at = (p: string[]) => S.find(E, p);
  const here = (k: number, end?: number) => line >= E[k].line && line < (end ?? S.blockEnd(E, L, k));
  const rowCls = (on: boolean) => `group/r rounded-md px-1.5 -mx-1.5 ${on ? 'bg-accent-dim' : 'hover:bg-[var(--hover-overlay)]'}`;
  const schemasK = at(['components', 'schemas']);
  const schemaNames = schemasK < 0 ? [] : kids(E, schemasK).map((j) => E[j].key);
  const known = (t: string) => !t || OAS_BUILTIN.includes(t.replace(/\[\]$/, '')) || schemaNames.includes(t.replace(/\[\]$/, ''));

  const typeCell = (p: string[]) => {
    const k = at(p);
    if (k >= 0 && E[k].val.startsWith('{')) return <span className="font-mono text-[11.5px] text-content-secondary truncate" title={E[k].val}>{E[k].val}</span>;
    const t = oasType(text, p);
    const target = schemaNames.includes(t.replace(/\[\]$/, '')) ? at(['components', 'schemas', t.replace(/\[\]$/, '')]) : -1;
    return (
      <span className="flex items-center gap-0.5 min-w-0 flex-1">
        <Field value={t} mono list="ads-oas-types" placeholder="string" onCommit={(v) => onEdit((x) => setOasType(x, p, v.trim()))} className={known(t) ? 'text-[var(--syn-type)]' : 'text-err'} />
        {target >= 0 && <IconBtn title={`Go to ${t.replace(/\[\]$/, '')}`} onClick={() => onGoLine(E[target].line)}><Icons.ChevronRight size={12} /></IconBtn>}
      </span>
    );
  };
  // One row per media type under content:, each with its schema.
  const content = (p: string[]) => {
    const k = at([...p, 'content']);
    const media = k < 0 ? [] : kids(E, k);
    return (
      <div className="mt-1 flex flex-col gap-0.5">
        {media.map((j) => (
          <div key={E[j].key} className={rowCls(here(j)) + ' flex items-center gap-1.5 py-[3px]'} onClick={() => onGoLine(E[j].line)}>
            <span className="text-[11px] font-mono text-content-faint shrink-0 max-w-[45%] truncate" title={E[j].key}>{E[j].key}</span>
            {typeCell([...p, 'content', E[j].key, 'schema'])}
            <span className="opacity-0 group-hover/r:opacity-100"><IconBtn title="Remove" onClick={() => onEdit((x) => S.remove(x, [...p, 'content', E[j].key]))}><Icons.X size={11} /></IconBtn></span>
          </div>
        ))}
        <div className="flex"><AddSelect label="Content" options={MEDIA.filter((m) => !media.some((j) => E[j].key === m))} onPick={(m) => onEdit((x) => S.addChild(x, [...p, 'content'], [`${m}:`, '  schema:', '    type: object']))} /></div>
      </div>
    );
  };
  const field = (p: string[], key: string, placeholder: string, mono = false, multiline = false) => (
    <Field value={S.scalar(text, [...p, key]) ?? ''} placeholder={placeholder} mono={mono} multiline={multiline} onCommit={(v) => onEdit((x) => S.setScalar(x, p, key, v || null))} />
  );
  const loc = (k: number) => <button onClick={() => onGoLine(E[k].line)} className="mt-0.5 block font-mono text-[11px] text-content-faint hover:text-accent">{file}:{E[k].line + 1}</button>;
  let h: ReactNode;

  if (kp[0] === 'paths' && kp[1] && METHODS.includes(kp[2])) {
    const op = ['paths', kp[1], kp[2]], k = at(op);
    const pk = at([...op, 'parameters']), ps = pk < 0 ? [] : S.items(E, pk);
    const rk = at([...op, 'responses']), codes = rk < 0 ? [] : kids(E, rk);
    // A new status code is written the way this file already writes them: quoted '200' or bare 200.
    const quoteCodes = rk >= 0 && codes.length > 0 && /^\s*['"]/.test(L[E[codes[0]].line]);
    h = (
      <>
        <div className="flex items-center gap-2 min-w-0"><Badge m={kp[2]} /><span className="font-mono text-[13.5px] font-bold break-all">{kp[1]}</span></div>
        {k >= 0 && loc(k)}
        <div className="mt-3 flex flex-col gap-1.5">
          {field(op, 'summary', 'Summary')}
          {field(op, 'description', 'Description', false, true)}
          {field(op, 'operationId', 'operationId', true)}
          <Field mono value={(S.list(text, [...op, 'tags']) ?? []).join(', ')} placeholder="Tags, separated by commas" onCommit={(v) => onEdit((x) => S.setList(x, [...op, 'tags'], v.split(',').map((s) => s.trim()).filter(Boolean)))} />
        </div>
        <Sec title="Parameters" count={ps.length || undefined}
          add={<button onClick={() => onEdit((x) => S.addItem(x, [...op, 'parameters'], ['name: param', 'in: query', 'schema:', '  type: string']))} className="normal-case tracking-normal font-medium text-[11px] text-accent hover:underline flex items-center gap-0.5"><Icons.Plus size={11} />Add</button>}>
          {ps.length === 0 && <div className="text-[11.5px] text-content-faint">None.</div>}
          {ps.map((j, n) => {
            const ip = [...op, 'parameters', '#' + n];
            const ref = at([...ip, '$ref']);
            const end = ps[n + 1] != null ? E[ps[n + 1]].line : S.blockEnd(E, L, pk);
            if (ref >= 0) return <div key={n} className={rowCls(here(j, end)) + ' py-[3px] font-mono text-[11.5px] text-content-secondary'} onClick={() => onGoLine(E[j].line)}>{S.unquote(E[ref].val)}</div>;
            const where = S.scalar(text, [...ip, 'in']) ?? 'query';
            return (
              <div key={n} className={rowCls(here(j, end)) + ' flex items-center gap-1 py-[3px]'} onClick={() => onGoLine(E[j].line)}>
                <span className="w-[32%] shrink-0"><Field value={S.scalar(text, [...ip, 'name']) ?? ''} mono onCommit={(v) => v && onEdit((x) => S.setInItem(x, [...op, 'parameters'], n, 'name', v))} /></span>
                <select value={where} onClick={(e) => e.stopPropagation()} onChange={(e) => onEdit((x) => S.setInItem(x, [...op, 'parameters'], n, 'in', e.target.value, true))}
                  className="h-[26px] w-[62px] shrink-0 rounded border border-line bg-surface-input text-[11px] font-mono text-content-secondary">
                  {['query', 'path', 'header', 'cookie'].map((w) => <option key={w}>{w}</option>)}
                </select>
                {typeCell([...ip, 'schema'])}
                <label title="Required" className="shrink-0 flex items-center gap-1 text-[10.5px] text-content-faint cursor-pointer" onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" checked={where === 'path' || S.scalar(text, [...ip, 'required']) === 'true'} disabled={where === 'path'} className="accent-[var(--accent)]"
                    onChange={(e) => onEdit((x) => S.setInItem(x, [...op, 'parameters'], n, 'required', e.target.checked ? 'true' : null, true))} />req
                </label>
                <span className="opacity-0 group-hover/r:opacity-100"><IconBtn title="Remove" onClick={() => onEdit((x) => S.removeItem(x, [...op, 'parameters'], n))}><Icons.X size={11} /></IconBtn></span>
              </div>
            );
          })}
        </Sec>
        {(['post', 'put', 'patch'].includes(kp[2]) || at([...op, 'requestBody']) >= 0) && <Sec title="Request body">{content([...op, 'requestBody'])}</Sec>}
        <Sec title="Responses" count={codes.length || undefined}
          add={<AddSelect label="Add response" options={Object.keys(CODES).filter((c) => !codes.some((j) => E[j].key === c))}
            onPick={(c) => onEdit((x) => S.addChild(x, [...op, 'responses'], [`${quoteCodes || !codes.length ? `'${c}'` : c}:`, `  description: ${CODES[c]}`]))} />}>
          {codes.map((j) => {
            const p = [...op, 'responses', E[j].key];
            return (
              <div key={E[j].key} className={rowCls(here(j)) + ' border border-line rounded-md p-2 mb-1.5 mx-0 bg-bg'} onClick={() => onGoLine(E[j].line)}>
                <div className="flex items-center gap-2">
                  <span className="font-mono font-bold text-[11.5px] px-1.5 rounded-[3px]" style={{ color: codeColor(E[j].key), background: `color-mix(in oklch, ${codeColor(E[j].key)} 13%, transparent)` }}>{E[j].key}</span>
                  <Field value={S.scalar(text, [...p, 'description']) ?? ''} placeholder="Description (required in OAS)" onCommit={(v) => onEdit((x) => S.setScalar(x, p, 'description', v || null))} />
                  <span className="opacity-0 group-hover/r:opacity-100"><IconBtn title="Remove this response" onClick={() => onEdit((x) => S.remove(x, p, false))}><Icons.X size={11} /></IconBtn></span>
                </div>
                {content(p)}
              </div>
            );
          })}
        </Sec>
      </>
    );
  } else if (kp[0] === 'paths' && kp[1]) {
    const p = ['paths', kp[1]], k = at(p);
    const ops = k < 0 ? [] : kids(E, k).filter((j) => METHODS.includes(E[j].key));
    h = (
      <>
        <span className="font-mono text-[13.5px] font-bold break-all">{kp[1]}</span>
        {k >= 0 && loc(k)}
        <div className="mt-3 flex flex-col gap-1.5">{field(p, 'summary', 'Summary')}{field(p, 'description', 'Description', false, true)}</div>
        <Sec title="Operations" count={ops.length || undefined} add={<AddSelect label="Add operation" options={METHODS.filter((m) => !ops.some((j) => E[j].key === m))}
          onPick={(m) => onEdit((x) => S.addChild(x, p, [`${m}:`, '  responses:', "    '200':", '      description: OK']))} />}>
          {ops.map((j) => <div key={E[j].key} onClick={() => onGoLine(E[j].line)} className="flex items-center gap-2 px-1.5 -mx-1.5 py-1 rounded-md cursor-pointer hover:bg-[var(--hover-overlay)]"><Badge m={E[j].key} /><span className="text-[12px] truncate">{S.scalar(text, [...p, E[j].key, 'summary']) ?? ''}</span></div>)}
        </Sec>
      </>
    );
  } else if (kp[0] === 'components' && kp[1] === 'schemas' && kp[2]) {
    const p = ['components', 'schemas', kp[2]], k = at(p);
    const pk = at([...p, 'properties']), props = pk < 0 ? [] : kids(E, pk);
    const req = S.list(text, [...p, 'required']) ?? [];
    const amfSchema = model?.types.find((t) => t.name === kp[2] && t.at?.file === file);
    h = (
      <>
        <span className="font-mono text-[13.5px] font-bold break-all">{kp[2]}</span>
        <div className="mt-1 text-[12.5px] text-content-secondary">Schema</div>
        {k >= 0 && loc(k)}
        {amfSchema && <div className="mt-3"><button onClick={() => onJsonSchema(kp[2], file)} className={BTN} title="AMF renders this schema as JSON Schema and puts it on the clipboard">Copy as JSON Schema</button></div>}
        <Sec title="Type">{typeCell(p)}</Sec>
        <div className="mt-3">{field(p, 'description', 'Description', false, true)}</div>
        {at([...p, 'enum']) >= 0 ? (
          <Sec title="Values"><Field mono value={(S.list(text, [...p, 'enum']) ?? []).join(', ')} onCommit={(v) => onEdit((x) => S.setList(x, [...p, 'enum'], v.split(',').map((s) => s.trim()).filter(Boolean)))} /></Sec>
        ) : (
          <Sec title="Properties" count={props.length || undefined}
            add={<button onClick={() => { let n = 'property', i = 2; while (props.some((j) => E[j].key === n)) n = 'property' + i++; onEdit((x) => S.addChild(x, [...p, 'properties'], [`${n}:`, '  type: string'])); }}
              className="normal-case tracking-normal font-medium text-[11px] text-accent hover:underline flex items-center gap-0.5"><Icons.Plus size={11} />Add property</button>}>
            {props.length === 0 && <div className="text-[11.5px] text-content-faint">No properties.</div>}
            {props.map((j) => {
              const pp = [...p, 'properties', E[j].key];
              return (
                <div key={E[j].key} className={rowCls(here(j)) + ' flex items-center gap-1 py-[3px]'} onClick={() => onGoLine(E[j].line)}>
                  <span className="w-[38%] shrink-0"><Field value={E[j].key} mono onCommit={(v) => v && onEdit((x) => {
                    // A renamed property keeps its place in required:.
                    let y = S.renameKey(x, pp, v);
                    if (req.includes(E[j].key)) y = S.setList(y, [...p, 'required'], req.map((r) => (r === E[j].key ? v : r)));
                    return y;
                  })} /></span>
                  {typeCell(pp)}
                  <label title="Required" className="shrink-0 flex items-center gap-1 text-[10.5px] text-content-faint cursor-pointer" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={req.includes(E[j].key)} className="accent-[var(--accent)]"
                      onChange={(e) => onEdit((x) => S.setList(x, [...p, 'required'], e.target.checked ? [...req, E[j].key] : req.filter((r) => r !== E[j].key)))} />req
                  </label>
                  <span className="opacity-0 group-hover/r:opacity-100"><IconBtn title="Remove" onClick={() => onEdit((x) => {
                    const y = S.remove(x, pp);
                    return req.includes(E[j].key) ? S.setList(y, [...p, 'required'], req.filter((r) => r !== E[j].key)) : y;
                  })}><Icons.X size={11} /></IconBtn></span>
                </div>
              );
            })}
          </Sec>
        )}
        <UsedBy uses={model ? amfSchema?.usedBy ?? [] : null} onOpenAt={onOpenAt} />
      </>
    );
  } else {
    const sk = at(['servers']), servers = sk < 0 ? [] : S.items(E, sk);
    const pk = at(['paths']);
    h = (
      <>
        <span className="text-[13.5px] font-bold">{S.scalar(text, ['info', 'title']) || 'Untitled API'}</span>
        <div className="mt-1 text-[12.5px] text-content-secondary">OpenAPI {S.scalar(text, ['openapi'])}, {pk < 0 ? 0 : kids(E, pk).length} paths, {schemaNames.length} schemas</div>
        <Sec title="Info">
          <div className="flex flex-col gap-1.5">{field(['info'], 'title', 'Title')}{field(['info'], 'version', 'Version', true)}{field(['info'], 'description', 'Description', false, true)}</div>
        </Sec>
        <Sec title="Servers" count={servers.length || undefined}
          add={<button onClick={() => onEdit((x) => S.addItem(x, ['servers'], ['url: https://api.example.com']))} className="normal-case tracking-normal font-medium text-[11px] text-accent hover:underline flex items-center gap-0.5"><Icons.Plus size={11} />Add</button>}>
          {servers.map((_j, n) => (
            <div key={n} className="group/r flex items-center gap-1 py-[3px]">
              <Field value={S.scalar(text, ['servers', '#' + n, 'url']) ?? ''} mono onCommit={(v) => v && onEdit((x) => S.setInItem(x, ['servers'], n, 'url', v))} />
              <span className="opacity-0 group-hover/r:opacity-100"><IconBtn title="Remove" onClick={() => onEdit((x) => S.removeItem(x, ['servers'], n))}><Icons.X size={11} /></IconBtn></span>
            </div>
          ))}
        </Sec>
        <div className="mt-4 text-[11.5px] text-content-faint">Put the cursor in a path, an operation or a schema to edit it here.</div>
      </>
    );
  }

  return (
    <div className="flex-1 overflow-auto px-3.5 pt-3.5 pb-6 select-none">
      {readOnly && <div className="mb-3 flex items-center gap-1.5 text-[11.5px] text-content-faint"><Icons.Lock size={12} />Read-only: managed by Exchange</div>}
      <fieldset disabled={readOnly} className="m-0 p-0 border-0 min-w-0">{h}</fieldset>
      <datalist id="ads-oas-types">{[...schemaNames, ...OAS_BUILTIN].map((t) => <option key={t} value={t} />)}</datalist>
    </div>
  );
}
