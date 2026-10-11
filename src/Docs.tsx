// M5: the Documentation panel (Design Center's right-hand Documentation, our own rendering of AMF's model)
// and Try it against the local mock, which amf-server runs on the open spec, unsaved edits included.
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Icons } from './components/Icons';
import { Badge, codeColor, type AmfModel, type At } from './Inspector';

type Page = { kind: 'home' } | { kind: 'res'; path: string } | { kind: 'type'; name: string };
type Op = AmfModel['endpoints'][number]['operations'][number];
type Mock = { port: number } | null;

const H = ({ children }: { children: ReactNode }) => <div className="mt-4 mb-1.5 text-[10px] font-semibold uppercase tracking-[0.5px] text-content-faint">{children}</div>;
const Code = ({ children }: { children: string }) => <pre className="mt-1 p-2 rounded-md bg-surface-2 border border-line-subtle font-mono text-[11.5px] leading-[17px] whitespace-pre-wrap break-all select-text max-h-[260px] overflow-auto">{children}</pre>;
const Text = ({ children }: { children?: string }) => children ? <div className="text-[12.5px] text-content-secondary leading-relaxed whitespace-pre-wrap select-text">{children}</div> : null;
const bare = (t: string) => t.replace(/\[\]$/, '').replace(/\?$/, '').replace(/^.*\./, '');

export function DocsPanel({ model: checked, resolve, onOpenAt, startMock }: {
  model: AmfModel | null; resolve: () => Promise<AmfModel>; onOpenAt: (at: At) => void; startMock: () => Promise<Mock>;
}) {
  // The docs show the API as AMF resolves it, so headers and parameters from traits and resource types are
  // there too. Read again after each full check; until then the checked model stands in.
  const [resolved, setResolved] = useState<AmfModel | null>(null);
  useEffect(() => { if (checked) resolve().then(setResolved, () => setResolved(null)); }, [checked]); // eslint-disable-line react-hooks/exhaustive-deps
  const model = resolved ?? checked;
  const [shown, setPage] = useState<Page>({ kind: 'home' });
  const [mock, setMock] = useState<Mock>(null);
  const [trying, setTrying] = useState<string | null>(null);
  const types = useMemo(() => new Map((model?.types ?? []).map((t) => [t.name, t])), [model]);
  if (!model) return <div className="p-4 text-[12.5px] text-content-faint">The documentation shows after the spec is checked.</div>;
  if (!model.endpoints && !model.types.length) return <div className="p-4 text-[12.5px] text-content-faint">The root file isn't an API, so there's nothing to document.</div>;
  // A page whose resource or type was renamed or removed goes back to the start.
  const page: Page = (shown.kind === 'res' && !(model.endpoints ?? []).some((e) => e.path === shown.path)) || (shown.kind === 'type' && !types.has(shown.name)) ? { kind: 'home' } : shown;

  // A type name that has a page of its own becomes a link.
  const typeLink = (t: string) => {
    const name = bare(t);
    return types.has(name)
      ? <button className="font-mono text-[11.5px] text-accent hover:underline" onClick={() => setPage({ kind: 'type', name })}>{t}</button>
      : <span className="font-mono text-[11.5px] text-content-secondary">{t || 'any'}</span>;
  };
  const back = <button className="flex items-center gap-1 text-[12px] text-accent hover:underline" onClick={() => setPage({ kind: 'home' })}><Icons.ChevronDown size={11} className="rotate-90" />{model.title?.v || 'API'}</button>;

  let body: ReactNode;
  if (page.kind === 'res') {
    const ep = model.endpoints.find((e) => e.path === page.path)!;
    body = (
      <>
        {back}
        <div className="mt-2.5 font-mono text-[14px] font-bold break-all select-text">{ep.path}</div>
        {ep.resourceType && <div className="mt-1 text-[11.5px] text-content-faint">Resource type <span className="font-mono">{ep.resourceType}</span></div>}
        <div className="mt-1.5"><Text>{ep.description?.v}</Text></div>
        {ep.operations.map((o) => {
          const key = o.method + ' ' + ep.path;
          return (
            <div key={o.method} className="mt-3.5 pt-3 border-t border-line-subtle">
              <div className="flex items-center gap-2">
                <Badge m={o.method} />
                <b className="text-[12.5px] min-w-0 truncate">{o.summary?.v || o.operationId?.v || `${o.method.toUpperCase()} ${ep.path}`}</b>
                <button className="ml-auto h-6 px-2 rounded-md flex items-center gap-1 text-[11.5px] border border-line bg-surface-2 text-content-secondary hover:text-content"
                  onClick={async () => { if (trying === key) { setTrying(null); return; } setTrying(key); if (!mock) setMock(await startMock()); }}>
                  <Icons.Play size={9} />Try it
                </button>
                {o.at && <button title="Show in code" className="w-6 h-6 rounded flex items-center justify-center text-content-faint hover:bg-surface-3 hover:text-content" onClick={() => onOpenAt(o.at!)}><Icons.Braces size={13} /></button>}
              </div>
              <div className="mt-1.5"><Text>{o.description?.v}</Text></div>
              {(!!o.is?.length || !!o.securedBy?.length) && <div className="mt-1.5 flex flex-wrap gap-1 text-[11px]">
                {o.is?.map((t) => <span key={t} className="px-1.5 rounded border border-line text-content-faint">is {t}</span>)}
                {o.securedBy?.map((t) => <span key={t} className="px-1.5 rounded border border-line text-content-faint">secured by {t}</span>)}
              </div>}
              {trying === key && <TryIt op={o} path={ep.path} mock={mock} />}
              {o.parameters.length > 0 && <>
                <H>Parameters</H>
                {o.parameters.map((p) => (
                  <div key={p.in + p.name} className="py-1">
                    <div className="flex items-center gap-1.5 flex-wrap"><span className="font-mono text-[12px] font-semibold">{p.name}</span>{typeLink(p.type)}
                      <span className="text-[10.5px] text-content-faint">{p.in === 'path' ? 'URI' : p.in}{p.required ? ', required' : ''}</span></div>
                    {p.description && <div className="text-[11.5px] text-content-faint">{p.description}</div>}
                    {p.example && <div className="text-[11.5px] text-content-faint">Example: <span className="font-mono">{p.example}</span></div>}
                  </div>
                ))}
              </>}
              {o.body.length > 0 && <>
                <H>Request body</H>
                {o.body.map((b, i) => <div key={i} className="py-1"><div className="flex items-center gap-2"><span className="font-mono text-[11px] text-content-faint">{b.media || 'default'}</span>{typeLink(b.type)}</div>{b.example && <Code>{b.example}</Code>}</div>)}
              </>}
              {o.responses.length > 0 && <>
                <H>Responses</H>
                {o.responses.map((r) => (
                  <div key={r.code} className="py-1.5">
                    <div className="flex items-center gap-2"><span className="font-mono text-[11px] font-bold px-1.5 rounded" style={{ color: codeColor(r.code), background: `color-mix(in oklch, ${codeColor(r.code)} 14%, transparent)` }}>{r.code}</span>
                      <span className="text-[12px] text-content-secondary min-w-0">{r.description?.v}</span></div>
                    {r.body.map((b, i) => <div key={i} className="mt-1"><div className="flex items-center gap-2"><span className="font-mono text-[11px] text-content-faint">{b.media || 'default'}</span>{typeLink(b.type)}</div>{b.example && <Code>{b.example}</Code>}</div>)}
                  </div>
                ))}
              </>}
            </div>
          );
        })}
      </>
    );
  } else if (page.kind === 'type') {
    const t = types.get(page.name)!;
    body = (
      <>
        {back}
        <div className="mt-2.5 flex items-center gap-2"><span className="font-mono text-[14px] font-bold select-text">{t.name}</span><span className="font-mono text-[11.5px] text-content-faint">{t.type}</span>
          {t.at && <button title="Show in code" className="ml-auto w-6 h-6 rounded flex items-center justify-center text-content-faint hover:bg-surface-3 hover:text-content" onClick={() => onOpenAt(t.at!)}><Icons.Braces size={13} /></button>}</div>
        <div className="mt-1.5"><Text>{t.description}</Text></div>
        {!!t.enum?.length && <><H>Values</H><div className="flex flex-wrap gap-1">{t.enum.map((v) => <span key={v} className="font-mono text-[11.5px] px-1.5 rounded bg-surface-2 border border-line-subtle">{v}</span>)}</div></>}
        {!!t.properties?.length && <>
          <H>Properties</H>
          {t.properties.map((p) => (
            <div key={p.name} className="py-1">
              <div className="flex items-center gap-1.5 flex-wrap"><span className="font-mono text-[12px] font-semibold">{p.name}</span>{typeLink(p.type)}{p.required && <span className="text-[10.5px] text-content-faint">required</span>}</div>
              {p.description && <div className="text-[11.5px] text-content-faint">{p.description}</div>}
            </div>
          ))}
        </>}
        {t.example && <><H>Example</H><Code>{t.example}</Code></>}
        {t.usedBy.length > 0 && <>
          <H>Used by</H>
          {t.usedBy.slice(0, 40).map((u, i) => {
            const m = u.where.match(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) (\S+)/);
            return <div key={i} className="py-0.5 text-[12px]">{m ? <button className="flex items-center gap-1.5 hover:underline" onClick={() => setPage({ kind: 'res', path: m[2] })}><Badge m={m[1].toLowerCase()} /><span className="font-mono text-[11.5px]">{m[2]}</span></button> : <span className="font-mono text-[11.5px] text-content-secondary">{u.where}</span>}</div>;
          })}
        </>}
      </>
    );
  } else {
    body = (
      <>
        <div className="text-[15px] font-bold select-text">{model.title?.v || 'Untitled API'}</div>
        <div className="mt-0.5 text-[12px] text-content-faint select-text">{[model.version?.v, model.baseUri?.v].filter(Boolean).join(' · ')}</div>
        <div className="mt-2"><Text>{model.description?.v}</Text></div>
        {model.docs?.map((d) => (
          <details key={d.title} className="mt-2"><summary className="cursor-pointer text-[12.5px] font-semibold">{d.title}</summary><div className="mt-1"><Text>{d.content}</Text></div></details>
        ))}
        <H>Resources</H>
        {(model.endpoints ?? []).filter((e) => e.operations.length).map((e) => (
          <button key={e.path} onClick={() => setPage({ kind: 'res', path: e.path })} className="w-full flex items-center gap-2 py-1 px-1.5 -mx-1.5 rounded-md text-left hover:bg-[var(--hover-overlay)]">
            <span className="font-mono text-[11.5px] min-w-0 truncate">{e.path}</span>
            <span className="ml-auto flex gap-0.5 shrink-0">{e.operations.map((o) => <Badge key={o.method} m={o.method} />)}</span>
          </button>
        ))}
        {model.types.length > 0 && <>
          <H>Types</H>
          <div className="flex flex-wrap gap-x-3 gap-y-1">{[...types.keys()].sort().map((n) => <button key={n} className="font-mono text-[11.5px] text-accent hover:underline" onClick={() => setPage({ kind: 'type', name: n })}>{n}</button>)}</div>
        </>}
      </>
    );
  }
  return <div className="flex-1 overflow-auto px-3.5 pt-3.5 pb-8 select-none">{body}</div>;
}

// Try it: a request to the local mock, filled in from the spec.
function TryIt({ op, path, mock }: { op: Op; path: string; mock: Mock }) {
  const [vals, setVals] = useState<Record<string, string>>(() => Object.fromEntries(op.parameters.map((p) => [p.in + ':' + p.name, p.example?.trim().replace(/^["']|["']$/g, '') ?? ''])));
  const [body, setBody] = useState(op.body[0]?.example ?? '');
  const [status, setStatus] = useState(op.responses.find((r) => /^2/.test(r.code))?.code ?? '');
  const [res, setRes] = useState<{ status: number; ms: number; text: string } | { error: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setRes(null); }, [op]);
  if (!mock) return <div className="mt-2 text-[12px] text-content-faint">Starting the mock…</div>;
  const url = () => {
    let p = path;
    for (const x of op.parameters.filter((x) => x.in === 'path')) p = p.replace(`{${x.name}}`, encodeURIComponent(vals['path:' + x.name] || x.name));
    const q = op.parameters.filter((x) => x.in === 'query' && vals['query:' + x.name]).map((x) => `${encodeURIComponent(x.name)}=${encodeURIComponent(vals['query:' + x.name])}`).join('&');
    return `http://127.0.0.1:${mock.port}${p}${q ? '?' + q : ''}`;
  };
  const send = async () => {
    setBusy(true); setRes(null);
    const headers: Record<string, string> = {};
    for (const x of op.parameters.filter((x) => x.in === 'header' && vals['header:' + x.name])) headers[x.name] = vals['header:' + x.name];
    if (status) headers['MS2-Status-Code'] = status;
    const media = op.body[0]?.media || 'application/json';
    if (body.trim()) headers['Content-Type'] = media;
    const t0 = performance.now();
    try {
      const r = await fetch(url(), { method: op.method.toUpperCase(), headers, body: body.trim() && !['get', 'head'].includes(op.method) ? body : undefined });
      setRes({ status: r.status, ms: Math.round(performance.now() - t0), text: await r.text() });
    } catch (e) { setRes({ error: String(e) }); }
    setBusy(false);
  };
  const inp = 'flex-1 min-w-0 h-[26px] px-2 rounded-md border border-line bg-surface-input font-mono text-[11.5px] outline-none focus:border-accent';
  return (
    <div className="mt-2.5 p-2.5 rounded-lg border border-accent-border bg-[color-mix(in_oklch,var(--accent)_5%,transparent)] flex flex-col gap-1.5">
      {op.parameters.map((p) => (
        <label key={p.in + p.name} className="flex items-center gap-2"><span className="w-[92px] shrink-0 text-[11px] text-content-faint truncate" title={`${p.in} ${p.name}`}>{p.name}{p.required ? ' *' : ''}</span>
          <input value={vals[p.in + ':' + p.name] ?? ''} onChange={(e) => setVals({ ...vals, [p.in + ':' + p.name]: e.target.value })} placeholder={p.type} spellCheck={false} className={inp} /></label>
      ))}
      {op.body.length > 0 && <textarea value={body} onChange={(e) => setBody(e.target.value)} spellCheck={false} rows={5} placeholder="Request body"
        className="w-full p-2 rounded-md border border-line bg-surface-input font-mono text-[11.5px] outline-none focus:border-accent resize-y" />}
      <div className="flex items-center gap-2">
        {op.responses.length > 1 && <select value={status} onChange={(e) => setStatus(e.target.value)} title="Which response the mock gives (MS2-Status-Code)" className="h-[26px] px-1 rounded-md border border-line bg-surface-input text-[11.5px]">
          <option value="">First success</option>{op.responses.map((r) => <option key={r.code} value={r.code}>{r.code}</option>)}</select>}
        <span className="flex-1" />
        <button disabled={busy} onClick={send} className="h-[26px] px-3 rounded-md text-[12px] font-semibold bg-accent text-accent-ink hover:bg-accent-hover disabled:opacity-50">{busy ? 'Sending…' : 'Send'}</button>
      </div>
      <div className="font-mono text-[10.5px] text-content-faint break-all select-text">{op.method.toUpperCase()} {url()}</div>
      {res && ('error' in res ? <div className="text-[12px] text-err select-text">{res.error}</div> : <>
        <div className="flex items-center gap-2 text-[11.5px]"><span className="font-mono font-bold" style={{ color: codeColor(String(res.status)) }}>{res.status}</span><span className="text-content-faint">{res.ms} ms</span></div>
        {res.text && <Code>{(() => { try { return JSON.stringify(JSON.parse(res.text), null, 2); } catch { return res.text; } })()}</Code>}
      </>)}
    </div>
  );
}
