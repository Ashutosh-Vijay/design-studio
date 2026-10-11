// M5: the API map (PLAN 7.1). A read-only graph of what uses what: resources, then traits, resource types and
// security schemes, then types grouped by the file that declares them, then example and fragment files.
// Edges come from AMF ("Used by" links, applied traits, resource types, security) and from !include lines.
// Click a node to light up everything that depends on it; "Show unused" finds what nothing uses.
import { useMemo, useRef, useState, useEffect } from 'react';
import { Badge, type AmfModel, type At } from './Inspector';
import { keyPathAt, type Outline } from './raml';
import { Icons } from './components/Icons';

type Kind = 'res' | 'trait' | 'rt' | 'sec' | 'type' | 'file';
type Node = { id: string; kind: Kind; label: string; group?: string; methods?: string[]; at?: At; decl?: { file: string; from: number }; exchange?: boolean };
type Graph = { nodes: Map<string, Node>; out: Map<string, Set<string>>; inn: Map<string, Set<string>> };
const W = 230, NH = 26, GAP = 6, COLX = [24, 324, 624, 924], HEAD = 22;
const KIND_LABEL: Record<Kind, string> = { res: 'Resource', trait: 'Trait', rt: 'Resource type', sec: 'Security scheme', type: 'Type', file: 'File' };
const col = (k: Kind) => (k === 'res' ? 0 : k === 'type' ? 2 : k === 'file' ? 3 : 1);
const bare = (n: string) => n.replace(/^.*\./, '');

function build(model: AmfModel, outline: Outline | null, rootFile: string, rootText: string): Graph {
  const nodes = new Map<string, Node>(), out = new Map<string, Set<string>>(), inn = new Map<string, Set<string>>();
  const add = (n: Node) => { if (!nodes.has(n.id)) nodes.set(n.id, n); return n.id; };
  const edge = (a: string, b: string) => { if (a === b || !nodes.has(a) || !nodes.has(b)) return; (out.get(a) ?? out.set(a, new Set()).get(a)!).add(b); (inn.get(b) ?? inn.set(b, new Set()).get(b)!).add(a); };
  // Declarations, from the outline (so unused ones are there too) and AMF's types.
  for (const d of outline?.traits ?? []) add({ id: 'trait:' + d.name, kind: 'trait', label: d.alias ? `${d.alias}.${d.name}` : d.name, decl: d });
  for (const d of outline?.resourceTypes ?? []) add({ id: 'rt:' + d.name, kind: 'rt', label: d.alias ? `${d.alias}.${d.name}` : d.name, decl: d });
  for (const d of outline?.securitySchemes ?? []) add({ id: 'sec:' + d.name, kind: 'sec', label: d.alias ? `${d.alias}.${d.name}` : d.name, decl: d });
  for (const t of model.types) if (t.name) add({ id: 'type:' + t.name, kind: 'type', label: t.name, group: t.at?.file ?? rootFile, at: t.at, exchange: (t.at?.file ?? '').startsWith('exchange_modules/') });
  for (const e of model.endpoints ?? []) if (e.operations.length) add({ id: 'res:' + e.path, kind: 'res', label: e.path, methods: e.operations.map((o) => o.method), at: e.at });
  for (const f of model.files ?? []) if (!['Document', 'Module'].includes(f.kind) && f.file !== rootFile)
    add({ id: 'file:' + f.file, kind: 'file', label: f.file.replace(/^exchange_modules\/[^/]+\//, ''), group: f.kind, exchange: f.file.startsWith('exchange_modules/') });
  const ref = (kind: 'trait' | 'rt' | 'sec', name: string) => { const id = `${kind}:${bare(name)}`; if (!nodes.has(id)) add({ id, kind, label: name }); return id; };
  // Applied traits, resource types and security.
  for (const e of model.endpoints ?? []) {
    if (e.resourceType) edge('res:' + e.path, ref('rt', e.resourceType));
    for (const o of e.operations) { for (const t of o.is ?? []) edge('res:' + e.path, ref('trait', t)); for (const s of o.securedBy ?? []) edge('res:' + e.path, ref('sec', s)); }
  }
  // AMF's Used by: "GET /orders 200", "trait paged", "resource type collection", "Customer.address".
  for (const t of model.types) for (const u of t.usedBy) {
    const m = u.where.match(/^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) (\S+)/);
    const from = m ? 'res:' + m[1] : /^trait /.test(u.where) ? 'trait:' + bare(u.where.slice(6)) : /^resource type /.test(u.where) ? 'rt:' + bare(u.where.slice(14)) : 'type:' + u.where.split('.')[0].split(' ')[0];
    edge(from, 'type:' + t.name);
  }
  // Example and fragment files: from the !include line's place in the root file, else from the file that references them.
  const L = rootText.split('\n');
  for (const f of model.files ?? []) for (const r of f.refs) {
    if (!nodes.has('file:' + r)) continue;
    if (f.file === rootFile) {
      const line = L.findIndex((l) => l.includes('!include') && (l.includes(r) || l.includes(r.split('/').pop()!)));
      const path = line >= 0 ? keyPathAt(rootText, line).map((e) => e.key) : [];
      const res = path.filter((k) => k.startsWith('/')).join('');
      const decl = path[0] === 'types' && path[1] ? 'type:' + path[1] : path[0] === 'traits' && path[1] ? 'trait:' + path[1] : path[0] === 'resourceTypes' && path[1] ? 'rt:' + path[1] : null;
      if (res && nodes.has('res:' + res)) edge('res:' + res, 'file:' + r); else if (decl) edge(decl, 'file:' + r);
    } else {
      // From a library or fragment: its types use it.
      for (const n of nodes.values()) if (n.kind === 'type' && n.group === f.file) edge(n.id, 'file:' + r);
      edge('file:' + f.file, 'file:' + r);
    }
  }
  return { nodes, out, inn };
}
// Everything reachable through one direction of edges.
function reach(start: string, next: Map<string, Set<string>>) {
  const seen = new Set<string>(), todo = [start];
  while (todo.length) { const x = todo.pop()!; for (const y of next.get(x) ?? []) if (!seen.has(y)) { seen.add(y); todo.push(y); } }
  return seen;
}

export function ApiMap({ model, outline, rootFile, rootText, onOpenAt, onReveal }: {
  model: AmfModel | null; outline: Outline | null; rootFile: string; rootText: string; onOpenAt: (at: At) => void; onReveal: (file: string, from: number) => void;
}) {
  const g = useMemo(() => (model ? build(model, outline, rootFile, rootText) : null), [model, outline, rootFile, rootText]);
  // Used means some resource reaches it, directly or through other declarations.
  const reached = useMemo(() => { const r = new Set<string>(); if (g) for (const n of g.nodes.values()) if (n.kind === 'res') for (const x of reach(n.id, g.out)) r.add(x); return r; }, [g]);
  const [sel, setSel] = useState<string | null>(null);
  const [unused, setUnused] = useState(false);
  const [q, setQ] = useState('');
  const [closed, setClosed] = useState<Set<string> | null>(null);
  const [zoom, setZoom] = useState(1);
  const box = useRef<HTMLDivElement>(null);
  // Big specs start with libraries folded.
  useEffect(() => { if (g && closed == null) setClosed(new Set(g.nodes.size > 250 ? [...g.nodes.values()].filter((n) => n.kind === 'type' && n.group !== rootFile).map((n) => n.group!) : [])); }, [g]); // eslint-disable-line react-hooks/exhaustive-deps

  // Positions: four columns; types in groups by file, each group folding to its header. Within a column,
  // nodes follow the average place of what uses them, which keeps lines short.
  const lay = useMemo(() => {
    if (!g) return null;
    const pos = new Map<string, { x: number; y: number }>(), heads: { group: string; x: number; y: number; n: number }[] = [];
    const y0 = [HEAD + 12, HEAD + 12, HEAD + 12, HEAD + 12];
    const order = (k: Kind) => [...g.nodes.values()].filter((n) => n.kind === k);
    const place = (n: Node, c: number) => { pos.set(n.id, { x: COLX[c], y: y0[c] }); y0[c] += NH + GAP; };
    const bary = (n: Node) => { const ys = [...(g.inn.get(n.id) ?? [])].map((i) => pos.get(i)?.y).filter((y): y is number => y != null); return ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : 1e9; };
    order('res').sort((a, b) => a.label.localeCompare(b.label)).forEach((n) => place(n, 0));
    [...order('trait'), ...order('rt'), ...order('sec')].sort((a, b) => bary(a) - bary(b)).forEach((n) => place(n, 1));
    const groups = new Map<string, Node[]>();
    for (const n of order('type')) (groups.get(n.group!) ?? groups.set(n.group!, []).get(n.group!)!).push(n);
    const gs = [...groups.entries()].sort((a, b) => (a[0] === rootFile ? -1 : b[0] === rootFile ? 1 : Math.min(...a[1].map(bary)) - Math.min(...b[1].map(bary))));
    for (const [group, ns] of gs) {
      heads.push({ group, x: COLX[2], y: y0[2], n: ns.length }); y0[2] += NH;
      if (closed?.has(group)) { for (const n of ns) pos.set(n.id, { x: COLX[2], y: y0[2] - NH }); y0[2] += GAP; continue; }
      ns.sort((a, b) => bary(a) - bary(b)).forEach((n) => place(n, 2));
      y0[2] += GAP * 2;
    }
    order('file').sort((a, b) => bary(a) - bary(b)).forEach((n) => place(n, 3));
    return { pos, heads, h: Math.max(...y0) + 40 };
  }, [g, closed, rootFile]);

  if (!model || !g || !lay) return <div className="flex-1 flex items-center justify-center text-[12.5px] text-content-faint">The map shows after the spec is checked.</div>;
  const isUnused = (n: Node) => n.kind !== 'res' && !reached.has(n.id);
  const lit = sel ? new Set([sel, ...reach(sel, g.inn)]) : null; // what depends on the selection
  const uses = sel ? reach(sel, g.out) : null; // what the selection depends on
  const match = q.trim() ? new Set([...g.nodes.values()].filter((n) => n.label.toLowerCase().includes(q.trim().toLowerCase())).map((n) => n.id)) : null;
  const dim = (id: string) => (lit ? !lit.has(id) && !uses!.has(id) : unused ? !isUnused(g.nodes.get(id)!) : match ? !match.has(id) : false);
  const visible = (id: string) => { const n = g.nodes.get(id)!; return !(n.kind === 'type' && closed?.has(n.group!)); };
  const go = (n: Node) => { if (n.at) onOpenAt(n.at); else if (n.decl) onReveal(n.decl.file, n.decl.from); else if (n.kind === 'file') onReveal(n.id.slice(5), 0); };
  const counts = (ids: Iterable<string>) => { const c: Partial<Record<Kind, number>> = {}; for (const i of ids) { const k = g.nodes.get(i)!.kind; c[k] = (c[k] ?? 0) + 1; } return Object.entries(c).map(([k, v]) => `${v} ${KIND_LABEL[k as Kind].toLowerCase()}${v === 1 ? '' : 's'}`).join(', ') || 'nothing'; };
  const s = sel ? g.nodes.get(sel)! : null;
  const unusedList = [...g.nodes.values()].filter(isUnused);
  const color = (n: Node) => (n.kind === 'res' ? 'var(--content)' : n.kind === 'type' ? 'var(--syn-type)' : n.kind === 'file' ? 'var(--syn-fn)' : 'var(--violet)');

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="h-9 shrink-0 flex items-center gap-2 px-3 border-b border-line-subtle text-[12px]">
        <label className="flex items-center gap-1.5 h-[26px] w-[220px] px-2 rounded-md bg-surface-2 border border-line text-content-faint focus-within:border-accent-border">
          <Icons.Search size={12} /><input value={q} onChange={(e) => { setQ(e.target.value); setSel(null); }} placeholder="Find on the map" spellCheck={false} className="flex-1 min-w-0 bg-transparent outline-none text-[12px] text-content" /></label>
        <label className="flex items-center gap-1.5 cursor-pointer text-content-secondary"><input type="checkbox" checked={unused} onChange={(e) => { setUnused(e.target.checked); setSel(null); }} className="accent-[var(--accent)]" />Show unused ({unusedList.length})</label>
        <span className="flex-1" />
        <span className="text-content-faint">{counts(g.nodes.keys())}</span>
        <button className="w-6 h-6 rounded hover:bg-surface-3" title="Zoom out" onClick={() => setZoom((z) => Math.max(0.4, z - 0.15))}>−</button>
        <button className="w-6 h-6 rounded hover:bg-surface-3" title="Zoom in" onClick={() => setZoom((z) => Math.min(1.6, z + 0.15))}>+</button>
      </div>
      <div className="flex-1 min-h-0 flex">
        <div ref={box} className="flex-1 min-w-0 overflow-auto bg-bg" onClick={() => setSel(null)}>
          <div style={{ width: (COLX[3] + W + 40) * zoom, height: lay.h * zoom, position: 'relative' }}>
            <div style={{ transform: `scale(${zoom})`, transformOrigin: '0 0', position: 'absolute', inset: 0, width: COLX[3] + W + 40, height: lay.h }}>
              {['Resources', 'Traits, resource types, security', 'Types', 'Examples and fragments'].map((t, i) => (
                <div key={t} className="absolute text-[10px] font-semibold uppercase tracking-[0.5px] text-content-faint" style={{ left: COLX[i], top: 8 }}>{t}</div>
              ))}
              <svg className="absolute inset-0 pointer-events-none" width={COLX[3] + W + 40} height={lay.h}>
                {[...g.out.entries()].flatMap(([a, bs]) => [...bs].map((b) => {
                  const p = lay.pos.get(a), r = lay.pos.get(b); if (!p || !r) return null;
                  const on = lit ? (lit.has(a) && (lit.has(b) || b === sel)) || (uses!.has(b) && (a === sel || uses!.has(a))) : unused ? false : match ? match.has(a) || match.has(b) : true;
                  const same = col(g.nodes.get(a)!.kind) === col(g.nodes.get(b)!.kind);
                  const x1 = p.x + W, y1 = p.y + NH / 2, x2 = same ? r.x + W : r.x, y2 = r.y + NH / 2;
                  const d = same ? `M${x1},${y1} C${x1 + 60},${y1} ${x2 + 60},${y2} ${x2},${y2}` : `M${x1},${y1} C${x1 + 50},${y1} ${x2 - 50},${y2} ${x2},${y2}`;
                  return <path key={a + '>' + b} d={d} fill="none" stroke={on && (lit || match) ? 'var(--accent)' : 'var(--line)'} strokeWidth={on && lit ? 1.6 : 1} opacity={on ? 0.9 : 0.25} />;
                }))}
              </svg>
              {lay.heads.map((h) => (
                <button key={h.group} onClick={(e) => { e.stopPropagation(); const c = new Set(closed); c.has(h.group) ? c.delete(h.group) : c.add(h.group); setClosed(c); }}
                  className="absolute flex items-center gap-1 text-[11px] text-content-muted hover:text-content truncate" style={{ left: h.x, top: h.y + 4, width: W }} title={h.group}>
                  {closed?.has(h.group) ? <Icons.ChevronRight size={11} /> : <Icons.ChevronDown size={11} />}<span className="truncate font-mono">{h.group === rootFile ? 'Root file' : h.group.replace(/^exchange_modules\/[^/]+\//, '')}</span><span className="text-content-faint">({h.n})</span>
                </button>
              ))}
              {[...g.nodes.values()].filter((n) => visible(n.id)).map((n) => {
                const p = lay.pos.get(n.id)!; const on = sel === n.id;
                return (
                  <div key={n.id} onClick={(e) => { e.stopPropagation(); setSel(on ? null : n.id); }} onDoubleClick={(e) => { e.stopPropagation(); go(n); }}
                    title={`${KIND_LABEL[n.kind]}: ${n.label}${n.kind === 'res' ? '' : isUnused(n) ? ' (nothing uses it)' : ''}. Double-click to show it in the code.`}
                    className={`absolute flex items-center gap-1.5 px-2 rounded-md border text-[11.5px] cursor-pointer bg-surface ${on ? 'border-accent ring-1 ring-accent' : lit?.has(n.id) ? 'border-accent-border' : uses?.has(n.id) ? 'border-[color-mix(in_oklch,var(--cyan)_60%,transparent)]' : 'border-line hover:border-content-ghost'}`}
                    style={{ left: p.x, top: p.y, width: W, height: NH, opacity: dim(n.id) ? 0.3 : 1 }}>
                    {n.kind === 'res' ? <span className="flex gap-0.5 shrink-0">{n.methods!.slice(0, 3).map((m) => <span key={m} className="scale-90 origin-left -mr-2"><Badge m={m} /></span>)}</span>
                      : <span className="font-mono text-[9px] font-bold w-4 h-4 shrink-0 rounded-[3px] inline-flex items-center justify-center" style={{ color: color(n), background: `color-mix(in oklch, ${color(n)} 16%, transparent)` }}>{{ trait: 'Tr', rt: 'RT', sec: 'S', type: 'T', file: 'F', res: '' }[n.kind]}</span>}
                    <span className={`font-mono truncate ${n.kind === 'res' ? 'ml-2' : ''}`} style={{ color: color(n) }}>{n.label}</span>
                    {n.exchange && <span className="ml-auto text-[9px] px-1 rounded border border-line text-content-faint shrink-0">Exchange</span>}
                    {unused && isUnused(n) && <span className="ml-auto w-1.5 h-1.5 rounded-full bg-warn shrink-0" />}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
        {(s || unused) && (
          <div className="w-[260px] shrink-0 border-l border-line bg-surface overflow-auto p-3 text-[12px]">
            {s ? <>
              <div className="text-[10px] font-semibold uppercase tracking-[0.5px] text-content-faint">{KIND_LABEL[s.kind]}</div>
              <div className="mt-0.5 font-mono text-[12.5px] font-bold break-all">{s.label}</div>
              <button className="mt-2 h-[24px] px-2.5 rounded-md text-[11.5px] border border-line bg-surface-2 text-content-secondary hover:text-content" onClick={() => go(s)}>Show in code</button>
              <div className="mt-3 text-content-secondary"><b>Depends on it:</b> {s.kind === 'res' ? 'nothing (a resource is the top)' : counts(lit!) === 'nothing' ? 'nothing' : counts([...lit!].filter((x) => x !== sel))}</div>
              <div className="mt-1 text-content-secondary"><b>It uses:</b> {counts(uses!)}</div>
              {s.kind !== 'res' && <div className="mt-3 text-[11px] text-content-faint">Changing it affects everything lit up. Resources at the left are the endpoints callers see.</div>}
              <div className="mt-2 flex flex-col">
                {[...(lit ?? [])].filter((x) => x !== sel && g.nodes.get(x)!.kind === 'res').slice(0, 60).map((x) => (
                  <button key={x} onClick={() => go(g.nodes.get(x)!)} className="text-left font-mono text-[11.5px] py-0.5 hover:underline truncate">{g.nodes.get(x)!.label}</button>
                ))}
              </div>
            </> : <>
              <div className="font-semibold">Nothing uses these</div>
              <div className="mt-1 text-[11px] text-content-faint">Types, traits, resource types, security schemes and files no resource reaches. Exchange ones come with their fragment.</div>
              {(['type', 'trait', 'rt', 'sec', 'file'] as Kind[]).map((k) => { const l = unusedList.filter((n) => n.kind === k); return l.length ? (
                <div key={k} className="mt-2.5"><div className="text-[10px] font-semibold uppercase tracking-[0.5px] text-content-faint">{KIND_LABEL[k]}s ({l.length})</div>
                  {l.map((n) => <button key={n.id} onClick={() => go(n)} className="block text-left font-mono text-[11.5px] py-0.5 hover:underline truncate w-full" title={n.label}>{n.label}{n.exchange ? ' (Exchange)' : ''}</button>)}</div>
              ) : null; })}
            </>}
          </div>
        )}
      </div>
    </div>
  );
}
