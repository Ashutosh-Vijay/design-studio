// OAS 3.0 in JSON: the same forms as for YAML. jsonc-parser reads the text (exact, instant) and makes the
// edits (minimal text changes, as VS Code does in settings files); AMF supplies what needs understanding:
// "Used by" from its links, JSON Schema, and the problems.
import { useMemo, type ReactNode } from 'react';
import { parseTree, findNodeAtLocation, findNodeAtOffset, getNodePath, getNodeValue, type Node as JNode, type JSONPath } from 'jsonc-parser';
import { Icons } from './components/Icons';
import { METHODS, type Outline, type Resource, type Decl } from './raml';
import { Field, Sec, AddSelect, IconBtn, Badge, UsedBy, BTN, CODES, MEDIA, codeColor, type AmfModel, type At } from './Inspector';

const OAS_BUILTIN = ['string', 'integer', 'number', 'boolean', 'object', 'array'];
const REF = '#/components/schemas/';
type J = Record<string, unknown>;

// ---------- Minimal JSON edits ----------
// jsonc-parser finds the exact spans; the edit is written in the style around it: a one-line object or array
// stays on one line, a multi-line one gets a new indented line. (jsonc-parser's own modify() reformats any
// one-line object it touches, which the corpus test showed.)
const inline = (v: unknown): string => Array.isArray(v) ? (v.length ? `[ ${v.map(inline).join(', ')} ]` : '[]')
  : v && typeof v === 'object' ? (Object.keys(v).length ? `{ ${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${inline(x)}`).join(', ')} }` : '{}') : JSON.stringify(v);
const tabOf = (text: string) => text.match(/\n( +)"/)?.[1].length ?? 2;
const lineStart = (text: string, at: number) => text.lastIndexOf('\n', at - 1) + 1;
const indentAt = (text: string, at: number) => text.slice(lineStart(text, at)).match(/^[ \t]*/)![0];
const pretty = (text: string, v: unknown, ind: string) => JSON.stringify(v, null, tabOf(text)).split('\n').map((l, i) => (i ? ind + l : l)).join('\n');
const splice = (text: string, from: number, to: number, ins: string) => text.slice(0, from) + ins + text.slice(to);

// Set (or with undefined, remove) the value at a path; missing parents are created.
function set(text: string, path: JSONPath, value: unknown): string {
  const tree = parseTree(text); if (!tree) return text;
  const n = findNodeAtLocation(tree, path);
  if (n) {
    if (value === undefined) return removeNode(text, n);
    const old = text.slice(n.offset, n.offset + n.length);
    return splice(text, n.offset, n.offset + n.length, old.includes('\n') ? pretty(text, value, indentAt(text, n.offset)) : inline(value));
  }
  if (value === undefined || !path.length) return text;
  const parentPath = path.slice(0, -1), key = path[path.length - 1];
  const parent = findNodeAtLocation(tree, parentPath);
  if (!parent) return set(text, parentPath, typeof key === 'number' ? [value] : { [key]: value });
  return addMember(text, parent, typeof key === 'number' ? null : key, value);
}
// A new object member (key) or array item (key null), after the last one, in the container's style.
function addMember(text: string, c: JNode, key: string | null, value: unknown): string {
  const kids = c.children ?? [];
  const own = text.slice(c.offset, c.offset + c.length);
  const entry = (v: string) => (key == null ? v : `${JSON.stringify(key)}: ${v}`);
  if (!kids.length) {
    const ind = indentAt(text, c.offset), inner = ind + ' '.repeat(tabOf(text));
    const open = own[0], close = own[own.length - 1];
    // An empty {} or [] has no style to follow: it opens onto indented lines, as the file indents.
    return splice(text, c.offset, c.offset + c.length, `${open}\n${inner}${entry(pretty(text, value, inner))}\n${ind}${close}`);
  }
  const last = kids[kids.length - 1], end = last.offset + last.length;
  if (!own.includes('\n')) return splice(text, end, end, `, ${entry(inline(value))}`);
  // On its own line, with its value written like the neighbour's: one line if theirs is.
  const ind = indentAt(text, last.offset);
  const lastVal = last.type === 'property' ? last.children?.[1] : last;
  const oneLine = !!lastVal && !text.slice(lastVal.offset, lastVal.offset + lastVal.length).includes('\n');
  return splice(text, end, end, `,\n${ind}${entry(oneLine ? inline(value) : pretty(text, value, ind))}`);
}
// Remove a member or item with its comma; a multi-line one takes its whole line.
function removeNode(text: string, n: JNode): string {
  const item = n.parent?.type === 'property' ? n.parent : n;
  const c = item.parent!, sibs = c.children ?? [], i = sibs.indexOf(item);
  const end = item.offset + item.length;
  if (sibs.length === 1) return splice(text, c.offset, c.offset + c.length, c.type === 'array' ? '[]' : '{}');
  const multi = text.slice(c.offset, c.offset + c.length).includes('\n');
  if (i > 0) { const prev = sibs[i - 1]; return splice(text, prev.offset + prev.length, end, ''); }
  const next = sibs[1];
  return multi ? splice(text, lineStart(text, item.offset), lineStart(text, next.offset), '') : splice(text, item.offset, next.offset, '');
}
const pushItem = (text: string, path: JSONPath, value: unknown) => set(text, [...path, ((parseTree(text) && findNodeAtLocation(parseTree(text)!, path))?.children?.length ?? 0)], value);
// Rename an object key where it stands, keeping its value and place.
function renameKey(text: string, path: JSONPath, nu: string): string {
  const tree = parseTree(text), n = tree && findNodeAtLocation(tree, path);
  const key = n?.parent?.type === 'property' ? n.parent.children?.[0] : undefined;
  return key ? text.slice(0, key.offset) + JSON.stringify(nu) + text.slice(key.offset + key.length) : text;
}

// The API tree for an OAS JSON file: paths, their operations, schemas and security schemes, with offsets.
export function buildOasJsonOutline(file: string, text: string): Outline | null {
  const tree = parseTree(text); if (!tree) return null;
  const obj = (p: JSONPath) => { const n = findNodeAtLocation(tree, p); return n?.type === 'object' ? n.children ?? [] : []; };
  const keyOf = (prop: JNode) => String(prop.children?.[0]?.value ?? '');
  const resources: Resource[] = obj(['paths']).filter((p) => keyOf(p).startsWith('/')).map((p) => ({
    kind: 'res', id: 'res:' + keyOf(p), key: keyOf(p), path: keyOf(p), from: p.offset, children: [],
    methods: obj(['paths', keyOf(p)]).filter((m) => METHODS.includes(keyOf(m))).map((m) => {
      const s = findNodeAtLocation(tree, ['paths', keyOf(p), keyOf(m), 'summary']);
      return { kind: 'method', id: `m:${keyOf(m)}:${keyOf(p)}`, m: keyOf(m), path: keyOf(p), name: typeof s?.value === 'string' ? s.value : '', from: m.offset };
    }),
  }));
  const decls = (key: string, kind: Decl['kind']): Decl[] => obj(['components', key]).map((d) => ({ kind, id: `${kind}:${keyOf(d)}`, name: keyOf(d), alias: null, file, from: d.offset }));
  return { resources, types: decls('schemas', 'type'), traits: [], resourceTypes: [], securitySchemes: decls('securitySchemes', 'sec'), libraries: [] };
}
// The tree node under an offset: an operation, a path, or a schema.
export function oasJsonSelection(text: string, offset: number): string | null {
  const tree = parseTree(text); if (!tree) return null;
  const n = findNodeAtOffset(tree, offset); if (!n) return null;
  const p = getNodePath(n);
  if (p[0] === 'paths' && typeof p[1] === 'string') return METHODS.includes(String(p[2])) ? `m:${p[2]}:${p[1]}` : 'res:' + p[1];
  return p[0] === 'components' && p[1] === 'schemas' && typeof p[2] === 'string' ? 'type:' + p[2] : null;
}

export function OasJsonInspector({ file, text, line, readOnly, model, onEdit, onGoOffset, onOpenAt, onJsonSchema }: {
  file: string; text: string; line: number; readOnly: boolean; model: AmfModel | null;
  onEdit: (fn: (t: string) => string) => void; onGoOffset: (offset: number) => void; onOpenAt: (at: At) => void; onJsonSchema: (name: string, file: string) => void;
}) {
  const tree = useMemo(() => parseTree(text), [text]);
  // The JSON path under the cursor: the first non-space character of the line.
  const here: JSONPath = useMemo(() => {
    if (!tree) return [];
    const L = text.split('\n'); let off = 0;
    for (let i = 0; i < line && i < L.length; i++) off += L[i].length + 1;
    off += (L[line] ?? '').search(/\S|$/);
    const n = findNodeAtOffset(tree, off); return n ? getNodePath(n) : [];
  }, [tree, text, line]);
  const node = (p: JSONPath): JNode | undefined => (tree ? findNodeAtLocation(tree, p) : undefined);
  const val = (p: JSONPath) => { const n = node(p); return n ? getNodeValue(n) : undefined; };
  const str = (p: JSONPath) => { const v = val(p); return typeof v === 'string' ? v : v == null ? '' : String(v); };
  const go = (p: JSONPath) => { const n = node(p); if (n) onGoOffset(n.parent?.type === 'property' ? n.parent.offset : n.offset); };
  const inside = (p: JSONPath) => p.every((x, i) => here[i] === x);
  const rowCls = (on: boolean) => `group/r rounded-md px-1.5 -mx-1.5 ${on ? 'bg-accent-dim' : 'hover:bg-[var(--hover-overlay)]'}`;
  const schemaNames = Object.keys((val(['components', 'schemas']) as J) ?? {});
  const known = (t: string) => !t || OAS_BUILTIN.includes(t.replace(/\[\]$/, '')) || schemaNames.includes(t.replace(/\[\]$/, ''));

  const typeOf = (p: JSONPath): string => {
    const v = val(p) as J | undefined; if (!v || typeof v !== 'object') return '';
    if (typeof v.$ref === 'string') return v.$ref.replace(REF, '');
    if (v.type === 'array') { const i = typeOf([...p, 'items']); return i ? i + '[]' : 'array'; }
    return typeof v.type === 'string' ? v.type : v.properties ? 'object' : '';
  };
  // New keys first (changed in place or added), then the old type keys that no longer apply, so a schema
  // never passes through {} and keeps its own layout.
  const setType = (x: string, p: JSONPath, t: string) => {
    const arr = t.endsWith('[]'), b = arr ? t.slice(0, -2) : t;
    const one = (y: string): J => (OAS_BUILTIN.includes(y) ? { type: y } : { $ref: REF + y });
    const nu: J = !t ? {} : arr ? { type: 'array', items: one(b) } : one(b);
    if (!node(p)) return t ? set(x, p, nu) : x;
    for (const k of Object.keys(nu)) x = set(x, [...p, k], nu[k]);
    for (const k of ['$ref', 'type', 'items', 'format']) if (!(k in nu) && findNodeAtLocation(parseTree(x)!, [...p, k])) x = set(x, [...p, k], undefined);
    return x;
  };
  const typeCell = (p: JSONPath) => {
    const t = typeOf(p), target = schemaNames.includes(t.replace(/\[\]$/, '')) ? ['components', 'schemas', t.replace(/\[\]$/, '')] : null;
    return (
      <span className="flex items-center gap-0.5 min-w-0 flex-1">
        <Field value={t} mono list="ads-oasj-types" placeholder="string" onCommit={(v) => onEdit((x) => setType(x, p, v.trim()))} className={known(t) ? 'text-[var(--syn-type)]' : 'text-err'} />
        {target && <IconBtn title={`Go to ${target[2]}`} onClick={() => go(target)}><Icons.ChevronRight size={12} /></IconBtn>}
      </span>
    );
  };
  const field = (p: JSONPath, key: string, placeholder: string, mono = false, multiline = false) => (
    <Field value={str([...p, key])} placeholder={placeholder} mono={mono} multiline={multiline} onCommit={(v) => onEdit((x) => set(x, [...p, key], v || undefined))} />
  );
  const content = (p: JSONPath) => {
    const media = Object.keys((val([...p, 'content']) as J) ?? {});
    return (
      <div className="mt-1 flex flex-col gap-0.5">
        {media.map((m) => (
          <div key={m} className={rowCls(inside([...p, 'content', m])) + ' flex items-center gap-1.5 py-[3px]'} onClick={() => go([...p, 'content', m])}>
            <span className="text-[11px] font-mono text-content-faint shrink-0 max-w-[45%] truncate" title={m}>{m}</span>
            {typeCell([...p, 'content', m, 'schema'])}
            <span className="opacity-0 group-hover/r:opacity-100"><IconBtn title="Remove" onClick={() => onEdit((x) => set(x, [...p, 'content', m], undefined))}><Icons.X size={11} /></IconBtn></span>
          </div>
        ))}
        <div className="flex"><AddSelect label="Content" options={MEDIA.filter((m) => !media.includes(m))} onPick={(m) => onEdit((x) => set(x, [...p, 'content', m], { schema: { type: 'object' } }))} /></div>
      </div>
    );
  };
  let h: ReactNode;

  if (!tree) {
    h = <div className="text-[12.5px] text-content-faint">The JSON can't be read right now. Fix it in the code and the form comes back.</div>;
  } else if (here[0] === 'paths' && typeof here[1] === 'string' && METHODS.includes(String(here[2]))) {
    const op: JSONPath = ['paths', here[1], here[2]];
    const ps = (val([...op, 'parameters']) as J[] | undefined) ?? [];
    const codes = Object.keys((val([...op, 'responses']) as J) ?? {});
    h = (
      <>
        <div className="flex items-center gap-2 min-w-0"><Badge m={String(here[2])} /><span className="font-mono text-[13.5px] font-bold break-all">{here[1]}</span></div>
        <div className="mt-3 flex flex-col gap-1.5">
          {field(op, 'summary', 'Summary')}
          {field(op, 'description', 'Description', false, true)}
          {field(op, 'operationId', 'operationId', true)}
          <Field mono value={((val([...op, 'tags']) as string[]) ?? []).join(', ')} placeholder="Tags, separated by commas"
            onCommit={(v) => onEdit((x) => { const tags = v.split(',').map((s) => s.trim()).filter(Boolean); return set(x, [...op, 'tags'], tags.length ? tags : undefined); })} />
        </div>
        <Sec title="Parameters" count={ps.length || undefined}
          add={<button onClick={() => onEdit((x) => pushItem(x, [...op, 'parameters'], { name: 'param', in: 'query', schema: { type: 'string' } }))} className="normal-case tracking-normal font-medium text-[11px] text-accent hover:underline flex items-center gap-0.5"><Icons.Plus size={11} />Add</button>}>
          {ps.length === 0 && <div className="text-[11.5px] text-content-faint">None.</div>}
          {ps.map((p, n) => {
            const ip = [...op, 'parameters', n];
            if (typeof p.$ref === 'string') return <div key={n} className={rowCls(inside(ip)) + ' py-[3px] font-mono text-[11.5px] text-content-secondary'} onClick={() => go(ip)}>{p.$ref}</div>;
            const where = typeof p.in === 'string' ? p.in : 'query';
            return (
              <div key={n} className={rowCls(inside(ip)) + ' flex items-center gap-1 py-[3px]'} onClick={() => go(ip)}>
                <span className="w-[32%] shrink-0"><Field value={str([...ip, 'name'])} mono onCommit={(v) => v && onEdit((x) => set(x, [...ip, 'name'], v))} /></span>
                <select value={where} onClick={(e) => e.stopPropagation()} onChange={(e) => onEdit((x) => set(x, [...ip, 'in'], e.target.value))}
                  className="h-[26px] w-[62px] shrink-0 rounded border border-line bg-surface-input text-[11px] font-mono text-content-secondary">
                  {['query', 'path', 'header', 'cookie'].map((w) => <option key={w}>{w}</option>)}
                </select>
                {typeCell([...ip, 'schema'])}
                <label title="Required" className="shrink-0 flex items-center gap-1 text-[10.5px] text-content-faint cursor-pointer" onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" checked={where === 'path' || p.required === true} disabled={where === 'path'} className="accent-[var(--accent)]"
                    onChange={(e) => onEdit((x) => set(x, [...ip, 'required'], e.target.checked ? true : undefined))} />req
                </label>
                <span className="opacity-0 group-hover/r:opacity-100"><IconBtn title="Remove" onClick={() => onEdit((x) => set(x, ip, undefined))}><Icons.X size={11} /></IconBtn></span>
              </div>
            );
          })}
        </Sec>
        {(['post', 'put', 'patch'].includes(String(here[2])) || node([...op, 'requestBody'])) && <Sec title="Request body">{content([...op, 'requestBody'])}</Sec>}
        <Sec title="Responses" count={codes.length || undefined}
          add={<AddSelect label="Add response" options={Object.keys(CODES).filter((c) => !codes.includes(c))} onPick={(c) => onEdit((x) => set(x, [...op, 'responses', c], { description: CODES[c] }))} />}>
          {codes.map((c) => {
            const p = [...op, 'responses', c];
            return (
              <div key={c} className={rowCls(inside(p)) + ' border border-line rounded-md p-2 mb-1.5 mx-0 bg-bg'} onClick={() => go(p)}>
                <div className="flex items-center gap-2">
                  <span className="font-mono font-bold text-[11.5px] px-1.5 rounded-[3px]" style={{ color: codeColor(c), background: `color-mix(in oklch, ${codeColor(c)} 13%, transparent)` }}>{c}</span>
                  <Field value={str([...p, 'description'])} placeholder="Description (required in OAS)" onCommit={(v) => onEdit((x) => set(x, [...p, 'description'], v))} />
                  <span className="opacity-0 group-hover/r:opacity-100"><IconBtn title="Remove this response" onClick={() => onEdit((x) => set(x, p, undefined))}><Icons.X size={11} /></IconBtn></span>
                </div>
                {content(p)}
              </div>
            );
          })}
        </Sec>
      </>
    );
  } else if (here[0] === 'paths' && typeof here[1] === 'string') {
    const p: JSONPath = ['paths', here[1]];
    const ops = Object.keys((val(p) as J) ?? {}).filter((k) => METHODS.includes(k));
    h = (
      <>
        <span className="font-mono text-[13.5px] font-bold break-all">{here[1]}</span>
        <div className="mt-3 flex flex-col gap-1.5">{field(p, 'summary', 'Summary')}{field(p, 'description', 'Description', false, true)}</div>
        <Sec title="Operations" count={ops.length || undefined} add={<AddSelect label="Add operation" options={METHODS.filter((m) => !ops.includes(m))} onPick={(m) => onEdit((x) => set(x, [...p, m], { responses: { 200: { description: 'OK' } } }))} />}>
          {ops.map((m) => <div key={m} onClick={() => go([...p, m])} className="flex items-center gap-2 px-1.5 -mx-1.5 py-1 rounded-md cursor-pointer hover:bg-[var(--hover-overlay)]"><Badge m={m} /><span className="text-[12px] truncate">{str([...p, m, 'summary'])}</span></div>)}
        </Sec>
      </>
    );
  } else if (here[0] === 'components' && here[1] === 'schemas' && typeof here[2] === 'string') {
    const name = here[2], p: JSONPath = ['components', 'schemas', name];
    const props = Object.keys((val([...p, 'properties']) as J) ?? {});
    const req = (val([...p, 'required']) as string[]) ?? [];
    const setReq = (x: string, r: string[]) => set(x, [...p, 'required'], r.length ? r : undefined);
    const amfSchema = model?.types.find((t) => t.name === name && t.at?.file === file);
    h = (
      <>
        <span className="font-mono text-[13.5px] font-bold break-all">{name}</span>
        <div className="mt-1 text-[12.5px] text-content-secondary">Schema</div>
        {amfSchema && <div className="mt-3"><button onClick={() => onJsonSchema(name, file)} className={BTN} title="AMF renders this schema as JSON Schema and puts it on the clipboard">Copy as JSON Schema</button></div>}
        <Sec title="Type">{typeCell(p)}</Sec>
        <div className="mt-3">{field(p, 'description', 'Description', false, true)}</div>
        {Array.isArray(val([...p, 'enum'])) ? (
          <Sec title="Values"><Field mono value={(val([...p, 'enum']) as unknown[]).join(', ')} onCommit={(v) => onEdit((x) => set(x, [...p, 'enum'], v.split(',').map((s) => s.trim()).filter(Boolean)))} /></Sec>
        ) : (
          <Sec title="Properties" count={props.length || undefined}
            add={<button onClick={() => { let n = 'property', i = 2; while (props.includes(n)) n = 'property' + i++; onEdit((x) => set(x, [...p, 'properties', n], { type: 'string' })); }}
              className="normal-case tracking-normal font-medium text-[11px] text-accent hover:underline flex items-center gap-0.5"><Icons.Plus size={11} />Add property</button>}>
            {props.length === 0 && <div className="text-[11.5px] text-content-faint">No properties.</div>}
            {props.map((k) => {
              const pp = [...p, 'properties', k];
              return (
                <div key={k} className={rowCls(inside(pp)) + ' flex items-center gap-1 py-[3px]'} onClick={() => go(pp)}>
                  <span className="w-[38%] shrink-0"><Field value={k} mono onCommit={(v) => v && onEdit((x) => { let y = renameKey(x, pp, v); if (req.includes(k)) y = setReq(y, req.map((r) => (r === k ? v : r))); return y; })} /></span>
                  {typeCell(pp)}
                  <label title="Required" className="shrink-0 flex items-center gap-1 text-[10.5px] text-content-faint cursor-pointer" onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={req.includes(k)} className="accent-[var(--accent)]" onChange={(e) => onEdit((x) => setReq(x, e.target.checked ? [...req, k] : req.filter((r) => r !== k)))} />req
                  </label>
                  <span className="opacity-0 group-hover/r:opacity-100"><IconBtn title="Remove" onClick={() => onEdit((x) => { const y = set(x, pp, undefined); return req.includes(k) ? setReq(y, req.filter((r) => r !== k)) : y; })}><Icons.X size={11} /></IconBtn></span>
                </div>
              );
            })}
          </Sec>
        )}
        <UsedBy uses={model ? amfSchema?.usedBy ?? [] : null} onOpenAt={onOpenAt} />
      </>
    );
  } else {
    const servers = (val(['servers']) as J[] | undefined) ?? [];
    h = (
      <>
        <span className="text-[13.5px] font-bold">{str(['info', 'title']) || 'Untitled API'}</span>
        <div className="mt-1 text-[12.5px] text-content-secondary">OpenAPI {str(['openapi'])}, {Object.keys((val(['paths']) as J) ?? {}).length} paths, {schemaNames.length} schemas</div>
        <Sec title="Info"><div className="flex flex-col gap-1.5">{field(['info'], 'title', 'Title')}{field(['info'], 'version', 'Version', true)}{field(['info'], 'description', 'Description', false, true)}</div></Sec>
        <Sec title="Servers" count={servers.length || undefined}
          add={<button onClick={() => onEdit((x) => pushItem(x, ['servers'], { url: 'https://api.example.com' }))} className="normal-case tracking-normal font-medium text-[11px] text-accent hover:underline flex items-center gap-0.5"><Icons.Plus size={11} />Add</button>}>
          {servers.map((_s, n) => (
            <div key={n} className="group/r flex items-center gap-1 py-[3px]">
              <Field value={str(['servers', n, 'url'])} mono onCommit={(v) => v && onEdit((x) => set(x, ['servers', n, 'url'], v))} />
              <span className="opacity-0 group-hover/r:opacity-100"><IconBtn title="Remove" onClick={() => onEdit((x) => set(x, ['servers', n], undefined))}><Icons.X size={11} /></IconBtn></span>
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
      <datalist id="ads-oasj-types">{[...schemaNames, ...OAS_BUILTIN].map((t) => <option key={t} value={t} />)}</datalist>
    </div>
  );
}
