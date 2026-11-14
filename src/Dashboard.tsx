// The Dashboard (PLAN 6.2): one organization's APIs at a glance, for the people who answer for them. Overview is
// the estate in numbers (how much is governed, what conforms, what's running, what needs someone); APIs and assets
// is the working table (who published what, each API's endpoints, what changed, its conformance report);
// Deployments is what runs where; Health checks the URLs you choose; Activity is every publish. It only reads,
// and each part shows what this account may see: a missing permission is said where it applies, not an error.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import { Icons } from './components/Icons';
import { Select } from './components/Popup';
import { WindowControls } from './components/WindowControls';
import { Spinner, btn, btnPrimary } from './App';
import type { Me } from './SyncUI';
import * as D from './dashdata';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// Recent things by how long ago, older ones by their date.
function when(t: number, now = Date.now()) {
  if (!t) return '';
  const d = Math.floor((now - t) / D.DAY);
  if (d < 1) return 'Today'; if (d === 1) return 'Yesterday'; if (d < 30) return `${d} days ago`;
  const x = new Date(t); return `${x.getDate()} ${MONTHS[x.getMonth()]} ${x.getFullYear()}`;
}
const pct = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : '0%');
const GOV_TONE: Record<D.Gov, string> = { conformant: 'text-ok', failing: 'text-err', validating: 'text-content-muted', none: 'text-content-faint' };
const GOV_ORDER: D.Gov[] = ['failing', 'validating', 'conformant', 'none'];
const METHOD_TONE: Record<string, string> = { GET: 'text-cyan', POST: 'text-ok', PUT: 'text-warn', PATCH: 'text-violet', DELETE: 'text-err' };
const dot = (tone: 'ok' | 'err' | 'faint' | 'warn') => <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${tone === 'ok' ? 'bg-ok' : tone === 'err' ? 'bg-err' : tone === 'warn' ? 'bg-warn' : 'bg-content-ghost'}`} />;

function GovMark({ a, long }: { a: D.Api; long?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap ${GOV_TONE[a.gov]}`}>
      {dot(a.gov === 'conformant' ? 'ok' : a.gov === 'failing' ? 'err' : 'faint')}
      {D.GOV_LABEL[a.gov]}{a.gov === 'failing' && <span className="text-content-faint">{long ? `: ${a.fail} of ${a.rulesets} rulesets fail` : `${a.fail} of ${a.rulesets}`}</span>}
    </span>
  );
}

// A part this account can't read: said in place, plainly, with who can change it.
function NoAccess({ r, s, what }: { r: D.Reading; s: D.Section; what: string }) {
  const a = r.access[s];
  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-2 px-6 text-center">
      <div className="text-[14px] font-semibold">{a === 'denied' ? `No access to ${D.SECTION_LABEL[s]}` : a === 'off' ? `${D.SECTION_LABEL[s]} isn't part of this subscription` : `${D.SECTION_LABEL[s]} couldn't be read`}</div>
      <p className="m-0 max-w-[480px] text-[12.5px] text-content-muted leading-relaxed">
        {a === 'denied' ? <>Your Anypoint account doesn't have permission to read {what} in {r.org.name}. An organization administrator can grant it in Access Management. Everything else on the dashboard still works.</>
          : a === 'off' ? <>The organization's subscription doesn't include it, so there's nothing to show.</>
          : <>{r.why[s]} Refresh to try again.</>}
      </p>
    </div>
  );
}

type Tab = 'overview' | 'apis' | 'deployments' | 'health' | 'activity';
export function DashboardScreen({ onClose, onConnect }: { onClose: () => void; onConnect: () => void }) {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [orgs, setOrgs] = useState<{ id: string; name: string }[]>([]);
  const [org, setOrg] = useState<{ id: string; name: string } | null>(null);
  const [reading, setReading] = useState<D.Reading | null>(null);
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [tick, setTick] = useState(0); // background work landing: publishers, endpoint counts
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<'api' | 'fragment' | 'other' | 'all'>('api');
  const [gov, setGov] = useState<D.Gov | 'all'>('all');
  const [sort, setSort] = useState<{ col: string; asc: boolean }>({ col: 'gov', asc: true });
  const [open, setOpen] = useState<D.Api | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const run = useRef(0);

  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key !== 'Escape' || e.defaultPrevented) return; if (open) setOpen(null); else onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [open, onClose]);

  // Who's signed in, and their business groups. Signing in while the screen is open carries on from here.
  useEffect(() => {
    const f = () => invoke<Me | null>('anypoint_status').then(async (m) => {
      setMe(m); if (!m) return;
      const list = await D.groups().catch(() => []);
      setOrgs(list.length ? list : [{ id: m.org_id, name: m.org_name }]);
      setOrg((o) => o ?? { id: m.org_id, name: list.find((g) => g.id === m.org_id)?.name ?? m.org_name });
    }, () => setMe(null));
    f();
    window.addEventListener('ads-signed-in', f);
    return () => window.removeEventListener('ads-signed-in', f);
  }, []);

  async function load(o: { id: string; name: string }) {
    const mine = ++run.current;
    setError(null); setOpen(null); setStep('Reading…');
    try {
      const r = await D.read(o, (s) => { if (mine === run.current) setStep(s); });
      if (mine !== run.current) return;
      setReading(r); setStep(null);
      const alive = () => mine === run.current, bump = () => { if (alive()) setTick((n) => n + 1); };
      await D.details(r.apis, bump, alive);
      if (r.access.exchange === 'ok') D.countAll(r.apis, bump, alive);
    } catch (e) { if (mine === run.current) { setError(String(e).replace(/^Error: /, '')); setStep(null); } }
  }
  useEffect(() => { if (org) load(org); return () => { run.current++; }; }, [org?.id]);

  const s = useMemo(() => (reading ? D.summary(reading) : null), [reading, tick]);
  const govOn = reading?.governance === 'on';
  const rows = useMemo(() => {
    if (!reading) return [];
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const list = reading.apis.filter((a) => (kind === 'all' || a.kind === kind) && (gov === 'all' || a.gov === gov)
      && words.every((w) => `${a.name} ${a.assetId} ${a.by} ${a.version} ${D.kindLabel(a.type)}`.toLowerCase().includes(w)));
    const val = (a: D.Api): string | number => ({ name: a.name.toLowerCase(), kind: D.kindLabel(a.type), version: a.version, published: a.published, by: a.by.toLowerCase() || '~',
      gov: govOn ? GOV_ORDER.indexOf(a.gov) * 1000 - a.fail : a.name.toLowerCase(), endpoints: -(a.counts?.operations ?? -1), managed: -a.managed.length } as Record<string, string | number>)[sort.col] ?? 0;
    return list.sort((a, b) => { const x = val(a), y = val(b); return (x < y ? -1 : x > y ? 1 : a.name.localeCompare(b.name)) * (sort.asc ? 1 : -1); });
  }, [reading, q, kind, gov, sort, tick, govOn]);

  async function exportCsv(name: string, text: string, n: number) {
    if (!reading) return;
    const dest = await saveDialog({ title: 'Export the list', defaultPath: `${reading.org.name.replace(/[^\w.-]+/g, '-')}-${name}.csv`, filters: [{ name: 'CSV', extensions: ['csv'] }] });
    if (typeof dest !== 'string') return;
    const p = dest.replace(/\\/g, '/'), cut = p.lastIndexOf('/');
    try { await invoke('write_file_exact', { root: p.slice(0, cut), path: p.slice(cut + 1), text }); setNote(`Exported ${n} ${n === 1 ? 'row' : 'rows'} to ${p.slice(cut + 1)}.`); }
    catch (e) { setNote(String(e)); }
    setTimeout(() => setNote(null), 6000);
  }
  // From an overview tile or list to the table, already filtered.
  const show = (g: D.Gov | 'all', k: typeof kind = 'api') => { setGov(g); setKind(k); setQ(''); setOpen(null); setTab('apis'); };
  const openApi = (a: D.Api) => { setTab('apis'); setKind(a.kind); setGov('all'); setQ(''); setOpen(a); };

  const chip = (on: boolean, label: ReactNode, pick: () => void, key?: string) => (
    <button key={key} onClick={pick} aria-pressed={on} className={`h-6 px-2.5 rounded-md text-[12px] whitespace-nowrap ${on ? 'bg-surface-3 text-content font-medium' : 'text-content-muted hover:text-content'}`}>{label}</button>
  );
  const missing = reading ? (Object.keys(reading.access) as D.Section[]).filter((k) => reading.access[k] === 'denied') : [];

  return (
    <div className="fixed inset-0 z-[80] flex flex-col bg-bg text-content">
      <header data-tauri-drag-region className="h-11 shrink-0 flex items-center gap-3 pl-3 bg-surface border-b border-line">
        <button onClick={onClose} title="Back (Esc)" className="h-7 pl-1.5 pr-2.5 flex items-center gap-1 rounded-md text-[12px] text-content-muted hover:bg-surface-2 hover:text-content"><Icons.ArrowLeft size={14} />Back</button>
        <span className="w-px h-4 bg-line" />
        <span className="text-accent flex"><Icons.Activity size={15} /></span>
        <span data-tauri-drag-region className="text-[13px] font-semibold">Dashboard</span>
        {org && (orgs.length > 1
          ? <Select value={org.id} onChange={(id) => { const o = orgs.find((x) => x.id === id); if (o) setOrg(o); }} className="h-7 min-w-[180px]" options={orgs.map((o) => ({ value: o.id, label: o.name }))} />
          : <span data-tauri-drag-region className="text-[12px] text-content-muted">{org.name}</span>)}
        <span data-tauri-drag-region className="flex-1 h-full" />
        {step && <span className="flex items-center gap-2 text-[12px] text-content-faint"><Spinner />{step}</span>}
        {reading && !step && <span className="text-[12px] text-content-faint" title={new Date(reading.at).toLocaleString()}>Read at {new Date(reading.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>}
        {org && <button className={btn} disabled={!!step} onClick={() => load(org)} title="Read everything again from Anypoint">Refresh</button>}
        <WindowControls />
      </header>

      {me === undefined ? <div className="flex-1 flex items-center justify-center text-content-faint text-[12.5px] gap-2"><Spinner />Checking the sign-in…</div>
        : !me ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-6">
            <div className="text-[15px] font-semibold">Your organization's APIs, in one place</div>
            <p className="m-0 max-w-[460px] text-[12.5px] text-content-muted leading-relaxed">Every API in Exchange, who published it and when, whether API Governance covers it and whether it conforms, and what runs in each environment. Sign in to Anypoint to read it. The dashboard only reads: it never changes anything in your organization.</p>
            <button className={btnPrimary} onClick={onConnect}>Sign in to Anypoint…</button>
          </div>
        ) : error ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 text-[12.5px]">
            <span className="text-err select-text max-w-[560px] text-center">{error}</span>
            {org && <button className={btn} onClick={() => load(org)}>Try again</button>}
          </div>
        ) : !reading || !s ? <div className="flex-1 flex items-center justify-center text-content-faint text-[12.5px] gap-2"><Spinner />{step ?? 'Reading…'}</div>
        : <>
          <div className="h-10 shrink-0 flex items-center gap-1 px-4 border-b border-line bg-surface">
            {([['overview', 'Overview'], ['apis', 'APIs and assets'], ['deployments', 'Deployments'], ['health', 'Health'], ['activity', 'Activity']] as const).map(([id, label]) => (
              <button key={id} onClick={() => setTab(id)} aria-pressed={tab === id}
                className={`relative h-10 px-3 text-[12.5px] ${tab === id ? 'text-content font-semibold' : 'text-content-muted hover:text-content'}`}>
                {label}
                {id === 'apis' && reading.access.exchange === 'ok' && <span className="ml-1.5 text-[11px] font-normal text-content-faint">{reading.apis.length}</span>}
                {id === 'deployments' && reading.access.runtime === 'ok' && reading.apps.length > 0 && <span className="ml-1.5 text-[11px] font-normal text-content-faint">{reading.apps.length}</span>}
                {tab === id && <span className="absolute left-2 right-2 bottom-0 h-0.5 bg-accent rounded-sm" />}
              </button>
            ))}
            <span className="flex-1" />
            {note && <span className="text-[12px] text-content-muted select-text">{note}</span>}
            {tab === 'apis' && reading.apis.length > 0 && <button className={btn} onClick={() => exportCsv('apis', D.csv(rows), rows.length)} title="The rows as they're filtered and sorted now, as a CSV file">Export CSV…</button>}
            {tab === 'deployments' && reading.apps.length > 0 && <button className={btn} onClick={() => exportCsv('apps', D.csvApps(reading.apps), reading.apps.length)} title="Every app in every environment, as a CSV file">Export CSV…</button>}
          </div>
          {(missing.length > 0 || reading.notes.length > 0) && (
            <div className="shrink-0 px-4 py-1.5 border-b border-line-subtle bg-[color-mix(in_oklch,var(--warn)_9%,transparent)] text-[12px] text-content-secondary select-text">
              {missing.length > 0 && <>This account can't read {missing.map((k) => D.SECTION_LABEL[k]).join(', ').replace(/, ([^,]*)$/, ' or $1')} in {reading.org.name}, so {missing.length === 1 ? 'that part is' : 'those parts are'} left out. </>}
              {reading.notes.join(' ')}
            </div>
          )}

          {tab === 'overview' && <Overview r={reading} s={s} show={show} onOpen={openApi} onTab={setTab} />}

          {tab === 'apis' && (reading.access.exchange !== 'ok' && !reading.apis.length ? <NoAccess r={reading} s="exchange" what="Exchange's assets" /> : (
            <div className="flex-1 min-h-0 flex">
              <div className="flex-1 min-w-0 flex flex-col">
                {reading.access.exchange !== 'ok' && <div className="shrink-0 px-4 py-1.5 border-b border-line-subtle text-[12px] text-content-muted">Without access to Exchange, these are the APIs API Governance checks. Versions and endpoints need Exchange.</div>}
                <div className="shrink-0 flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-2 border-b border-line-subtle">
                  <label className="flex items-center gap-1.5 h-7 w-[240px] px-2 rounded-md bg-surface-2 border border-line text-content-faint focus-within:border-accent-border">
                    <Icons.Search size={12} />
                    <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by name, version or person" aria-label="Filter" spellCheck={false} className="flex-1 min-w-0 bg-transparent outline-none text-[12px] text-content" />
                    {q && <button aria-label="Clear" onClick={() => setQ('')} className="flex hover:text-content"><Icons.X size={11} /></button>}
                  </label>
                  <span className="flex items-center gap-0.5 p-0.5 rounded-lg bg-surface-2 border border-line">
                    {chip(kind === 'api', <>APIs <span className="text-content-faint">{s.apis}</span></>, () => setKind('api'))}
                    {chip(kind === 'fragment', <>Fragments <span className="text-content-faint">{s.fragments}</span></>, () => setKind('fragment'))}
                    {s.others > 0 && chip(kind === 'other', <>Other <span className="text-content-faint">{s.others}</span></>, () => setKind('other'))}
                    {chip(kind === 'all', 'Everything', () => setKind('all'))}
                  </span>
                  {govOn && <span className="flex items-center gap-0.5 p-0.5 rounded-lg bg-surface-2 border border-line">
                    {chip(gov === 'all', 'Any governance', () => setGov('all'))}
                    {GOV_ORDER.map((g) => chip(gov === g, D.GOV_LABEL[g], () => setGov(g), g))}
                  </span>}
                  <span className="ml-auto text-[12px] text-content-faint">{rows.length} shown</span>
                </div>
                <div className="flex-1 min-h-0 overflow-auto">
                  <table className="w-full text-[12.5px] border-separate border-spacing-0">
                    <thead>
                      <tr>{([['name', 'Name'], ['kind', 'Kind'], ['version', 'Latest version'], ['published', 'Last published'], ['by', 'Published by'],
                        ...(kind !== 'fragment' && reading.access.exchange === 'ok' ? [['endpoints', 'Endpoints']] : []), ...(govOn ? [['gov', 'Governance']] : []), ...(reading.access.apimanager === 'ok' ? [['managed', 'Managed in']] : [])] as [string, string][]).map(([col, label]) => (
                        <th key={col} className="sticky top-0 z-10 h-8 px-3 text-left font-medium text-[11.5px] text-content-faint bg-bg border-b border-line whitespace-nowrap">
                          <button onClick={() => setSort({ col, asc: sort.col === col ? !sort.asc : col !== 'published' })} className={`inline-flex items-center gap-1 hover:text-content ${sort.col === col ? 'text-content-secondary' : ''}`}>
                            {label}{sort.col === col && <span className={`flex ${sort.asc ? 'rotate-180' : ''}`}><Icons.ChevronDown size={10} /></span>}
                          </button>
                        </th>
                      ))}</tr>
                    </thead>
                    <tbody>
                      {rows.map((a) => (
                        <tr key={`${a.groupId}/${a.assetId}`} onClick={() => setOpen(open === a ? null : a)} className={`cursor-pointer ${open === a ? 'bg-accent-dim' : 'hover:bg-[var(--hover-overlay)]'}`}>
                          <td className="h-8 px-3 border-b border-line-subtle max-w-[320px]"><span className="block truncate font-medium text-content" title={a.assetId}>{a.name}</span></td>
                          <td className="px-3 border-b border-line-subtle text-content-muted whitespace-nowrap">{D.kindLabel(a.type)}</td>
                          <td className="px-3 border-b border-line-subtle whitespace-nowrap"><span className="font-mono text-[12px]">{a.version}</span>{!a.stable && <span className="ml-2 text-[10.5px] px-1.5 py-px rounded border border-line text-content-muted">Development</span>}</td>
                          <td className="px-3 border-b border-line-subtle text-content-muted whitespace-nowrap" title={a.published ? new Date(a.published).toLocaleString() : ''}>{when(a.published, reading.at)}</td>
                          <td className="px-3 border-b border-line-subtle text-content-muted whitespace-nowrap max-w-[200px] truncate">{a.by || (a.versions ? '' : <span className="text-content-ghost">…</span>)}</td>
                          {kind !== 'fragment' && reading.access.exchange === 'ok' && <td className="px-3 border-b border-line-subtle text-content-muted whitespace-nowrap">
                            {a.kind !== 'api' ? '' : a.counts === undefined ? <span className="text-content-ghost">…</span> : a.counts === null ? <span className="text-content-ghost" title="The published spec couldn't be read">?</span>
                              : <span title={Object.entries(a.counts.methods).map(([m, n]) => `${n} ${m}`).join(', ')}>{a.counts.endpoints} <span className="text-content-faint">· {a.counts.operations} ops</span></span>}</td>}
                          {govOn && <td className="px-3 border-b border-line-subtle"><GovMark a={a} /></td>}
                          {reading.access.apimanager === 'ok' && <td className="px-3 border-b border-line-subtle text-content-muted whitespace-nowrap">{a.managed.length ? [...new Set(a.managed.map((m) => m.env))].join(', ') : <span className="text-content-ghost">Not managed</span>}</td>}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {rows.length === 0 && <div className="p-6 text-center text-[12.5px] text-content-faint">{reading.apis.length ? 'Nothing matches these filters.' : "Exchange shows nothing for this account. If you expect APIs here, the account may lack the Exchange Viewer permission; Exchange doesn't say which."}</div>}
                </div>
              </div>
              {open && <Detail key={`${open.groupId}/${open.assetId}`} a={open} r={reading} host={me.host} onClose={() => setOpen(null)} />}
            </div>
          ))}

          {tab === 'deployments' && <Deployments r={reading} onOpen={openApi} />}
          {tab === 'health' && <Health r={reading} />}
          {tab === 'activity' && (reading.access.exchange !== 'ok' ? <NoAccess r={reading} s="exchange" what="what's been published in Exchange" /> : <Activity r={reading} onOpen={openApi} />)}
        </>}
    </div>
  );
}

// ---------- Overview: the estate in numbers, then what needs someone ----------
function Overview({ r, s, show, onOpen, onTab }: { r: D.Reading; s: ReturnType<typeof D.summary>; show: (g: D.Gov | 'all', k?: 'api' | 'fragment' | 'other' | 'all') => void; onOpen: (a: D.Api) => void; onTab: (t: Tab) => void }) {
  const apis = r.apis.filter((a) => a.kind === 'api');
  const failing = apis.filter((a) => a.gov === 'failing').sort((a, b) => b.fail / (b.rulesets || 1) - a.fail / (a.rulesets || 1) || a.name.localeCompare(b.name));
  const uncovered = apis.filter((a) => a.gov === 'none');
  const ex = r.access.exchange === 'ok', govOn = r.governance === 'on', rt = r.access.runtime === 'ok', mgr = r.access.apimanager === 'ok';
  const people = useMemo(() => {
    const m = new Map<string, { name: string; apis: number; failing: number; last: number }>();
    for (const a of apis) { const k = a.by || 'Not known yet'; const p = m.get(k) ?? { name: k, apis: 0, failing: 0, last: 0 }; p.apis++; if (a.gov === 'failing') p.failing++; p.last = Math.max(p.last, a.published); m.set(k, p); }
    return [...m.values()].sort((a, b) => b.failing - a.failing || b.apis - a.apis);
  }, [r, apis.map((a) => a.by).join('|')]);
  const trend = D.history(r.org.id).filter((p) => p.governed > 0);
  const tile = (label: string, value: ReactNode, sub: ReactNode, tone = '', go?: () => void) => (
    <button key={label} onClick={go} disabled={!go} className={`text-left p-3.5 rounded-lg border border-line bg-surface ${go ? 'hover:border-accent-border cursor-pointer' : 'cursor-default'}`}>
      <div className="text-[11.5px] text-content-muted">{label}</div>
      <div className={`mt-1 text-[24px] leading-none font-semibold tabular-nums ${tone}`}>{value}</div>
      <div className="mt-1.5 text-[11.5px] text-content-faint min-h-[16px]">{sub}</div>
    </button>
  );
  const card = 'rounded-lg border border-line bg-surface';
  const head = 'h-9 flex items-center px-3.5 border-b border-line-subtle text-[12.5px] font-semibold';
  const prodDown = r.apps.filter((a) => a.production && a.health === 'down');
  const govRead = r.access.governance === 'ok' || r.access.governance === 'off';
  // Nothing the dashboard shows is readable: one page that says what it needs, instead of empty cards.
  if (!ex && !govRead && !rt && !mgr) return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="text-[14px] font-semibold">This account can't read anything the dashboard shows in {r.org.name}</div>
      <p className="m-0 max-w-[520px] text-[12.5px] text-content-muted leading-relaxed">Each part needs its own Anypoint permission, which an organization administrator grants in Access Management:</p>
      <ul className="m-0 p-0 list-none text-[12.5px] text-content-secondary leading-loose">
        <li><b className="font-medium">Exchange Viewer</b> for the APIs, versions, endpoints and activity</li>
        <li><b className="font-medium">Governance Viewer</b> for API Governance and conformance</li>
        <li><b className="font-medium">View APIs Configuration</b> (API Manager) for what's managed where</li>
        <li><b className="font-medium">Read Applications</b> (Runtime Manager) for what's deployed, and Health</li>
      </ul>
      <p className="m-0 text-[12px] text-content-faint">The design side of Design Studio works without any of them.</p>
    </div>
  );
  return (
    <div className="flex-1 min-h-0 overflow-auto">
      <div className="max-w-[1180px] mx-auto px-6 py-5 flex flex-col gap-4">
        {/* Governance in words first: the numbers under it mean nothing without knowing which of these it is. */}
        <div className={`${card} px-4 py-3 flex items-center gap-3 text-[12.5px]`}>
          {dot(govOn ? 'ok' : r.access.governance === 'ok' || r.access.governance === 'off' ? 'faint' : 'warn')}
          <span className="text-content-secondary leading-relaxed">
            {govOn && <><b className="text-content">API Governance is on.</b> {r.profiles.filter((p) => p.live).length === 1 ? 'One active profile checks' : `${r.profiles.filter((p) => p.live).length} active profiles check`} {s.governed}{ex ? ` of ${s.apis}` : ''} APIs{ex ? ` (${pct(s.governed, s.apis)})` : ''}{s.governed ? <>, and {s.conformant} of those conform ({pct(s.conformant, s.governed)}).</> : '.'}{r.limit != null && s.governed >= r.limit && <> The subscription covers {r.limit} governed APIs, so it's at its limit.</>}</>}
            {r.governance === 'empty' && <><b className="text-content">API Governance is available, but nothing is checked yet.</b> The organization has it{r.profiles.length ? ', with draft profiles only' : ' and no profile'}. An active profile in API Governance starts checking APIs against its rulesets.</>}
            {r.governance === 'off' && <><b className="text-content">API Governance isn't part of this organization's subscription.</b></>}
            {r.access.governance === 'denied' && <><b className="text-content">This account can't see API Governance.</b> Whether the APIs conform is left out; an administrator can grant the Governance Viewer permission.</>}
            {r.access.governance === 'error' && <><b className="text-content">Governance couldn't be read.</b> {r.why.governance} Refresh to try again.</>}
          </span>
        </div>

        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))' }}>
          {ex && tile('APIs in Exchange', s.apis, s.kinds.map(([k, n]) => `${n} ${k}`).join(' · ') || (s.fragments + s.others ? 'Only fragments and other assets' : "None this account can see. Exchange doesn't say whether that's a missing permission."), '', s.apis ? () => show('all') : undefined)}
          {govOn && ex && tile('Governed', <>{s.governed}<span className="text-[13px] font-normal text-content-faint"> of {s.apis}</span></>, `${pct(s.governed, s.apis)} of the APIs`, '', () => show('all'))}
          {govOn && tile('Conformant', s.conformant, s.governed ? `${pct(s.conformant, s.governed)} of what's governed${s.validating ? ` · ${s.validating} in validation` : ''}` : 'Nothing governed yet', 'text-ok', () => show('conformant'))}
          {govOn && tile('Not conformant', s.failing, s.failing ? [['high', r.severity.high], ['medium', r.severity.medium], ['low', r.severity.low]].filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(' · ') + ' severity' : 'Nothing fails its rulesets', s.failing ? 'text-err' : '', () => show('failing'))}
          {govOn && ex && tile('Not governed', s.apis - s.governed, 'APIs no profile covers', '', () => show('none'))}
          {rt && tile('Apps running', <>{s.appsUp}<span className="text-[13px] font-normal text-content-faint"> of {s.apps}</span></>, s.apps ? (s.appsDown.length ? `${s.appsDown.length} stopped or failed` : 'Nothing stopped or failed') : 'No apps deployed', s.appsDown.length ? 'text-err' : '', () => onTab('deployments'))}
          {rt && s.prodApps > 0 && tile('In production', s.prodApps, s.prodDown ? `${s.prodDown} stopped or failed` : 'All running', s.prodDown ? 'text-err' : '', () => onTab('deployments'))}
          {mgr && ex && tile('Managed in API Manager', <>{s.managed}<span className="text-[13px] font-normal text-content-faint"> of {s.apis}</span></>, s.apis - s.managed ? `${s.apis - s.managed} with no instance in any environment` : 'Every API has an instance', '', () => onTab('deployments'))}
          {/* An Exchange that shows nothing (often: no permission to see it) says that once, in the first tile, not as a row of zeros. */}
          {ex && s.apis > 0 && tile('Published in 30 days', s.recent, s.development ? `${s.development} still in Development` : 'All Stable')}
          {ex && s.apis > 0 && tile('Not published in a year', s.stale, s.stale ? 'Worth a look: retired, or forgotten?' : 'Nothing has gone quiet', s.stale ? 'text-warn' : '')}
          {ex && s.fragments + s.others > 0 && tile('Fragments', s.fragments, s.others ? `and ${s.others} other assets` : 'Libraries, types, traits and the like', '', () => show('all', 'fragment'))}
        </div>

        <div className="grid gap-4 items-start" style={{ gridTemplateColumns: govOn || rt ? 'minmax(0, 3fr) minmax(0, 2fr)' : 'minmax(0, 1fr)' }}>
          <div className={govOn || rt ? card : 'hidden'}>
            <div className={head}>Needs attention<span className="ml-2 text-[11.5px] font-normal text-content-faint">{prodDown.length + failing.length ? `${prodDown.length + failing.length} ${prodDown.length + failing.length === 1 ? 'item' : 'items'}` : ''}</span></div>
            {prodDown.map((a) => (
              <button key={`${a.env}/${a.name}`} onClick={() => onTab('deployments')} className="w-full flex items-center gap-3 h-9 px-3.5 border-b border-line-subtle text-left text-[12.5px] hover:bg-[var(--hover-overlay)]">
                {dot('err')}<span className="font-medium truncate">{a.name}</span><span className="text-content-faint">{a.env}</span>
                <span className="ml-auto text-err whitespace-nowrap">{a.status || 'not running'} in production</span>
              </button>
            ))}
            {failing.slice(0, 12).map((a) => (
              <button key={a.assetId} onClick={() => onOpen(a)} className="w-full flex items-center gap-3 h-9 px-3.5 border-b border-line-subtle last:border-b-0 text-left text-[12.5px] hover:bg-[var(--hover-overlay)]">
                {dot('err')}
                <span className="font-medium truncate">{a.name}</span><span className="font-mono text-[11.5px] text-content-faint">{a.version}</span>
                <span className="ml-auto text-err whitespace-nowrap">{a.fail} of {a.rulesets} rulesets fail</span>
                <span className="w-[130px] text-right text-content-muted truncate">{a.by}</span>
              </button>
            ))}
            {failing.length > 12 && <button onClick={() => show('failing')} className="w-full h-8 text-[12px] text-accent hover:underline">All {failing.length} in the table</button>}
            {govOn && ex && uncovered.length > 0 && <button onClick={() => show('none')} className="w-full flex items-center gap-3 h-9 px-3.5 border-t border-line-subtle text-left text-[12.5px] hover:bg-[var(--hover-overlay)]">
              {dot('faint')}
              <span><b className="font-medium">{uncovered.length} {uncovered.length === 1 ? 'API is' : 'APIs are'} not governed</b><span className="text-content-muted">: no active profile's filter matches {uncovered.length === 1 ? 'it' : 'them'}.</span></span>
              <span className="ml-auto text-content-faint truncate max-w-[260px]">{uncovered.slice(0, 3).map((a) => a.name).join(', ')}{uncovered.length > 3 ? '…' : ''}</span>
            </button>}
            {!failing.length && !prodDown.length && !(govOn && ex && uncovered.length) && <div className="px-3.5 py-4 text-[12.5px] text-content-faint">{govOn || rt ? 'Nothing needs attention: every governed API conforms and nothing in production is down.' : 'With API Governance or Runtime Manager readable, what fails is listed here, worst first.'}</div>}
          </div>

          <div className="flex flex-col gap-4">
            {r.profiles.length > 0 && <div className={card}>
              <div className={head}>Governance profiles</div>
              {r.profiles.map((p) => (
                <div key={p.id} className="px-3.5 py-2.5 border-b border-line-subtle last:border-b-0 text-[12.5px]">
                  <div className="flex items-center gap-2"><span className="font-medium truncate">{p.name}</span>
                    <span className={`text-[10.5px] px-1.5 py-px rounded border ${p.live ? 'border-[color-mix(in_oklch,var(--ok)_40%,transparent)] text-ok' : 'border-line text-content-muted'}`}>{p.live ? 'Active' : 'Draft'}</span>
                    <span className="ml-auto text-content-muted whitespace-nowrap">{p.total} APIs{p.live && p.total > 0 && <> · <span className="text-ok">{p.pass} conform</span>{p.fail > 0 && <> · <span className="text-err">{p.fail} don't</span></>}</>}</span></div>
                  <div className="mt-1 text-[11.5px] text-content-faint truncate" title={p.rulesets.join(', ')}>{p.rulesets.join(', ') || 'No rulesets'}</div>
                  {p.live && p.total > 0 && <div className="mt-2 h-1 rounded-full bg-surface-3 overflow-hidden flex"><span className="bg-ok" style={{ width: pct(p.pass, p.total) }} /><span className="bg-err" style={{ width: pct(p.fail, p.total) }} /></div>}
                </div>
              ))}
            </div>}
            {trend.length >= 2 && <div className={card}>
              <div className={head}>Conformance over time<span className="ml-2 text-[11.5px] font-normal text-content-faint">kept on this computer, one reading a day</span></div>
              <div className="px-3.5 py-3">
                <svg viewBox="0 0 300 60" className="w-full h-[60px]" preserveAspectRatio="none" role="img" aria-label="Share of governed APIs that conform, by day">
                  <polyline fill="none" stroke="var(--ok)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" points={trend.map((p, i) => `${(i / (trend.length - 1)) * 300},${56 - (p.conformant / p.governed) * 52}`).join(' ')} />
                </svg>
                <div className="flex justify-between text-[11px] text-content-faint"><span>{trend[0].d}: {pct(trend[0].conformant, trend[0].governed)}</span><span>{trend[trend.length - 1].d}: {pct(trend[trend.length - 1].conformant, trend[trend.length - 1].governed)}</span></div>
              </div>
            </div>}
            {(rt || mgr) && r.environments.filter((e) => e.type !== 'design').length > 0 && <div className={card}>
              <div className={head}>Environments</div>
              {r.environments.filter((e) => e.type !== 'design').map((e) => {
                const apps = r.apps.filter((a) => a.env === e.name), inst = r.instances.filter((i) => i.env === e.name), down = apps.filter((a) => a.health === 'down').length;
                return (
                  <button key={e.id} onClick={() => onTab('deployments')} className="w-full flex items-center gap-3 h-8 px-3.5 border-b border-line-subtle last:border-b-0 text-left text-[12.5px] hover:bg-[var(--hover-overlay)]">
                    <span className="font-medium">{e.name}</span>{e.production && <span className="text-[10.5px] px-1.5 py-px rounded border border-line text-content-muted">Production</span>}
                    <span className="ml-auto text-content-muted whitespace-nowrap">{rt ? `${apps.length} ${apps.length === 1 ? 'app' : 'apps'}` : ''}{rt && mgr ? ' · ' : ''}{mgr ? `${inst.length} API ${inst.length === 1 ? 'instance' : 'instances'}` : ''}</span>
                    {down > 0 && <span className="text-err whitespace-nowrap">{down} down</span>}
                  </button>
                );
              })}
            </div>}
            {ex && <div className={card}>
              <div className={head}>By publisher</div>
              {people.slice(0, 10).map((p) => (
                <div key={p.name} className="flex items-center gap-3 h-8 px-3.5 border-b border-line-subtle last:border-b-0 text-[12.5px]">
                  <span className="truncate">{p.name}</span>
                  <span className="ml-auto text-content-muted whitespace-nowrap">{p.apis} {p.apis === 1 ? 'API' : 'APIs'}</span>
                  {govOn && <span className={`w-[110px] text-right whitespace-nowrap ${p.failing ? 'text-err' : 'text-content-faint'}`}>{p.failing ? `${p.failing} not conformant` : 'none failing'}</span>}
                  <span className="w-[86px] text-right text-content-faint whitespace-nowrap">{when(p.last, r.at)}</span>
                </div>
              ))}
              {!people.length && <div className="px-3.5 py-3 text-[12.5px] text-content-faint">No APIs yet.</div>}
            </div>}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- One API, beside the table: endpoints, what changed, governance, where it's managed, every version ----------
function Detail({ a, r, host, onClose }: { a: D.Api; r: D.Reading; host: string; onClose: () => void }) {
  const [rep, setRep] = useState<D.Report | null | string>(null);
  const [spec, setSpec] = useState<{ counts: D.Counts; endpoints: { path: string; methods: string[] }[] } | null | string>(null);
  const vs = a.versions ?? [];
  const [to, setTo] = useState(a.version);
  const [from, setFrom] = useState(() => vs.find((v) => v.version !== a.version)?.version ?? '');
  const [diff, setDiff] = useState<Awaited<ReturnType<typeof D.changes>> | null | string>(null);
  const govOn = r.governance === 'on';
  useEffect(() => { if (a.urn && govOn) D.report(a.urn).then(setRep, (e) => setRep(String(e).replace(/^Error: /, ''))); }, [a.urn]);
  useEffect(() => {
    if (a.kind !== 'api' || r.access.exchange !== 'ok') return;
    D.versionModel(a, a.version, a.stable).then(({ model }) => setSpec({ counts: D.counts(model), endpoints: (model.endpoints ?? []).filter((e) => e.operations?.length).map((e) => ({ path: e.path, methods: e.operations.map((o) => o.method.toUpperCase()) })) }),
      (e) => setSpec(String(e).replace(/^Error: /, '')));
  }, [a.assetId]);
  useEffect(() => {
    const f = vs.find((v) => v.version === from), t = vs.find((v) => v.version === to);
    if (!f || !t || f === t || a.kind !== 'api') { setDiff(null); return; }
    let live = true; setDiff(null);
    D.changes(a, f, t).then((d) => live && setDiff(d), (e) => live && setDiff(String(e).replace(/^Error: /, '')));
    return () => { live = false; };
  }, [from, to, a.assetId]);
  const label = 'px-4 pt-3.5 pb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.5px] text-content-faint';
  const pick = 'h-6 px-1.5 rounded-md border border-line bg-surface-2 font-mono text-[11.5px] text-content';
  return (
    <aside aria-label={`${a.name} details`} className="w-[420px] shrink-0 border-l border-line bg-surface flex flex-col min-h-0">
      <div className="shrink-0 px-4 py-3 border-b border-line-subtle">
        <div className="flex items-start gap-2">
          <div className="flex-1 min-w-0"><div className="text-[14px] font-semibold truncate">{a.name}</div>
            <div className="mt-0.5 text-[11.5px] text-content-faint font-mono truncate">{a.assetId}</div></div>
          <button aria-label="Close" onClick={onClose} className="w-6 h-6 rounded flex items-center justify-center text-content-faint hover:bg-surface-3 hover:text-content"><Icons.X size={13} /></button>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-content-muted">
          <span>{D.kindLabel(a.type)}</span><span className="font-mono">{a.version}</span><span>{a.stable ? 'Stable' : 'Development'}</span>
          {a.published > 0 && <span>{when(a.published, r.at)}{a.by ? ` by ${a.by}` : ''}</span>}
        </div>
        <div className="mt-2.5 flex gap-2">
          {r.access.exchange === 'ok' && <button className={btn} onClick={() => openUrl(`${host}/exchange/${a.groupId}/${a.assetId}/`)}>Open in Exchange</button>}
          {a.urn && govOn && <button className={btn} onClick={() => openUrl(`${host}/governance/#/report/${encodeURIComponent(a.urn!)}`)}>Report in API Governance</button>}
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-auto pb-4">
        {a.kind === 'api' && r.access.exchange === 'ok' && <>
          <div className={label}>Endpoints in {a.version}</div>
          {spec === null ? <div className="px-4 flex items-center gap-2 text-[12px] text-content-faint"><Spinner />Reading the published spec…</div>
            : typeof spec === 'string' ? <div className="px-4 text-[12px] text-content-muted select-text">{spec}</div>
            : <>
              <div className="px-4 flex flex-wrap gap-x-3 gap-y-1 text-[12.5px]">
                <span><b>{spec.counts.endpoints}</b> <span className="text-content-muted">resources</span></span>
                <span><b>{spec.counts.operations}</b> <span className="text-content-muted">operations</span></span>
                <span><b>{spec.counts.types}</b> <span className="text-content-muted">types</span></span>
                {Object.entries(spec.counts.methods).map(([m, n]) => <span key={m} className={`font-mono text-[11.5px] ${METHOD_TONE[m] ?? 'text-content-muted'}`}>{n} {m}</span>)}
              </div>
              <div className="mt-2 mx-4 rounded-md border border-line max-h-[220px] overflow-auto">
                {spec.endpoints.map((e) => (
                  <div key={e.path} className="flex items-center gap-2 px-2.5 h-7 border-b border-line-subtle last:border-b-0 text-[12px]">
                    <span className="font-mono truncate flex-1" title={e.path}>{e.path}</span>
                    {e.methods.map((m) => <span key={m} className={`font-mono text-[10.5px] font-bold ${METHOD_TONE[m] ?? 'text-content-muted'}`}>{m}</span>)}
                  </div>
                ))}
              </div>
            </>}
          {vs.length > 1 && <>
            <div className={label}>What changed</div>
            <div className="px-4 flex items-center gap-2 text-[12px] text-content-muted">
              From <select className={pick} value={from} onChange={(e) => setFrom(e.target.value)}>{vs.map((v) => <option key={v.version} value={v.version}>{v.version}</option>)}</select>
              to <select className={pick} value={to} onChange={(e) => setTo(e.target.value)}>{vs.map((v) => <option key={v.version} value={v.version}>{v.version}</option>)}</select>
            </div>
            <div className="px-4 pt-2 text-[12px]">
              {from === to ? <span className="text-content-faint">Pick two different versions.</span>
                : diff === null ? <span className="flex items-center gap-2 text-content-faint"><Spinner />Comparing the two published specs…</span>
                : typeof diff === 'string' ? <span className="text-content-muted select-text">{diff}</span>
                : <>
                  {diff.flagged && <div className="mb-2 px-2.5 py-1.5 rounded-md border border-err-border bg-err-tint text-err">A breaking change was published as a {diff.bump} version. Clients on {from} may break; a new major version was needed.</div>}
                  {!diff.changes.length ? <span className="text-content-faint">No changes to methods or types.</span> : diff.changes.map((c, i) => (
                    <div key={i} className="flex items-start gap-2 py-0.5">
                      <span className={`w-3 shrink-0 font-mono font-bold ${c.kind === '+' ? 'text-ok' : c.kind === '-' ? 'text-err' : 'text-warn'}`}>{c.kind}</span>
                      <span className="min-w-0"><span className="font-mono">{c.method ? `${c.method} ` : ''}{c.name}</span>{c.detail && <span className="text-content-muted">: {c.detail}</span>}{c.breaking && <span className="ml-1.5 text-[10.5px] text-err">breaking</span>}</span>
                    </div>
                  ))}
                </>}
            </div>
          </>}
        </>}

        {govOn && <div className={label}>Governance</div>}
        {govOn && <div className="px-4 text-[12.5px]"><GovMark a={a} long />{a.gov === 'none' && <div className="mt-1 text-[12px] text-content-faint">No active profile's filter matches this {a.kind === 'api' ? 'API' : 'asset'}.</div>}
          {a.govAt > D.DAY && <div className="mt-1 text-[12px] text-content-faint">Checked {when(a.govAt, r.at).toLowerCase()}.</div>}</div>}
        {govOn && a.urn && (rep === null ? <div className="px-4 pt-3 flex items-center gap-2 text-[12px] text-content-faint"><Spinner />Reading the report…</div>
          : typeof rep === 'string' ? <div className="px-4 pt-3 text-[12px] text-err select-text">{rep}</div>
          : rep.rulesets.map((x) => (
            <div key={x.name + x.version} className="mx-4 mt-3 rounded-md border border-line overflow-hidden">
              <div className="flex items-center gap-2 px-3 h-8 bg-surface-2 text-[12.5px]">
                {dot(x.status === 'Conformant' ? 'ok' : 'err')}
                <span className="font-medium truncate">{x.name}</span><span className="font-mono text-[11px] text-content-faint">{x.version}</span>
                <span className={`ml-auto whitespace-nowrap ${x.status === 'Conformant' ? 'text-ok' : 'text-err'}`}>{x.status === 'Conformant' ? 'Passed' : `${x.rules.length} ${x.rules.length === 1 ? 'rule fails' : 'rules fail'}`}</span>
              </div>
              {x.rules.map((y) => (
                <div key={y.id} className="px-3 py-2 border-t border-line-subtle text-[12px]">
                  <div className="text-content select-text">{y.message}</div>
                  <div className="mt-0.5 font-mono text-[11px] text-content-faint select-text">{y.id}</div>
                  {y.places.slice(0, 8).map((p, i) => <div key={i} className="mt-1 text-content-muted select-text">{p}</div>)}
                  {y.places.length > 8 && <div className="mt-1 text-content-faint">and {y.places.length - 8} more places</div>}
                </div>
              ))}
            </div>
          )))}
        {r.access.apimanager === 'ok' && <>
          <div className={label}>Managed in API Manager</div>
          {a.managed.length ? a.managed.map((m, i) => <div key={i} className="px-4 h-7 flex items-center gap-3 text-[12.5px]"><span>{m.env}</span><span className="font-mono text-[12px] text-content-muted">{m.version}</span><span className="ml-auto text-content-faint">{m.status}</span></div>)
            : <div className="px-4 text-[12px] text-content-faint">No instance in any environment.</div>}
        </>}
        {r.access.exchange === 'ok' && <>
          <div className={label}>Versions{a.versions ? ` (${a.versions.length})` : ''}</div>
          {!a.versions ? <div className="px-4 flex items-center gap-2 text-[12px] text-content-faint"><Spinner />Reading…</div>
            : a.versions.map((v) => (
              <div key={v.version} className="px-4 h-7 flex items-center gap-3 text-[12.5px]">
                <span className="font-mono text-[12px] w-[84px] truncate">{v.version}</span>
                <span className="text-[11px] text-content-faint w-[84px]">{v.status === 'development' ? 'Development' : v.status === 'deprecated' ? 'Deprecated' : 'Stable'}</span>
                <span className="text-content-muted truncate">{v.by}</span>
                <span className="ml-auto text-content-faint whitespace-nowrap" title={v.created ? new Date(v.created).toLocaleString() : ''}>{when(v.created, r.at)}</span>
              </div>
            ))}
        </>}
      </div>
    </aside>
  );
}

// ---------- Deployments: which version runs where, and every app in every environment ----------
function Deployments({ r, onOpen }: { r: D.Reading; onOpen: (a: D.Api) => void }) {
  const [env, setEnv] = useState('all');
  const [q, setQ] = useState('');
  if (r.access.runtime !== 'ok' && r.access.apimanager !== 'ok') return <NoAccess r={r} s="runtime" what="Runtime Manager's apps or API Manager's APIs" />;
  const envs = r.environments.filter((e) => e.type !== 'design');
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const match = (s: string) => words.every((w) => s.toLowerCase().includes(w));
  const apps = r.apps.filter((a) => (env === 'all' || a.env === env) && match(`${a.name} ${a.runtime} ${a.status}`)).sort((a, b) => (a.health === 'down' ? 0 : 1) - (b.health === 'down' ? 0 : 1) || a.name.localeCompare(b.name));
  // API Manager: one row per API, one column per environment: which version is managed there.
  const byApi = new Map<string, { name: string; groupId: string; assetId: string; cells: Map<string, D.Instance[]> }>();
  for (const i of r.instances) {
    const k = `${i.groupId}/${i.assetId}`, row = byApi.get(k) ?? { name: i.name, groupId: i.groupId, assetId: i.assetId, cells: new Map() };
    row.cells.set(i.env, [...(row.cells.get(i.env) ?? []), i]); byApi.set(k, row);
  }
  const matrix = [...byApi.values()].filter((x) => match(x.name)).sort((a, b) => a.name.localeCompare(b.name));
  const card = 'rounded-lg border border-line bg-surface';
  const th = 'sticky top-0 h-8 px-3 text-left font-medium text-[11.5px] text-content-faint bg-surface border-b border-line whitespace-nowrap';
  const td = 'h-8 px-3 border-b border-line-subtle';
  return (
    <div className="flex-1 min-h-0 overflow-auto">
      <div className="max-w-[1180px] mx-auto px-6 py-5 flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1.5 h-7 w-[240px] px-2 rounded-md bg-surface-2 border border-line text-content-faint focus-within:border-accent-border">
            <Icons.Search size={12} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by name or status" aria-label="Filter" spellCheck={false} className="flex-1 min-w-0 bg-transparent outline-none text-[12px] text-content" />
          </label>
          <span className="flex items-center gap-0.5 p-0.5 rounded-lg bg-surface-2 border border-line">
            {[{ name: 'all' }, ...envs].map((e) => (
              <button key={e.name} onClick={() => setEnv(e.name)} aria-pressed={env === e.name} className={`h-6 px-2.5 rounded-md text-[12px] ${env === e.name ? 'bg-surface-3 text-content font-medium' : 'text-content-muted hover:text-content'}`}>{e.name === 'all' ? 'Every environment' : e.name}</button>
            ))}
          </span>
        </div>

        {r.access.apimanager === 'ok' ? (
          <div className={card}>
            <div className="h-9 flex items-center px-3.5 border-b border-line-subtle text-[12.5px] font-semibold">Which version is managed where<span className="ml-2 text-[11.5px] font-normal text-content-faint">API Manager</span></div>
            {matrix.length ? (
              <div className="overflow-auto"><table className="w-full text-[12.5px] border-separate border-spacing-0">
                <thead><tr><th className={th}>API</th>{envs.map((e) => <th key={e.id} className={th}>{e.name}{e.production && <span className="ml-1.5 text-[10px] font-normal">(production)</span>}</th>)}</tr></thead>
                <tbody>{matrix.map((x) => {
                  const api = r.apis.find((a) => a.assetId === x.assetId && a.groupId === x.groupId);
                  return (
                    <tr key={x.assetId} onClick={() => api && onOpen(api)} className={api ? 'cursor-pointer hover:bg-[var(--hover-overlay)]' : ''}>
                      <td className={`${td} font-medium`}>{x.name}</td>
                      {envs.map((e) => <td key={e.id} className={td}>{(x.cells.get(e.name) ?? []).map((i) => (
                        <span key={i.id} className="inline-flex items-center gap-1.5 mr-3 whitespace-nowrap" title={`${i.label || 'Instance'} ${i.id}${i.endpoint ? ' · ' + i.endpoint : ''}`}>
                          {dot(/active/i.test(i.status) ? 'ok' : /unregistered|inactive/i.test(i.status) ? 'warn' : 'faint')}<span className="font-mono text-[12px]">{i.version}</span>{i.label && <span className="text-content-faint">{i.label}</span>}
                        </span>
                      ))}{!(x.cells.get(e.name) ?? []).length && <span className="text-content-ghost">None</span>}</td>)}
                    </tr>
                  );
                })}</tbody>
              </table></div>
            ) : <div className="px-3.5 py-4 text-[12.5px] text-content-faint">{q ? 'Nothing matches.' : 'No API is managed in API Manager in any environment yet.'}</div>}
          </div>
        ) : <div className={`${card} px-3.5 py-3 text-[12.5px] text-content-muted`}>{r.access.apimanager === 'denied' ? "This account can't read API Manager, so which version is managed where is left out." : r.why.apimanager}</div>}

        {r.access.runtime === 'ok' ? (
          <div className={card}>
            <div className="h-9 flex items-center px-3.5 border-b border-line-subtle text-[12.5px] font-semibold">Apps<span className="ml-2 text-[11.5px] font-normal text-content-faint">Runtime Manager · {apps.length} shown</span></div>
            {apps.length ? (
              <div className="overflow-auto"><table className="w-full text-[12.5px] border-separate border-spacing-0">
                <thead><tr>{['Name', 'Environment', 'Runtime', 'Status', 'Mule version', 'Last changed'].map((h) => <th key={h} className={th}>{h}</th>)}</tr></thead>
                <tbody>{apps.map((a) => (
                  <tr key={`${a.env}/${a.name}`}>
                    <td className={`${td} font-medium`}>{a.name}</td>
                    <td className={`${td} text-content-muted`}>{a.env}{a.production && <span className="ml-1.5 text-[10.5px] px-1.5 py-px rounded border border-line">Production</span>}</td>
                    <td className={`${td} text-content-muted`}>{a.runtime}</td>
                    <td className={td}><span className={`inline-flex items-center gap-1.5 ${a.health === 'up' ? 'text-ok' : a.health === 'down' ? 'text-err' : 'text-content-muted'}`}>{dot(a.health === 'up' ? 'ok' : a.health === 'down' ? 'err' : 'faint')}{a.status || 'unknown'}</span></td>
                    <td className={`${td} font-mono text-[12px] text-content-muted`}>{a.mule}</td>
                    <td className={`${td} text-content-muted`}>{when(a.updated, r.at)}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            ) : <div className="px-3.5 py-4 text-[12.5px] text-content-faint">{q || env !== 'all' ? 'Nothing matches.' : 'No apps are deployed in any environment yet.'}</div>}
          </div>
        ) : <div className={`${card} px-3.5 py-3 text-[12.5px] text-content-muted`}>{r.access.runtime === 'denied' ? "This account can't read Runtime Manager, so the apps are left out." : r.why.runtime}</div>}
      </div>
    </div>
  );
}

// ---------- Health: Anypoint's own status, and a check of the URLs you choose, only when you press Check ----------
function Health({ r }: { r: D.Reading }) {
  const [saved, setSaved] = useState<D.Saved>(() => D.savedHealth(r.org.id));
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const put = (s: D.Saved) => { setSaved(s); D.saveHealth(r.org.id, s); };
  if (r.access.runtime !== 'ok' && r.access.apimanager !== 'ok') return <NoAccess r={r} s="runtime" what="Runtime Manager's apps or API Manager's APIs" />;
  // What can be checked: every app, and every managed API instance, with the address Anypoint knows (if any).
  const items = [
    ...r.apps.map((a) => ({ key: `app:${a.env}/${a.name}`, name: a.name, env: a.env, production: a.production, what: a.runtime, status: a.status, health: a.health, url: a.url })),
    ...r.instances.map((i) => ({ key: `api:${i.env}/${i.id}`, name: `${i.name}${i.label ? ` (${i.label})` : ''}`, env: i.env, production: i.production, what: `API ${i.version}`, status: i.status, health: /active/i.test(i.status) ? 'up' as const : 'other' as const, url: i.endpoint })),
  ];
  const urlOf = (k: string, d: string) => saved[k]?.url ?? d;
  const go = async (list: typeof items) => {
    const todo = list.filter((x) => /^https?:\/\//.test(urlOf(x.key, x.url)));
    if (!todo.length) return;
    setBusy(new Set(todo.map((x) => x.key)));
    const next = { ...saved };
    await Promise.all(todo.map(async (x) => { const u = urlOf(x.key, x.url); next[x.key] = { url: u, last: await D.check(u) }; setBusy((b) => { const n = new Set(b); n.delete(x.key); return n; }); }));
    put(next);
  };
  const th = 'sticky top-0 h-8 px-3 text-left font-medium text-[11.5px] text-content-faint bg-surface border-b border-line whitespace-nowrap';
  const td = 'h-9 px-3 border-b border-line-subtle';
  return (
    <div className="flex-1 min-h-0 overflow-auto">
      <div className="max-w-[1180px] mx-auto px-6 py-5 flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <p className="m-0 flex-1 text-[12.5px] text-content-muted leading-relaxed">Anypoint's own status for each app and API, and a check of the address you give each one (a health endpoint works best). A check is one GET from this computer, only when you press Check: nothing runs on a timer. The addresses are kept on this computer.</p>
          <button className={btnPrimary} disabled={busy.size > 0 || !items.some((x) => /^https?:\/\//.test(urlOf(x.key, x.url)))} onClick={() => go(items)}>{busy.size ? 'Checking…' : 'Check all'}</button>
        </div>
        <div className="rounded-lg border border-line bg-surface overflow-auto">
          {items.length ? <table className="w-full text-[12.5px] border-separate border-spacing-0">
            <thead><tr>{['Name', 'Environment', 'Anypoint says', 'Address to check', 'Last check', ''].map((h, i) => <th key={i} className={th}>{h}</th>)}</tr></thead>
            <tbody>{items.map((x) => {
              const last = saved[x.key]?.last;
              return (
                <tr key={x.key}>
                  <td className={td}><div className="font-medium">{x.name}</div><div className="text-[11px] text-content-faint">{x.what}</div></td>
                  <td className={`${td} text-content-muted whitespace-nowrap`}>{x.env}{x.production && <span className="ml-1.5 text-[10.5px] px-1.5 py-px rounded border border-line">Production</span>}</td>
                  <td className={td}><span className={`inline-flex items-center gap-1.5 whitespace-nowrap ${x.health === 'up' ? 'text-ok' : x.health === 'down' ? 'text-err' : 'text-content-muted'}`}>{dot(x.health === 'up' ? 'ok' : x.health === 'down' ? 'err' : 'faint')}{x.status || 'unknown'}</span></td>
                  <td className={`${td} w-[38%]`}>
                    <input defaultValue={urlOf(x.key, x.url)} placeholder="https://…/health" spellCheck={false} aria-label={`Address to check for ${x.name}`}
                      onBlur={(e) => { const v = e.target.value.trim(); if (v !== urlOf(x.key, x.url)) put({ ...saved, [x.key]: { url: v } }); }}
                      className="w-full h-7 px-2 rounded-md border border-line bg-surface-input font-mono text-[11.5px] text-content outline-none focus:border-accent" />
                  </td>
                  <td className={`${td} whitespace-nowrap`}>{busy.has(x.key) ? <span className="flex items-center gap-2 text-content-faint"><Spinner />Checking</span>
                    : last ? <span className={last.ok ? 'text-ok' : 'text-err'} title={`${new Date(last.at).toLocaleString()}${last.note ? ' · ' + last.note : ''}`}>{last.ok ? 'Up' : 'Down'} · {last.code ?? 'no answer'} · {last.ms} ms<span className="ml-1.5 text-content-faint">{when(last.at)}</span></span>
                    : <span className="text-content-ghost">Not checked</span>}</td>
                  <td className={`${td} text-right`}><button className={btn} disabled={busy.has(x.key) || !/^https?:\/\//.test(urlOf(x.key, x.url))} onClick={() => go([x])}>Check</button></td>
                </tr>
              );
            })}</tbody>
          </table> : <div className="px-3.5 py-6 text-center text-[12.5px] text-content-faint">Nothing is deployed or managed yet, so there's nothing to check.</div>}
        </div>
      </div>
    </div>
  );
}

// ---------- Activity: every publish, newest first ----------
function Activity({ r, onOpen }: { r: D.Reading; onOpen: (a: D.Api) => void }) {
  const waiting = r.apis.filter((a) => !a.versions).length;
  // Every version of every asset once its record is read; until then, its latest.
  const items = r.apis.flatMap((a) => (a.versions?.length ? a.versions.map((v) => ({ a, version: v.version, by: v.by, at: v.created, dev: v.status === 'development' })) : [{ a, version: a.version, by: a.by, at: a.published, dev: !a.stable }]))
    .filter((x) => x.at).sort((x, y) => y.at - x.at).slice(0, 300);
  let day = '';
  return (
    <div className="flex-1 min-h-0 overflow-auto">
      <div className="max-w-[860px] mx-auto px-6 py-4">
        {waiting > 0 && <div className="mb-2 flex items-center gap-2 text-[12px] text-content-faint"><Spinner />Reading earlier versions of {waiting} {waiting === 1 ? 'asset' : 'assets'}…</div>}
        {items.map((x, i) => {
          const d = when(x.at, r.at), head = d !== day ? (day = d) : null;
          return (
            <div key={i}>
              {head && <div className="pt-4 pb-1 text-[11.5px] font-semibold text-content-secondary">{head}</div>}
              <button onClick={() => onOpen(x.a)} className="w-full flex items-center gap-3 h-8 px-3 rounded-md text-left text-[12.5px] hover:bg-[var(--hover-overlay)]">
                <span className="text-content-muted w-[170px] truncate">{x.by || 'Someone'}</span>
                <span className="text-content-faint">published</span>
                <span className="font-medium truncate">{x.a.name}</span>
                <span className="font-mono text-[12px] text-content-muted">{x.version}</span>
                {x.dev && <span className="text-[10.5px] px-1.5 py-px rounded border border-line text-content-muted">Development</span>}
                <span className="ml-auto text-content-faint whitespace-nowrap">{D.kindLabel(x.a.type)} · {new Date(x.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
              </button>
            </div>
          );
        })}
        {!items.length && <div className="py-10 text-center text-[12.5px] text-content-faint">Exchange shows nothing published for this account.</div>}
        {items.length === 300 && <div className="py-3 text-center text-[12px] text-content-faint">The latest 300 are shown.</div>}
      </div>
    </div>
  );
}
