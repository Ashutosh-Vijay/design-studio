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
import { pickRandomLoader } from './components/Loaders';
import { Modal, Spinner, btn, btnPrimary } from './App';
import type { Me } from './SyncUI';
import { cmpVersion } from './sync';
import { ask } from './Brand';
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

// ---------- When a part can't be shown ----------
// Three kinds, three looks. Not allowed (the usual one): calm amber, a lock, the permission to ask for, and a
// request ready to send. Not in the subscription: neutral. Couldn't be read (Anypoint failed): red, with Try again.
// A missing permission is an expected state, not an error, so it's never red.
const PERMS: Record<D.Section, string[]> = {
  exchange: ['Exchange Viewer'], governance: ['Governance Viewer'],
  apimanager: ['View Environment', 'View APIs Configuration'], runtime: ['View Environment', 'Read Applications'],
};
const TONE = {
  denied: { box: 'border-warn-border bg-surface', glow: 'var(--warn)', badge: 'bg-warn-tint text-warn border-warn-border', text: 'text-warn' },
  off: { box: 'border-line bg-surface', glow: '', badge: 'bg-surface-2 text-content-muted border-line', text: 'text-content-muted' },
  error: { box: 'border-err-border bg-surface', glow: 'var(--err)', badge: 'bg-err-tint text-err border-err-border', text: 'text-err' },
  ok: { box: 'border-line bg-surface', glow: '', badge: 'bg-surface-2 text-content-muted border-line', text: 'text-content-muted' },
};
const glow = (k: keyof typeof TONE) => (TONE[k].glow ? { backgroundImage: `linear-gradient(to bottom, color-mix(in oklch, ${TONE[k].glow} 11%, transparent), transparent 140px)` } : undefined);
const retry = () => window.dispatchEvent(new Event('ads-dash-refresh'));
// The message to send an administrator: which permissions, where they're granted, and what for.
function request(org: string, sections: D.Section[]) {
  const perms = [...new Set(sections.flatMap((s) => PERMS[s]))];
  return `Hi, could you give my Anypoint account ${perms.length === 1 ? 'this permission' : 'these permissions'} in ${org}: ${perms.join(', ')}? They're granted in Access Management, under Users, my user, Add permissions${sections.some((s) => s === 'apimanager' || s === 'runtime') ? ' (View APIs Configuration and Read Applications are per environment)' : ''}. I need ${perms.length === 1 ? 'it' : 'them'} to see ${sections.map((s) => D.SECTION_LABEL[s]).join(', ').replace(/, ([^,]*)$/, ' and $1')} in Design Studio's dashboard. Thanks!`;
}
function CopyRequest({ org, sections, small }: { org: string; sections: D.Section[]; small?: boolean }) {
  const [done, setDone] = useState(false);
  return (
    <button onClick={() => { navigator.clipboard.writeText(request(org, sections)).then(() => { setDone(true); setTimeout(() => setDone(false), 2200); }, () => {}); }}
      title="Copies a short message for your administrator, naming the permissions and where they're granted"
      className={`inline-flex items-center gap-1.5 rounded-md font-medium border border-line bg-surface text-content-secondary hover:text-content hover:border-content-ghost ${small ? 'h-6 px-2 text-[11.5px]' : 'h-[30px] px-3 text-[12.5px]'}`}>
      {done ? <><span className="text-ok flex"><Icons.Check size={small ? 11 : 13} /></span>Copied</> : <><Icons.Copy size={small ? 11 : 13} />Copy request for your admin</>}
    </button>
  );
}
const Chip = ({ children, tone = 'denied' }: { children: ReactNode; tone?: keyof typeof TONE }) => (
  <span className={`inline-flex items-center h-6 px-2 rounded-md border text-[11.5px] font-medium whitespace-nowrap ${TONE[tone].badge}`}>{children}</span>
);
function Badge({ kind, size = 44 }: { kind: D.Access; size?: number }) {
  return (
    <span className={`shrink-0 rounded-full border flex items-center justify-center ${TONE[kind].badge}`} style={{ width: size, height: size }}>
      {kind === 'denied' ? <Icons.Lock size={size * 0.42} /> : kind === 'off' ? <Icons.Package size={size * 0.42} /> : <Icons.X size={size * 0.42} />}
    </span>
  );
}

// A whole tab that can't show: a centred card.
function NoAccess({ r, s, what }: { r: D.Reading; s: D.Section; what: string }) {
  const a = r.access[s];
  return (
    <div className="flex-1 overflow-auto flex items-center justify-center p-6">
      <div className={`w-full max-w-[500px] rounded-xl border px-7 py-7 text-center shadow-[var(--shadow)] ${TONE[a].box}`} style={glow(a)}>
        <div className="flex justify-center"><Badge kind={a} /></div>
        <h3 className="m-0 mt-4 text-[15px] font-semibold">{a === 'denied' ? `No access to ${D.SECTION_LABEL[s]}` : a === 'off' ? `${D.SECTION_LABEL[s]} isn't part of this subscription` : `${D.SECTION_LABEL[s]} couldn't be read`}</h3>
        <p className="m-0 mt-2 text-[12.5px] text-content-secondary leading-relaxed">
          {a === 'denied' ? <>Your Anypoint account can't read {what} in <b className="font-medium text-content">{r.org.name}</b>. An organization administrator can grant it in Access Management.</>
            : a === 'off' ? <>The organization's subscription doesn't include it, so there's nothing to show here.</>
            : <>{r.why[s]}</>}
        </p>
        {a === 'denied' && <>
          <div className="mt-4 text-[11px] font-semibold uppercase tracking-[0.5px] text-content-faint">Permission to ask for</div>
          <div className="mt-2 flex flex-wrap justify-center gap-1.5">{PERMS[s].map((p) => <Chip key={p}>{p}</Chip>)}</div>
        </>}
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          {a === 'denied' && <CopyRequest org={r.org.name} sections={[s]} />}
          {a === 'error' && <button className={btnPrimary} onClick={retry}>Try again</button>}
        </div>
        {a !== 'error' && <p className="m-0 mt-4 text-[11.5px] text-content-faint">Everything else on the dashboard still works.</p>}
      </div>
    </div>
  );
}
// The same, inside a page: a row with an accent bar on the left.
function NoAccessInline({ r, s, what }: { r: D.Reading; s: D.Section; what: string }) {
  const a = r.access[s];
  return (
    <div className={`relative flex items-center gap-3 pl-4 pr-3.5 py-3 rounded-lg border overflow-hidden ${TONE[a].box}`} style={TONE[a].glow ? { backgroundImage: `linear-gradient(to right, color-mix(in oklch, ${TONE[a].glow} 9%, transparent), transparent 55%)` } : undefined}>
      <span className={`absolute left-0 inset-y-0 w-[3px] ${a === 'denied' ? 'bg-warn' : a === 'error' ? 'bg-err' : 'bg-content-ghost'}`} />
      <Badge kind={a} size={30} />
      <div className="flex-1 min-w-0 text-[12.5px]">
        <div className="font-semibold">{a === 'denied' ? `No access to ${D.SECTION_LABEL[s]}` : a === 'off' ? `${D.SECTION_LABEL[s]} isn't in this subscription` : `${D.SECTION_LABEL[s]} couldn't be read`}</div>
        <div className="mt-0.5 text-content-muted">{a === 'denied' ? <>So {what} {what.endsWith('s') ? 'are' : 'is'} left out. Ask for {PERMS[s].map((p, i) => <span key={p}>{i ? ' and ' : ''}<b className="font-medium text-content-secondary">{p}</b></span>)}.</> : r.why[s]}</div>
      </div>
      {a === 'denied' ? <CopyRequest org={r.org.name} sections={[s]} small /> : a === 'error' ? <button className={btn} onClick={retry}>Try again</button> : null}
    </div>
  );
}

// The first reading of an organization: the start screen's loaders (one of three, at random), and a bar that moves
// through the reading's parts. A refresh never shows this: the last reading stays on screen behind "Refreshing…".
function Reading({ step, org }: { step: string | null; org: string }) {
  const Loader = useMemo(() => pickRandomLoader(), []);
  const colors = useMemo(() => {
    const css = (n: string, f: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || f;
    return { accent: css('--accent', '#10b981'), fg: css('--content', '#f3efe6') };
  }, []);
  // Where each part of the reading starts on the bar; within a part it creeps on, slower and slower.
  const floor = /Governance/.test(step ?? '') ? 45 : /Manager/.test(step ?? '') ? 65 : 5;
  const [p, setP] = useState(5);
  useEffect(() => { setP((x) => Math.max(x, floor)); }, [floor]);
  useEffect(() => { const t = setInterval(() => setP((x) => x + (95 - x) * 0.012), 120); return () => clearInterval(t); }, []);
  return (
    <div className="relative flex-1 flex flex-col items-center justify-center overflow-hidden">
      <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(1000px 700px at 50% 45%, color-mix(in oklch, var(--content) 3%, transparent), transparent 70%), radial-gradient(600px 400px at 50% 110%, color-mix(in oklch, var(--accent) 6%, transparent), transparent 70%)' }} />
      <div className="relative" style={{ width: 200, height: 200 }}><Loader accent={colors.accent} fg={colors.fg} size={200} /></div>
      <div className="relative mt-6 text-[15px] font-semibold text-content">Reading {org || 'the organization'}</div>
      <div className="relative mt-1 h-5 text-[12.5px] text-content-faint">{step ?? 'Reading…'}</div>
      <div className="relative mt-5 w-72 h-1.5 rounded-full bg-surface-2 overflow-hidden">
        <div className="h-full rounded-full bg-accent transition-[width] duration-300 ease-out" style={{ width: `${Math.min(p, 97)}%` }} />
      </div>
      <div className="relative mt-4 text-[11.5px] text-content-ghost">Read only: nothing in the organization is changed.</div>
    </div>
  );
}

type Tab = 'overview' | 'apis' | 'deployments' | 'health' | 'activity';
// The last reading of each organization, for the account that read it: another account starts clean.
const lastReading = new Map<string, D.Reading>();
let readBy = '';
// Specs downloaded by themselves to count endpoints: the newest few. The rest wait for "Count endpoints".
const AUTO_COUNT = 40;

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
  const [counting, setCounting] = useState(false);
  const run = useRef(0);

  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key !== 'Escape' || e.defaultPrevented) return; if (open) setOpen(null); else onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [open, onClose]);

  // Who's signed in, and their business groups. Signing in while the screen is open carries on from here.
  useEffect(() => {
    const f = () => invoke<Me | null>('anypoint_status').then(async (m) => {
      const who = m ? `${m.host}/${m.username}` : '';
      if (who !== readBy) { lastReading.clear(); readBy = who; setReading(null); setOrg(null); }
      setMe(m); if (!m) return;
      const list = await D.groups().catch(() => []);
      setOrgs(list.length ? list : [{ id: m.org_id, name: m.org_name }]);
      setOrg((o) => o ?? { id: m.org_id, name: list.find((g) => g.id === m.org_id)?.name ?? m.org_name });
    }, () => setMe(null));
    f();
    window.addEventListener('ads-signed-in', f);
    return () => window.removeEventListener('ads-signed-in', f);
  }, []);

  // The last reading of each organization stays for this session: going back and in again shows it at once,
  // with its time in the header. It reads again by itself only once it's more than five minutes old, and then
  // behind the shown one ("Refreshing…"), so the screen never empties.
  async function load(o: { id: string; name: string }, force = true) {
    const kept = lastReading.get(o.id);
    setReading(kept ?? null); // another group's reading never stays under this one's name
    const mine = ++run.current;
    const alive = () => mine === run.current, bump = () => { if (alive()) setTick((n) => n + 1); };
    // Publishers and endpoint counts, behind the reading. Leaving the screen stops it, so it starts again here.
    const background = async (r: D.Reading) => {
      await D.details(r.apis, bump, alive);
      if (r.access.exchange !== 'ok') return;
      setCounting(true); await D.countAll(r.apis, bump, alive, AUTO_COUNT); if (alive()) setCounting(false);
    };
    setError(null);
    if (kept && !force && Date.now() - kept.at < 5 * 60000) { setStep(null); background(kept); return; }
    setStep(kept ? 'Refreshing…' : 'Reading…');
    if (!kept) setOpen(null);
    try {
      const r = await D.read(o, (s) => { if (mine === run.current) setStep(kept ? `Refreshing: ${s.replace(/^./, (c) => c.toLowerCase())}` : s); });
      if (mine !== run.current) return;
      // What the background learnt last time still holds for an API whose latest version hasn't moved.
      if (kept) for (const a of r.apis) {
        const b = kept.apis.find((x) => x.groupId === a.groupId && x.assetId === a.assetId);
        if (!b || b.version !== a.version || b.published !== a.published) continue;
        if (b.counts !== undefined && a.counts === undefined) a.counts = b.counts;
        if (b.versions && !a.versions) { a.versions = b.versions; a.by = b.by || a.by; }
      }
      lastReading.set(o.id, r);
      setReading(r); setStep(null);
      setOpen((a) => a && (r.apis.find((x) => x.groupId === a.groupId && x.assetId === a.assetId) ?? null));
      background(r);
    } catch (e) {
      if (mine !== run.current) return;
      setStep(null);
      const why = String(e).replace(/^Error: /, '');
      // A refresh that fails leaves the last reading on screen, and says so.
      if (kept) { setNote(`Couldn't refresh: ${why} Showing the reading from ${new Date(kept.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`); setTimeout(() => setNote(null), 12000); background(kept); }
      else setError(why);
    }
  }
  // Every API's endpoints, when asked: one spec download each.
  async function countRest() {
    if (!reading) return;
    const mine = run.current, alive = () => mine === run.current;
    setCounting(true); await D.countAll(reading.apis, () => { if (alive()) setTick((n) => n + 1); }, alive); if (alive()) setCounting(false);
  }
  useEffect(() => { if (org) load(org, false); return () => { run.current++; }; }, [org?.id]);
  useEffect(() => { const f = () => { if (org) load(org); }; window.addEventListener('ads-dash-refresh', f); return () => window.removeEventListener('ads-dash-refresh', f); }, [org?.id]);

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
        {step && reading && <span className="flex items-center gap-2 text-[12px] text-content-faint"><Spinner />{step}</span>}
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
        ) : !reading || !s ? <Reading step={step} org={org?.name ?? ''} />
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
            <div className="shrink-0 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 px-4 py-2 border-b border-warn-border bg-warn-tint text-[12px] text-content-secondary select-text">
              {missing.length > 0 && <>
                <span className="text-warn flex"><Icons.Lock size={13} /></span>
                <span>Not visible with this account:</span>
                {missing.map((k) => <Chip key={k}>{D.SECTION_LABEL[k]}</Chip>)}
              </>}
              {reading.notes.length > 0 && <span className={missing.length ? 'text-content-muted' : ''}>{reading.notes.join(' ')}</span>}
              {missing.length > 0 && <span className="ml-auto"><CopyRequest org={reading.org.name} sections={missing} small /></span>}
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
                  {reading.access.exchange === 'ok' && !counting && D.uncounted(reading.apis) > 0 && (
                    <button className={btn} onClick={countRest} title="Downloads each of these APIs' latest published spec to count its endpoints. Stable versions are kept, so it's once per version.">Count endpoints for {D.uncounted(reading.apis)} more</button>
                  )}
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
                            {a.kind !== 'api' ? '' : a.counts === undefined ? <span className="text-content-ghost">{counting ? '…' : ''}</span> : a.counts === null ? <span className="text-content-ghost" title="The published spec couldn't be read">?</span>
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
  const card = 'rounded-lg border border-line bg-surface';
  const prodDown = r.apps.filter((a) => a.production && a.health === 'down');
  const govRead = r.access.governance === 'ok' || r.access.governance === 'off';
  // Nothing the dashboard shows is readable: one page that says what it needs, instead of empty cards.
  if ((!ex || s.apis + s.fragments + s.others === 0) && !govRead && !rt && !mgr) return (
    <div className="flex-1 overflow-auto flex items-center justify-center p-6">
      <div className={`w-full max-w-[560px] rounded-xl border px-7 py-7 shadow-[var(--shadow)] ${TONE.denied.box}`} style={glow('denied')}>
        <div className="flex justify-center"><Badge kind="denied" /></div>
        <h3 className="m-0 mt-4 text-center text-[15px] font-semibold">This account can't see anything here yet</h3>
        <p className="m-0 mt-2 text-center text-[12.5px] text-content-secondary leading-relaxed">Each part of the dashboard needs its own Anypoint permission in <b className="font-medium text-content">{r.org.name}</b>. An organization administrator grants them in Access Management.</p>
        <div className="mt-5 rounded-lg border border-line bg-surface divide-y divide-line-subtle">
          {([['exchange', 'APIs, versions, endpoints and activity'], ['governance', 'Governance and conformance'], ['apimanager', "What's managed in each environment"], ['runtime', "What's deployed, and Health"]] as const).map(([s, what]) => (
            <div key={s} className="flex items-center gap-3 px-3.5 py-2.5 text-[12.5px]">
              <span className="flex-1 min-w-0 text-content-secondary">{what}</span>
              <span className="flex flex-wrap justify-end gap-1">{PERMS[s].filter((p) => p !== 'View Environment' || s === 'apimanager').map((p) => <Chip key={p}>{p}</Chip>)}</span>
            </div>
          ))}
        </div>
        <div className="mt-5 flex justify-center"><CopyRequest org={r.org.name} sections={['exchange', 'governance', 'apimanager', 'runtime']} /></div>
        <p className="m-0 mt-4 text-center text-[11.5px] text-content-faint">The design side of Design Studio works without any of them.</p>
      </div>
    </div>
  );
  // What each ring and bar is made of. Status colours say status (conformant, failing, running, stopped); the
  // kinds of API are identities, so they take the theme's other hues, always in the same order.
  const govParts = [
    { id: 'conformant' as const, label: 'Conformant', n: s.conformant, color: 'var(--ok)' },
    { id: 'failing' as const, label: 'Not conformant', n: s.failing, color: 'var(--err)' },
    { id: 'validating' as const, label: 'In validation', n: s.validating, color: 'var(--cyan)' },
    ...(ex ? [{ id: 'none' as const, label: 'Not governed', n: s.apis - s.governed, color: 'var(--content-ghost)' }] : []),
  ];
  const appsOther = s.apps - s.appsUp - s.appsDown.length;
  const runParts = [
    { label: 'Running', n: s.appsUp, color: 'var(--ok)' },
    { label: 'Stopped or failed', n: s.appsDown.length, color: 'var(--err)' },
    { label: 'Starting or unknown', n: appsOther, color: 'var(--content-ghost)' },
  ];
  const KIND_HUES = ['var(--accent)', 'var(--cyan)', 'var(--violet)', 'var(--warn)'];
  const kindParts = [...s.kinds.slice(0, 4).map(([k, n], i) => ({ label: k, n, color: KIND_HUES[i] })),
    ...(s.kinds.length > 4 ? [{ label: 'Other kinds', n: s.kinds.slice(4).reduce((a, [, n]) => a + n, 0), color: 'var(--content-ghost)' }] : [])];
  // Versions published in each of the last twelve months, from every version Exchange listed.
  const months = (() => {
    const out: { key: string; label: string; n: number }[] = [];
    const now = new Date(r.at);
    for (let i = 11; i >= 0; i--) { const d = new Date(now.getFullYear(), now.getMonth() - i, 1); out.push({ key: `${d.getFullYear()}-${d.getMonth()}`, label: `${MONTHS[d.getMonth()]} ${d.getFullYear()}`, n: 0 }); }
    const at = new Map(out.map((m) => [m.key, m]));
    for (const a of r.apis) for (const t of a.versions?.length ? a.versions.map((v) => v.created) : [a.published]) { if (!t) continue; const d = new Date(t), m = at.get(`${d.getFullYear()}-${d.getMonth()}`); if (m) m.n++; }
    return out;
  })();
  const monthMax = Math.max(1, ...months.map((m) => m.n));
  const envRows = r.environments.filter((e) => e.type !== 'design').map((e) => {
    const apps = r.apps.filter((a) => a.env === e.name);
    return { e, apps: apps.length, up: apps.filter((a) => a.health === 'up').length, down: apps.filter((a) => a.health === 'down').length, inst: r.instances.filter((i) => i.env === e.name).length };
  });
  const envMax = Math.max(1, ...envRows.map((x) => (rt ? x.apps : x.inst)));
  const peopleMax = Math.max(1, ...people.map((p) => p.apis));
  const box = `${card} p-5`;
  const title = 'text-[13px] font-semibold';
  const sub = 'text-[11.5px] text-content-faint';
  // A legend row that is also the way into the table: a mark, a name, a count and its share.
  const legend = (p: { label: string; n: number; color: string }, of: number, go?: () => void) => (
    <button key={p.label} onClick={go} disabled={!go} className={`w-full flex items-center gap-2.5 h-7 px-2 -mx-2 rounded-md text-left text-[12.5px] ${go ? 'hover:bg-[var(--hover-overlay)] cursor-pointer' : 'cursor-default'}`}>
      <span className="w-2.5 h-2.5 rounded-[3px] shrink-0" style={{ background: p.color }} />
      <span className="flex-1 min-w-0 truncate text-content-secondary">{p.label}</span>
      <span className="tabular-nums font-medium">{p.n}</span>
      <span className="w-9 text-right tabular-nums text-content-faint">{pct(p.n, of)}</span>
    </button>
  );
  return (
    <div className="flex-1 min-h-0 overflow-auto">
      <div className="max-w-[1240px] mx-auto px-8 py-7 flex flex-col gap-5">
        {/* Governance in words first: the numbers under it mean nothing without knowing which of these it is. */}
        <div className="flex items-start gap-3 text-[13px]">
          <span className="mt-[7px]">{dot(govOn ? 'ok' : r.access.governance === 'ok' || r.access.governance === 'off' ? 'faint' : 'warn')}</span>
          <span className="text-content-secondary leading-relaxed">
            {govOn && <><b className="text-content">API Governance is on.</b> {r.profiles.filter((p) => p.live).length === 1 ? 'One active profile checks' : `${r.profiles.filter((p) => p.live).length} active profiles check`} {s.governed}{ex ? ` of ${s.apis}` : ''} APIs{s.governed ? <>, and {s.conformant} of those conform.</> : '.'}{r.limit != null && s.governed >= r.limit && <> The subscription's allowance is {r.limit} governed APIs.</>}</>}
            {r.governance === 'empty' && <><b className="text-content">API Governance is available, but nothing is checked yet.</b> The organization has it{r.profiles.length ? ', with draft profiles only' : ' and no profile'}. An active profile in API Governance starts checking APIs against its rulesets.</>}
            {r.governance === 'off' && <><b className="text-content">API Governance isn't part of this organization's subscription.</b></>}
            {r.access.governance === 'denied' && <><b className="text-content">This account can't see API Governance.</b> Whether the APIs conform is left out; an administrator can grant the Governance Viewer permission.</>}
            {r.access.governance === 'error' && <><b className="text-content">Governance couldn't be read.</b> {r.why.governance} Refresh to try again.</>}
          </span>
        </div>

        {/* The three wholes: what conforms, what runs, what's published. */}
        <div className="grid gap-5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))' }}>
          {govOn && <div className={box}>
            <div className={title}>Governance</div>
            <div className={sub}>{ex ? `Of the ${s.apis} APIs in Exchange` : `Of the ${s.governed} APIs it checks`}</div>
            <div className="mt-4 flex items-center gap-6">
              <Ring parts={govParts}>
                {s.governed ? <>
                  <div className="text-[24px] leading-none font-semibold tabular-nums">{pct(s.conformant, s.governed)}</div>
                  <div className="mt-1 text-[11px] text-content-faint">of governed<br />conform</div>
                </> : <div className="text-[11.5px] text-content-faint">Nothing<br />governed yet</div>}
              </Ring>
              <div className="flex-1 min-w-0">{govParts.map((p) => legend(p, govParts.reduce((a, x) => a + x.n, 0), () => show(p.id)))}</div>
            </div>
            {s.failing > 0 && <div className="mt-4 pt-3 border-t border-line-subtle text-[12px] text-content-muted">Failing rules by severity: {[['high', r.severity.high], ['medium', r.severity.medium], ['low', r.severity.low]].filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(', ') || 'none recorded'}.</div>}
          </div>}

          {rt && <div className={box}>
            <div className={title}>Running</div>
            <div className={sub}>Apps in Runtime Manager, every environment</div>
            {s.apps ? <>
              <div className="mt-4 flex items-center gap-6">
                <Ring parts={runParts}>
                  <div className="text-[24px] leading-none font-semibold tabular-nums">{s.appsUp}</div>
                  <div className="mt-1 text-[11px] text-content-faint">of {s.apps}<br />running</div>
                </Ring>
                <div className="flex-1 min-w-0">{runParts.filter((p) => p.n > 0 || p.label !== 'Starting or unknown').map((p) => legend(p, s.apps, () => onTab('deployments')))}</div>
              </div>
              {s.prodApps > 0 && <div className="mt-4 pt-3 border-t border-line-subtle text-[12px] text-content-muted">In production: {s.prodApps} {s.prodApps === 1 ? 'app' : 'apps'}, {s.prodDown ? <span className="text-err font-medium">{s.prodDown} stopped or failed</span> : 'all running'}.</div>}
            </> : <div className="mt-6 text-[12.5px] text-content-faint">No apps are deployed in any environment yet.</div>}
          </div>}

          {ex && <div className={box}>
            <div className={title}>In Exchange</div>
            <div className={sub}>APIs this organization has published</div>
            {s.apis ? <>
              <div className="mt-4 flex items-baseline gap-2"><span className="text-[34px] leading-none font-semibold tabular-nums">{s.apis}</span><span className="text-[12.5px] text-content-muted">APIs{s.fragments + s.others > 0 ? `, and ${s.fragments} ${s.fragments === 1 ? 'fragment' : 'fragments'}${s.others ? ` and ${s.others} other assets` : ''}` : ''}</span></div>
              {/* One kind needs no bar: the legend says it. */}
              <div className={`mt-4 h-2.5 gap-[2px] ${kindParts.length > 1 ? 'flex' : 'hidden'}`} role="img" aria-label={kindParts.map((p) => `${p.n} ${p.label}`).join(', ')}>
                {kindParts.map((p, i) => <span key={p.label} title={`${p.label}: ${p.n} (${pct(p.n, s.apis)})`} className={`${i === 0 ? 'rounded-l-[4px]' : ''} ${i === kindParts.length - 1 ? 'rounded-r-[4px]' : ''}`} style={{ background: p.color, flexGrow: p.n, flexBasis: 0, minWidth: 4 }} />)}
              </div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">{kindParts.map((p) => <span key={p.label} className="inline-flex items-center gap-1.5 text-[12px] text-content-secondary"><span className="w-2 h-2 rounded-[2px]" style={{ background: p.color }} />{p.label}<span className="tabular-nums text-content-faint">{p.n}</span></span>)}</div>
              <div className="mt-4 pt-3 border-t border-line-subtle grid grid-cols-2 gap-x-4 gap-y-1.5 text-[12px]">
                <button onClick={() => onTab('activity')} className="text-left text-content-muted hover:text-content"><b className="font-semibold text-content tabular-nums">{s.recent}</b> published in 30 days</button>
                <span className="text-content-muted"><b className={`font-semibold tabular-nums ${s.stale ? 'text-warn' : 'text-content'}`}>{s.stale}</b> quiet for a year</span>
                <span className="text-content-muted"><b className="font-semibold text-content tabular-nums">{s.development}</b> still in Development</span>
                {mgr && <button onClick={() => onTab('deployments')} className="text-left text-content-muted hover:text-content"><b className="font-semibold text-content tabular-nums">{s.managed}</b> managed in API Manager</button>}
              </div>
            </> : <div className="mt-6 text-[12.5px] text-content-faint leading-relaxed">{s.fragments + s.others ? 'Only fragments and other assets so far.' : "None this account can see. Exchange doesn't say whether that's a missing permission."}</div>}
          </div>}
        </div>

        <div className="grid gap-5 items-start" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))' }}>
          {(govOn || rt) && <div className={card}>
            <div className="px-5 pt-4 pb-3 flex items-baseline gap-2"><span className={title}>Needs attention</span><span className={sub}>{prodDown.length + failing.length ? `${prodDown.length + failing.length} ${prodDown.length + failing.length === 1 ? 'item' : 'items'}, worst first` : ''}</span></div>
            {prodDown.slice(0, 8).map((a) => (
              <button key={`${a.env}/${a.name}`} onClick={() => onTab('deployments')} className="w-full flex items-center gap-3 h-10 px-5 border-t border-line-subtle text-left text-[12.5px] hover:bg-[var(--hover-overlay)]">
                {dot('err')}<span className="font-medium truncate">{a.name}</span><span className="text-content-faint whitespace-nowrap">{a.env}</span>
                <span className="ml-auto text-err whitespace-nowrap">{a.status || 'not running'}</span>
              </button>
            ))}
            {prodDown.length > 8 && <button onClick={() => onTab('deployments')} className="w-full h-9 border-t border-line-subtle text-[12px] text-accent hover:underline">All {prodDown.length} down in production</button>}
            {failing.slice(0, 8).map((a) => (
              <button key={`${a.groupId}/${a.assetId}`} onClick={() => onOpen(a)} className="w-full flex items-center gap-3 h-10 px-5 border-t border-line-subtle text-left text-[12.5px] hover:bg-[var(--hover-overlay)]">
                {dot('err')}
                <span className="font-medium truncate">{a.name}</span><span className="font-mono text-[11.5px] text-content-faint">{a.version}</span>
                <span className="ml-auto text-err whitespace-nowrap">{a.fail} of {a.rulesets} rulesets fail</span>
                <span className="w-[120px] text-right text-content-muted truncate">{a.by}</span>
              </button>
            ))}
            {failing.length > 8 && <button onClick={() => show('failing')} className="w-full h-9 border-t border-line-subtle text-[12px] text-accent hover:underline">All {failing.length} not conformant</button>}
            {govOn && ex && uncovered.length > 0 && <button onClick={() => show('none')} className="w-full flex items-center gap-3 h-10 px-5 border-t border-line-subtle text-left text-[12.5px] hover:bg-[var(--hover-overlay)]">
              {dot('faint')}
              <span className="truncate"><b className="font-medium">{uncovered.length} {uncovered.length === 1 ? 'API is' : 'APIs are'} not governed</b><span className="text-content-muted">: no active profile's filter matches {uncovered.length === 1 ? 'it' : 'them'}.</span></span>
            </button>}
            {!failing.length && !prodDown.length && !(govOn && ex && uncovered.length) && <div className="px-5 pb-5 text-[12.5px] text-content-faint">Nothing needs attention: every governed API conforms and nothing in production is down.</div>}
          </div>}

          {(rt || mgr) && envRows.length > 0 && <div className={box}>
            <div className={title}>Environments</div>
            <div className={sub}>{rt ? 'Apps in each, running and not' : 'API instances in each'}</div>
            <div className="mt-3 flex flex-col">
              {envRows.map((x) => (
                <button key={x.e.id} onClick={() => onTab('deployments')} className="flex items-center gap-3 h-9 px-2 -mx-2 rounded-md text-left text-[12.5px] hover:bg-[var(--hover-overlay)]" title={rt ? `${x.e.name}: ${x.up} running, ${x.down} stopped or failed, ${x.apps - x.up - x.down} other` : `${x.e.name}: ${x.inst} API instances`}>
                  <span className="w-[120px] shrink-0 truncate font-medium">{x.e.name}</span>
                  <span className="flex-1 min-w-0 flex items-center">
                    <span className="flex h-2 gap-[2px]" style={{ width: `${((rt ? x.apps : x.inst) / envMax) * 100}%`, minWidth: (rt ? x.apps : x.inst) ? 6 : 0 }}>
                      {rt ? <>
                        {x.up > 0 && <span className="rounded-[3px] bg-ok" style={{ flexGrow: x.up, flexBasis: 0 }} />}
                        {x.down > 0 && <span className="rounded-[3px] bg-err" style={{ flexGrow: x.down, flexBasis: 0, minWidth: 4 }} />}
                        {x.apps - x.up - x.down > 0 && <span className="rounded-[3px] bg-content-ghost" style={{ flexGrow: x.apps - x.up - x.down, flexBasis: 0 }} />}
                      </> : <span className="flex-1 rounded-[3px] bg-accent" />}
                    </span>
                  </span>
                  <span className="w-[150px] shrink-0 text-right text-content-muted whitespace-nowrap tabular-nums">{rt ? `${x.apps} ${x.apps === 1 ? 'app' : 'apps'}` : `${x.inst} ${x.inst === 1 ? 'instance' : 'instances'}`}{rt && x.down > 0 && <span className="text-err"> · {x.down} down</span>}</span>
                  {x.e.production ? <span className="w-[70px] shrink-0 text-[10.5px] text-content-faint">Production</span> : <span className="w-[70px] shrink-0" />}
                </button>
              ))}
            </div>
            {rt && <div className="mt-3 flex gap-4 text-[11.5px] text-content-faint"><span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-[2px] bg-ok" />Running</span><span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-[2px] bg-err" />Stopped or failed</span></div>}
          </div>}
        </div>

        <div className="grid gap-5 items-start" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))' }}>
          {ex && apis.length > 0 && <div className={box}>
            <div className={title}>Publishing</div>
            <div className={sub}>Versions published each month, the last twelve</div>
            <div className="mt-4 flex items-end gap-[3px] h-[92px]" role="img" aria-label={months.map((m) => `${m.label}: ${m.n}`).join(', ')}>
              {months.map((m) => (
                <div key={m.key} className="group/m relative flex-1 h-full flex items-end" title={`${m.label}: ${m.n} ${m.n === 1 ? 'version' : 'versions'}`}>
                  <div className="w-full rounded-t-[4px] bg-accent opacity-80 group-hover/m:opacity-100" style={{ height: m.n ? `${Math.max((m.n / monthMax) * 100, 4)}%` : 2, background: m.n ? undefined : 'var(--surface-3)' }} />
                </div>
              ))}
            </div>
            <div className="mt-1.5 flex gap-[3px] text-[10.5px] text-content-faint">{months.map((m, i) => <span key={m.key} className="flex-1 text-center">{i % 3 === 2 || i === 0 ? m.label.slice(0, 3) : ''}</span>)}</div>
            <div className="mt-3 pt-3 border-t border-line-subtle text-[12px] text-content-muted">Busiest: {months.reduce((a, b) => (b.n > a.n ? b : a)).label}, with {monthMax === 1 && !months.some((m) => m.n) ? 0 : monthMax} versions.</div>
          </div>}

          {ex && apis.length > 0 && <div className={box}>
            <div className={title}>By publisher</div>
            <div className={sub}>Who published each API's latest version</div>
            <div className="mt-3 flex flex-col gap-2.5">
              {people.slice(0, 7).map((p) => (
                <div key={p.name} className="text-[12.5px]" title={`${p.name}: ${p.apis} ${p.apis === 1 ? 'API' : 'APIs'}${govOn ? `, ${p.failing} not conformant` : ''}, last published ${when(p.last, r.at).toLowerCase()}`}>
                  <div className="flex items-baseline gap-2"><span className="truncate">{p.name}</span><span className="ml-auto tabular-nums text-content-muted whitespace-nowrap">{p.apis}{govOn && p.failing > 0 && <span className="text-err"> · {p.failing} failing</span>}</span></div>
                  <div className="mt-1 flex h-1.5 gap-[2px]" style={{ width: `${(p.apis / peopleMax) * 100}%`, minWidth: 6 }}>
                    <span className="rounded-[3px] bg-accent" style={{ flexGrow: Math.max(p.apis - (govOn ? p.failing : 0), 0), flexBasis: 0 }} />
                    {govOn && p.failing > 0 && <span className="rounded-[3px] bg-err" style={{ flexGrow: p.failing, flexBasis: 0, minWidth: 4 }} />}
                  </div>
                </div>
              ))}
            </div>
            {people.length > 7 && <div className="mt-3 text-[11.5px] text-content-faint">and {people.length - 7} more</div>}
          </div>}

          {r.profiles.length > 0 && <div className={box}>
            <div className={title}>Governance profiles</div>
            <div className={sub}>What each checks, and how much passes</div>
            <div className="mt-3 flex flex-col gap-3.5">
              {r.profiles.map((p) => (
                <div key={p.id} className="text-[12.5px]">
                  <div className="flex items-center gap-2"><span className="font-medium truncate">{p.name}</span>
                    <span className={`text-[10.5px] px-1.5 py-px rounded border ${p.live ? 'border-[color-mix(in_oklch,var(--ok)_40%,transparent)] text-ok' : 'border-line text-content-muted'}`}>{p.live ? 'Active' : 'Draft'}</span>
                    <span className="ml-auto text-content-muted whitespace-nowrap tabular-nums">{p.live && p.total > 0 ? `${p.pass} of ${p.total} conform` : `${p.total} APIs`}</span></div>
                  {p.live && p.total > 0 && <div className="mt-1.5 h-1.5 flex gap-[2px]"><span className="rounded-[3px] bg-ok" style={{ flexGrow: p.pass, flexBasis: 0 }} />{p.fail > 0 && <span className="rounded-[3px] bg-err" style={{ flexGrow: p.fail, flexBasis: 0 }} />}{p.total - p.pass - p.fail > 0 && <span className="rounded-[3px] bg-surface-3" style={{ flexGrow: p.total - p.pass - p.fail, flexBasis: 0 }} />}</div>}
                  <div className="mt-1.5 text-[11.5px] text-content-faint truncate" title={p.rulesets.join(', ')}>{p.rulesets.join(', ') || 'No rulesets'}</div>
                </div>
              ))}
            </div>
          </div>}

          {trend.length >= 2 && <div className={box}>
            <div className={title}>Conformance over time</div>
            <div className={sub}>Kept on this computer, one reading a day</div>
            <svg viewBox="0 0 300 70" className="mt-4 w-full h-[70px]" preserveAspectRatio="none" role="img" aria-label="Share of governed APIs that conform, by day">
              <polyline fill="none" stroke="var(--ok)" strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" points={trend.map((p, i) => `${(i / (trend.length - 1)) * 300},${64 - (p.conformant / p.governed) * 58}`).join(' ')} />
            </svg>
            <div className="mt-1 flex justify-between text-[11px] text-content-faint"><span>{trend[0].d}: {pct(trend[0].conformant, trend[0].governed)}</span><span>{trend[trend.length - 1].d}: {pct(trend[trend.length - 1].conformant, trend[trend.length - 1].governed)}</span></div>
          </div>}
        </div>
      </div>
    </div>
  );
}

// A whole split into a few parts: a ring, with the figure that matters in the middle. A 2 px gap of the surface
// keeps neighbouring parts apart; each part names itself on hover, and the legend beside it carries the numbers.
function Ring({ parts, size = 136, children }: { parts: { label: string; n: number; color: string }[]; size?: number; children: ReactNode }) {
  const live = parts.filter((p) => p.n > 0), total = live.reduce((a, p) => a + p.n, 0);
  const R = 42, C = 2 * Math.PI * R, gap = live.length > 1 ? 2 : 0;
  let at = 0;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg viewBox="0 0 100 100" className="w-full h-full -rotate-90" role="img" aria-label={parts.map((p) => `${p.label}: ${p.n}`).join(', ')}>
        <circle cx="50" cy="50" r={R} fill="none" stroke="var(--surface-3)" strokeWidth="10" />
        {live.map((p) => {
          const len = (p.n / total) * C, start = at; at += len;
          return <circle key={p.label} cx="50" cy="50" r={R} fill="none" stroke={p.color} strokeWidth="10" strokeDasharray={`${Math.max(len - gap, 0.6)} ${C}`} strokeDashoffset={-start} className="hover:[stroke-width:12] transition-[stroke-width]"><title>{`${p.label}: ${p.n} (${Math.round((p.n / total) * 100)}%)`}</title></circle>;
        })}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center pointer-events-none">{children}</div>
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
  const apps = r.apps.filter((a) => (env === 'all' || (env === ':prod' ? a.production : env === ':nonprod' ? !a.production : a.env === env)) && match(`${a.name} ${a.runtime} ${a.status}`)).sort((a, b) => (a.health === 'down' ? 0 : 1) - (b.health === 'down' ? 0 : 1) || a.name.localeCompare(b.name));
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
          <Select value={env} onChange={setEnv} className="h-7 min-w-[190px]" title="Which environments' apps to show" options={[
            { value: 'all', label: 'Every environment' },
            ...(envs.some((e) => e.production) ? [{ value: ':prod', label: 'Production only' }, { value: ':nonprod', label: 'Everything but production' }] : []),
            ...envs.map((e) => ({ value: e.name, label: `${e.name}${e.production ? ' (production)' : ''}` })),
          ]} />
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
                    <tr key={`${x.groupId}/${x.assetId}`} onClick={() => api && onOpen(api)} className={api ? 'cursor-pointer hover:bg-[var(--hover-overlay)]' : ''}>
                      <td className={`${td} font-medium`}>{x.name}</td>
                      {envs.map((e) => <td key={e.id} className={td}>{(x.cells.get(e.name) ?? []).map((i) => (
                        <span key={i.id} className="inline-flex items-center gap-1.5 mr-3 whitespace-nowrap" title={`${i.label || 'Instance'} ${i.id}${i.endpoint ? ' · ' + i.endpoint : ''}${api && cmpVersion(i.version, api.version) < 0 ? ` · linked to Exchange ${i.version}, latest is ${api.version}` : ''}`}>
                          {dot(/^active$/i.test(i.status) ? 'ok' : /unregistered|inactive/i.test(i.status) ? 'warn' : 'faint')}<span className="font-mono text-[12px]">{i.version}</span>{i.label && <span className="text-content-faint">{i.label}</span>}
                        </span>
                      ))}{!(x.cells.get(e.name) ?? []).length && <span className="text-content-ghost">None</span>}</td>)}
                    </tr>
                  );
                })}</tbody>
              </table></div>
            ) : <div className="px-3.5 py-4 text-[12.5px] text-content-faint">{q ? 'Nothing matches.' : 'No API is managed in API Manager in any environment yet.'}</div>}
          </div>
        ) : <NoAccessInline r={r} s="apimanager" what="which version is managed where" />}

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
        ) : <NoAccessInline r={r} s="runtime" what="the apps" />}
      </div>
    </div>
  );
}

// ---------- Health: Anypoint's own status, and a check of the URLs you choose, only when you press Check ----------
function Health({ r }: { r: D.Reading }) {
  const [saved, setSaved] = useState<D.Saved>(() => D.savedHealth(r.org.id));
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [env, setEnv] = useState('all'); // all, :prod, :nonprod, or one environment's name
  const [q, setQ] = useState('');
  const [down, setDown] = useState(false);
  const [sort, setSort] = useState<{ col: string; asc: boolean }>({ col: 'state', asc: true });
  // The rows and their order hold still until the sort, a filter or the reading changes: a check's result or a new
  // address never moves a row out from under the pointer, nor out of a filter, while someone works down the list.
  const shown = useRef<{ view: string; keys: string[] }>({ view: '', keys: [] });
  // Apps (Runtime Manager: is it running) and APIs (API Manager: is an app claiming the instance) are shown apart:
  // mixed in one list, "started" beside "active" for the same name read as the same thing.
  const [from, setFrom] = useState<'apps' | 'apis'>(r.access.runtime === 'ok' ? 'apps' : 'apis');
  const [bulk, setBulk] = useState(false);
  // How a row is checked: its own settings, else its environment's, else the ones for every environment.
  const [orgReq, setOrgReq] = useState<D.Req>(() => D.savedReq(r.org.id));
  const [envReqs, setEnvReqs] = useState<Record<string, D.Req>>(() => D.savedEnvReqs(r.org.id));
  // scope: 'all', 'env:<name>' or a row's key.
  const [editing, setEditing] = useState<{ scope: string; name: string } | null>(null);
  const put = (s: D.Saved) => { setSaved(s); D.saveHealth(r.org.id, s); };
  const envOfKey = (k: string) => k.replace(/^(app|api):/, '').split('/')[0];
  const reqOf = (k: string) => saved[k]?.req ?? envReqs[envOfKey(k)] ?? orgReq;
  // The keychain scope a row's secrets are under: the level its settings come from.
  const scopeOf = (k: string) => (saved[k]?.req ? k : envReqs[envOfKey(k)] ? `env:${envOfKey(k)}` : 'all');
  if (r.access.runtime !== 'ok' && r.access.apimanager !== 'ok') return <NoAccess r={r} s="runtime" what="Runtime Manager's apps or API Manager's APIs" />;
  const urlOf = (k: string, d: string) => saved[k]?.url ?? d;
  // What can be checked, with the address Anypoint knows (if any).
  const all = from === 'apps'
    ? r.apps.map((a) => ({ key: `app:${a.env}/${a.name}`, name: a.name, env: a.env, production: a.production, what: a.runtime, tip: a.mule ? `Mule ${a.mule}` : '', status: a.status, health: a.health, url: a.url }))
    : r.instances.map((i) => {
      // The label is shown only when it says something the name doesn't.
      const latest = r.apis.find((a) => a.groupId === i.groupId && a.assetId === i.assetId)?.version;
      const behind = !!latest && !!i.version && cmpVersion(i.version, latest) < 0;
      return { key: `api:${i.env}/${i.id}`, name: `${i.name}${i.label && i.label !== i.name ? ` (${i.label})` : ''}`, env: i.env, production: i.production,
        what: `Exchange version ${i.version}${behind ? ` · latest is ${latest}` : ''}`,
        tip: `The version of the Exchange asset this API instance is linked to in API Manager${behind ? ` (Exchange's latest is ${latest})` : ''}. It changes only when someone changes it there (Change API version) or a pipeline does, not when a newer version is published. It doesn't change what runs: Autodiscovery pairs the app with the instance by its ID.`,
        status: i.status, health: /^active$/i.test(i.status) ? 'up' as const : 'other' as const, url: i.endpoint };
    });
  const envNames = [...new Set(all.map((x) => x.env))];
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  // Down: Anypoint says so, or the last check failed. Sorted with the worst first by default.
  const isDown = (x: (typeof all)[number]) => x.health === 'down' || saved[x.key]?.last?.ok === false;
  const val = (x: (typeof all)[number]): string | number => ({
    name: x.name.toLowerCase(), env: `${x.production ? 0 : 1}${x.env.toLowerCase()}`,
    state: isDown(x) ? 0 : x.health === 'up' ? 2 : 1, check: saved[x.key]?.last ? (saved[x.key].last!.ok ? 1 : 0) : 2,
  } as Record<string, string | number>)[sort.col];
  const fresh = all.filter((x) => (env === 'all' || (env === ':prod' ? x.production : env === ':nonprod' ? !x.production : x.env === env))
    && (!down || isDown(x)) && words.every((w) => `${x.name} ${x.what} ${x.status} ${x.env}`.toLowerCase().includes(w)))
    .sort((a, b) => { const p = val(a), s = val(b); return (p < s ? -1 : p > s ? 1 : a.name.localeCompare(b.name)) * (sort.asc ? 1 : -1); });
  const view = JSON.stringify([from, env, down, q, sort, r.at]);
  if (shown.current.view !== view) shown.current = { view, keys: fresh.map((x) => x.key) };
  const byKey = new Map(all.map((x) => [x.key, x]));
  const items = shown.current.keys.map((k) => byKey.get(k)).filter((x): x is (typeof all)[number] => !!x);
  const filtered = items.length !== all.length;
  const head = (label: string, col?: string) => (
    <th key={label} className={th} aria-sort={col && sort.col === col ? (sort.asc ? 'ascending' : 'descending') : undefined}>
      {col ? <button onClick={() => setSort((s) => ({ col, asc: s.col === col ? !s.asc : true }))} className="inline-flex items-center gap-1 hover:text-content">{label}{sort.col === col && <span>{sort.asc ? '↑' : '↓'}</span>}</button> : label}
    </th>
  );
  const go = async (list: typeof items) => {
    const todo = list.filter((x) => /^https?:\/\//.test(urlOf(x.key, x.url)));
    if (!todo.length) return;
    // Many requests that aren't reads: one more look first.
    const writes = todo.filter((x) => !/^(GET|HEAD)$/.test(reqOf(x.key).method));
    if (todo.length > 1 && writes.length && !(await ask(`This sends ${writes.length} ${[...new Set(writes.map((x) => reqOf(x.key).method))].join(' and ')} ${writes.length === 1 ? 'request' : 'requests'}, maybe to production. Check them?`, 'Check'))) return;
    setBusy(new Set(todo.map((x) => x.key)));
    const next = { ...saved };
    // Six at a time, each result shown as it lands.
    await D.checkMany(todo, (x) => D.check(urlOf(x.key, x.url), reqOf(x.key), r.org.id, scopeOf(x.key)), (x, c) => {
      next[x.key] = { ...next[x.key], url: urlOf(x.key, x.url), last: c }; setSaved({ ...next });
      setBusy((b) => { const n = new Set(b); n.delete(x.key); return n; });
    });
    put(next);
  };
  const th = 'sticky top-0 h-8 px-3 text-left font-medium text-[11.5px] text-content-faint bg-surface border-b border-line whitespace-nowrap';
  const td = 'h-9 px-3 border-b border-line-subtle';
  return (
    <div className="flex-1 min-h-0 overflow-auto">
      <div className="max-w-[1180px] mx-auto px-6 py-5 flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <p className="m-0 flex-1 text-[12.5px] text-content-muted leading-relaxed">Anypoint's own status for each app and API, and a check of the address you give each one (a health endpoint works best). A check is one request from this computer, only when you press Check: nothing runs on a timer. Addresses and settings are kept on this computer, and secret header values in the system keychain.</p>
          <button className={btn} onClick={() => setEditing(env !== 'all' && !env.startsWith(':') ? { scope: `env:${env}`, name: env } : { scope: 'all', name: '' })}
            title={`Every environment: ${D.describe(orgReq)}${Object.keys(envReqs).length ? `. Own settings: ${Object.keys(envReqs).join(', ')}` : ''}`}>
            <span className="inline-flex items-center gap-1.5"><Icons.Settings size={13} />How checks are sent
              <span className="font-mono text-[11px] text-content-faint">{Object.keys(envReqs).length ? `${Object.keys(envReqs).length + 1} settings` : `${orgReq.method} · ${orgReq.success}`}</span></span>
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {r.access.runtime === 'ok' && r.access.apimanager === 'ok' && (
            <span className="flex items-center gap-0.5 p-0.5 rounded-lg bg-surface-2 border border-line">
              {([['apps', 'Apps', 'Runtime Manager', r.apps.length], ['apis', 'APIs', 'API Manager', r.instances.length]] as const).map(([id, label, src, n]) => (
                <button key={id} onClick={() => setFrom(id)} aria-pressed={from === id} title={id === 'apps' ? 'Runtime Manager: whether each deployed Mule app is running' : 'API Manager: whether a running app has claimed each API instance (Autodiscovery)'}
                  className={`h-6 px-2.5 rounded-md text-[12px] whitespace-nowrap ${from === id ? 'bg-surface-3 text-content font-medium' : 'text-content-muted hover:text-content'}`}>
                  {label}<span className="ml-1.5 font-normal text-content-faint">{src} · {n}</span>
                </button>
              ))}
            </span>
          )}
          <label className="flex items-center gap-1.5 h-7 w-[240px] px-2 rounded-md bg-surface-2 border border-line text-content-faint focus-within:border-accent-border">
            <Icons.Search size={12} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by name or status" aria-label="Filter" spellCheck={false} className="flex-1 min-w-0 bg-transparent outline-none text-[12px] text-content" />
          </label>
          <Select value={env} onChange={setEnv} className="h-7 min-w-[190px]" title="Which environments to show" options={[
            { value: 'all', label: 'Every environment' },
            ...(all.some((x) => x.production) ? [{ value: ':prod', label: 'Production only' }, { value: ':nonprod', label: 'Everything but production' }] : []),
            ...envNames.map((n) => ({ value: n, label: `${n}${all.find((x) => x.env === n)?.production ? ' (production)' : ''}` })),
          ]} />
          <button onClick={() => setDown((d) => !d)} aria-pressed={down} className={`h-7 px-2.5 rounded-md border text-[12px] ${down ? 'border-err-border bg-err-tint text-err font-medium' : 'border-line text-content-muted hover:text-content'}`}>Down only</button>
          {filtered && <span className="text-[12px] text-content-faint">{items.length} of {all.length}</span>}
          <span className="flex-1" />
          <button className={btn} disabled={busy.size > 0 || !items.length} onClick={() => setBulk(true)} title="Every address in one place: fill them from a pattern, or paste them from a spreadsheet">Edit addresses…</button>
          <button className={btnPrimary} disabled={busy.size > 0 || !items.some((x) => /^https?:\/\//.test(urlOf(x.key, x.url)))} onClick={() => go(items)}
            title={filtered ? 'Checks only the rows shown' : undefined}>{busy.size ? 'Checking…' : filtered ? `Check these ${items.length}` : 'Check all'}</button>
        </div>
        <div className="rounded-lg border border-line bg-surface overflow-auto">
          {items.length ? <table className="w-full text-[12.5px] border-separate border-spacing-0">
            <thead><tr>{head('Name', 'name')}{head('Environment', 'env')}{head(from === 'apps' ? 'Runtime Manager says' : 'API Manager says', 'state')}{head('Address to check')}{head('Last check', 'check')}{head('')}</tr></thead>
            <tbody>{items.map((x) => {
              const last = saved[x.key]?.last;
              return (
                <tr key={x.key}>
                  <td className={`${td} min-w-[220px] max-w-[320px]`}><div className="font-medium truncate" title={x.name}>{x.name}</div><div className="text-[11px] text-content-faint truncate" title={x.tip || undefined}>{x.what}</div></td>
                  <td className={`${td} text-content-muted whitespace-nowrap`}>{x.env}{x.production && <span className="ml-1.5 text-[10.5px] px-1.5 py-px rounded border border-line">Production</span>}</td>
                  <td className={td}><span className={`inline-flex items-center gap-1.5 whitespace-nowrap ${x.health === 'up' ? 'text-ok' : x.health === 'down' ? 'text-err' : 'text-content-muted'}`}>{dot(x.health === 'up' ? 'ok' : x.health === 'down' ? 'err' : 'faint')}{x.status || 'unknown'}</span></td>
                  <td className={`${td} w-[34%] min-w-[220px]`}>
                    <input key={urlOf(x.key, x.url)} defaultValue={urlOf(x.key, x.url)} placeholder="https://…/health" spellCheck={false} aria-label={`Address to check for ${x.name}`}
                      onBlur={(e) => { const v = e.target.value.trim(); if (v !== urlOf(x.key, x.url)) put({ ...saved, [x.key]: { url: v, req: saved[x.key]?.req } }); }}
                      className="w-full h-7 px-2 rounded-md border border-line bg-surface-input font-mono text-[11.5px] text-content outline-none focus:border-accent" />
                  </td>
                  <td className={`${td} whitespace-nowrap`}>{busy.has(x.key) ? <span className="flex items-center gap-2 text-content-faint"><Spinner />Checking</span>
                    : last ? <span className={last.ok ? 'text-ok' : 'text-err'} title={`${last.method ?? 'GET'} at ${new Date(last.at).toLocaleString()}${last.code ? `: ${last.code} counts as ${last.ok ? 'up' : 'down'}` : ''}${last.note ? ' · ' + last.note : ''}`}>{last.ok ? 'Up' : 'Down'} · {last.code ?? 'no answer'} · {last.ms} ms<span className="ml-1.5 text-content-faint">{when(last.at)}</span></span>
                    : <span className="text-content-ghost">Not checked</span>}</td>
                  <td className={`${td} text-right whitespace-nowrap`}>
                    {/* The row's own request: marked, so a row that differs from the rest is seen. */}
                    <button onClick={() => setEditing({ scope: x.key, name: `${x.name} in ${x.env}` })} aria-label={`How ${x.name} is checked`}
                      title={saved[x.key]?.req ? `Its own settings: ${D.describe(saved[x.key].req!)}` : `Uses the settings for ${envReqs[x.env] ? x.env : 'every environment'}: ${D.describe(reqOf(x.key))}. Click to give it its own.`}
                      className={`mr-1.5 h-[26px] px-1.5 rounded-md inline-flex items-center gap-1 align-middle text-[11px] font-mono ${saved[x.key]?.req ? 'text-accent border border-accent-border bg-accent-dim' : 'text-content-faint hover:text-content hover:bg-surface-3'}`}>
                      <Icons.Settings size={12} />{saved[x.key]?.req ? saved[x.key].req!.method : ''}
                    </button>
                    <button className={btn} disabled={busy.has(x.key) || !/^https?:\/\//.test(urlOf(x.key, x.url))} onClick={() => go([x])}>Check</button>
                  </td>
                </tr>
              );
            })}</tbody>
          </table> : <div className="px-3.5 py-6 text-center text-[12.5px] text-content-faint">{all.length ? 'Nothing matches.' : "Nothing is deployed or managed yet, so there's nothing to check."}</div>}
        </div>
        {editing && (() => {
          const sc = editing.scope, isEnv = sc.startsWith('env:'), envName = isEnv ? sc.slice(4) : '', isRow = sc !== 'all' && !isEnv;
          const rowEnv = isRow ? envOfKey(sc) : '';
          // Every environment the organization has, so one with no rows yet can be set up too.
          const envList = [...new Set([...r.environments.filter((e) => e.type !== 'design').map((e) => e.name), ...Object.keys(envReqs)])];
          return <RequestSettings key={sc} org={r.org.id} scope={sc}
            title={isRow ? `How ${editing.name} is checked` : 'How checks are sent'}
            sub={isRow ? 'This row only' : isEnv ? `Rows in ${envName}, unless a row has its own` : "Every environment that doesn't have its own, and the rows in it"}
            start={isRow ? saved[sc]?.req ?? null : isEnv ? envReqs[envName] ?? null : orgReq}
            fallback={isRow ? envReqs[rowEnv] ?? orgReq : orgReq}
            fallbackLabel={isRow ? (envReqs[rowEnv] ? `the settings for ${rowEnv}` : 'the settings for every environment') : 'the settings for every environment'}
            places={isRow ? undefined : [{ value: 'all', label: 'Every environment' }, ...envList.map((n) => ({ value: `env:${n}`, label: `${n}${envReqs[n] ? ' (own settings)' : ''}` }))]}
            onPlace={(p) => setEditing({ scope: p, name: p.slice(4) })}
            onClose={() => setEditing(null)}
            onSave={(q) => {
              if (sc === 'all') { setOrgReq(q!); D.saveReq(r.org.id, q!); }
              else if (isEnv) { const m = { ...envReqs }; if (q) m[envName] = q; else delete m[envName]; setEnvReqs(m); D.saveEnvReqs(r.org.id, m); }
              else put({ ...saved, [sc]: { ...saved[sc], url: urlOf(sc, all.find((x) => x.key === sc)?.url ?? ''), req: q ?? undefined } });
              setEditing(null);
            }} />;
        })()}
        {bulk && <Addresses rows={items.map((x) => ({ key: x.key, name: x.name, env: x.env, url: urlOf(x.key, x.url) }))} filtered={filtered} onClose={() => setBulk(false)}
          onApply={(urls) => { const next = { ...saved }; for (const [k, u] of urls) if (u !== urlOf(k, all.find((x) => x.key === k)?.url ?? '')) next[k] = { url: u, req: saved[k]?.req }; put(next); setBulk(false); }} />}
      </div>
    </div>
  );
}

// How a check is sent: method, headers, body, and which status codes mean up. For the organization's rows (start is
// its settings) or one row (start is the row's own, or null when it uses the organization's). Secret header values go
// to the system keychain when saved and are never shown again: a saved one says so, and typing replaces it.
const METHODS_HTTP = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
function RequestSettings({ org, scope, title, sub, start, fallback, fallbackLabel, places, onPlace, onClose, onSave }: {
  org: string; scope: string; title: string; sub: string; start: D.Req | null; fallback: D.Req; fallbackLabel: string;
  places?: { value: string; label: string }[]; onPlace: (scope: string) => void; onClose: () => void; onSave: (q: D.Req | null) => void;
}) {
  const row = scope !== 'all'; // an environment or a row: it can use the level above instead
  const [own, setOwn] = useState(!row || !!start);
  const base = start ?? fallback;
  // A secret copied from the organization's settings has no value under this row's key, so it must be typed again.
  const [q, setQ] = useState<D.Req>(() => ({ ...base, headers: base.headers.map((h) => ({ ...h })) }));
  const [typed, setTyped] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const hasBody = !/^(GET|HEAD)$/.test(q.method);
  const jsonBad = hasBody && q.body.trim() && /^[\[{]/.test(q.body.trim()) && (() => { try { JSON.parse(q.body); return false; } catch { return true; } })();
  const set = (i: number, h: Partial<D.Header>) => setQ({ ...q, headers: q.headers.map((x, j) => (j === i ? { ...x, ...h } : x)) });
  const savedSecret = (i: number) => !!start && q.headers[i].secret && base.headers.some((b) => b.secret && b.name.trim().toLowerCase() === q.headers[i].name.trim().toLowerCase());
  const save = async () => {
    setErr(null);
    if (!own) { for (const h of (start?.headers ?? []).filter((h) => h.secret)) await invoke('health_secret', { key: D.secretKey(org, scope, h.name), value: null }).catch(() => {}); onSave(null); return; }
    if (!D.successValid(q.success)) { setErr('Say which status codes mean up, like 2xx, or 200-399, or 2xx, 401.'); return; }
    const missing = q.headers.find((h, i) => h.name.trim() && h.secret && !typed[i] && !savedSecret(i));
    if (missing) { setErr(`Type the value of ${missing.name.trim()}: secret values are kept in the system keychain, one per place they're used.`); return; }
    setBusy(true);
    try {
      for (const [i, v] of Object.entries(typed)) { const h = q.headers[Number(i)]; if (h?.secret && h.name.trim() && v) await invoke('health_secret', { key: D.secretKey(org, scope, h.name), value: v }); }
      // Secrets that were removed, renamed or made plain leave the keychain.
      const keep = new Set(q.headers.filter((h) => h.secret && h.name.trim()).map((h) => h.name.trim().toLowerCase()));
      for (const h of (start?.headers ?? []).filter((h) => h.secret && !keep.has(h.name.trim().toLowerCase()))) await invoke('health_secret', { key: D.secretKey(org, scope, h.name), value: null }).catch(() => {});
      onSave({ ...q, method: q.method.toUpperCase(), headers: q.headers.filter((h) => h.name.trim()).map((h, i) => ({ name: h.name.trim(), secret: h.secret, value: h.secret ? '' : (typed[i] ?? h.value) })) });
    } catch (e) { setErr(String(e).replace(/^Error: /, '')); }
    setBusy(false);
  };
  const input = 'h-7 px-2 rounded-md border border-line bg-surface-input text-[12px] text-content outline-none focus:border-accent';
  const label = 'text-[12px] font-medium';
  return (
    <Modal title={title} width={640} onCancel={onClose} sub={sub}
      footer={<><span className="mr-auto text-[12px] text-err">{err}</span><button className={btn} onClick={onClose}>Cancel</button><button className={btnPrimary} disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button></>}>
      <div className="flex flex-col gap-4">
        {places && <label className="flex items-center gap-3"><span className={label}>For</span>
          <Select value={scope} onChange={onPlace} className="flex-1 text-[12.5px]" options={places} title="Credentials usually differ between environments: each can have its own" /></label>}
        {row && <Select value={own ? 'own' : 'all'} onChange={(v) => setOwn(v === 'own')} className="w-full text-[12.5px]"
          options={[{ value: 'all', label: `Use ${fallbackLabel} (${fallback.method}, up on ${fallback.success})` }, { value: 'own', label: 'Its own settings' }]} />}
        {own && <>
          <div className="flex items-end gap-3">
            <label className="flex flex-col gap-1"><span className={label}>Method</span>
              <Select value={q.method} onChange={(m) => setQ({ ...q, method: m })} className="w-[120px] h-7 text-[12px]" mono options={METHODS_HTTP.map((m) => ({ value: m, label: m }))} /></label>
            <label className="flex-1 flex flex-col gap-1"><span className={label}>Up when the status is</span>
              <input value={q.success} onChange={(e) => setQ({ ...q, success: e.target.value })} spellCheck={false} placeholder="2xx" aria-label="Status codes that mean up"
                className={`${input} font-mono ${D.successValid(q.success) ? '' : '!border-err'}`} /></label>
          </div>
          <div className="-mt-2 text-[11.5px] text-content-faint">Status codes that mean up, separated by commas: <span className="font-mono">2xx</span>, a range like <span className="font-mono">200-399</span>, or single codes like <span className="font-mono">401</span>. Anything else, and no answer at all, is down.</div>
          <div>
            <div className="flex items-center"><span className={label}>Headers</span>
              <button className="ml-auto text-[12px] text-accent hover:underline" onClick={() => setQ({ ...q, headers: [...q.headers, { name: '', value: '', secret: false }] })}>Add a header</button></div>
            {!q.headers.length && <div className="mt-1 text-[11.5px] text-content-faint">None. Add client_id and client_secret here if the APIs need them.</div>}
            <div className="mt-1.5 flex flex-col gap-1.5">
              {q.headers.map((h, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <input value={h.name} onChange={(e) => set(i, { name: e.target.value })} placeholder="client_id" spellCheck={false} aria-label="Header name" className={`${input} w-[170px] font-mono`} />
                  {h.secret
                    ? <input type="password" value={typed[i] ?? ''} onChange={(e) => setTyped({ ...typed, [i]: e.target.value })} autoComplete="off" aria-label={`Value of ${h.name || 'the header'}`}
                        placeholder={savedSecret(i) ? 'Saved in the system keychain. Type to replace' : 'Value, kept in the system keychain'} className={`${input} flex-1 min-w-0 font-mono`} />
                    : <input value={h.value} onChange={(e) => set(i, { value: e.target.value })} placeholder="Value" spellCheck={false} aria-label={`Value of ${h.name || 'the header'}`} className={`${input} flex-1 min-w-0 font-mono`} />}
                  <label className="flex items-center gap-1 text-[11.5px] text-content-muted whitespace-nowrap" title="Kept in the system keychain, not with the other settings, and never shown again">
                    <input type="checkbox" checked={h.secret} onChange={(e) => { set(i, { secret: e.target.checked, value: e.target.checked ? '' : h.value }); if (e.target.checked && h.value) setTyped({ ...typed, [i]: h.value }); }} className="accent-[var(--accent)]" />Secret</label>
                  <button aria-label="Remove the header" onClick={() => { setQ({ ...q, headers: q.headers.filter((_, j) => j !== i) }); setTyped(Object.fromEntries(Object.entries(typed).filter(([k]) => Number(k) !== i).map(([k, v]) => [Number(k) > i ? Number(k) - 1 : k, v]))); }}
                    className="w-6 h-6 rounded flex items-center justify-center text-content-faint hover:text-err hover:bg-surface-3"><Icons.X size={12} /></button>
                </div>
              ))}
            </div>
          </div>
          {hasBody && <div>
            <div className="flex items-center"><span className={label}>Body</span>
              {q.body.trim() && !jsonBad && /^[[{]/.test(q.body.trim()) && <button className="ml-auto text-[12px] text-accent hover:underline" onClick={() => setQ({ ...q, body: JSON.stringify(JSON.parse(q.body), null, 2) })}>Format</button>}</div>
            <textarea value={q.body} onChange={(e) => setQ({ ...q, body: e.target.value })} rows={6} spellCheck={false} placeholder={'{ "ping": true }'} aria-label="Body"
              className="mt-1.5 w-full px-2.5 py-2 rounded-md border border-line bg-surface-input font-mono text-[11.5px] leading-snug text-content outline-none focus:border-accent resize-y" />
            <div className={`mt-1 text-[11.5px] ${jsonBad ? 'text-err' : 'text-content-faint'}`}>{jsonBad ? "This isn't valid JSON, so it goes as plain text." : 'Sent as it is. JSON goes with Content-Type: application/json unless a header says otherwise.'}</div>
          </div>}
          {q.method !== 'GET' && q.method !== 'HEAD' && <div className="px-3 py-2 rounded-md border border-warn-border bg-warn-tint text-[12px] text-content-secondary">A check sends exactly this request, maybe to production. Pick an endpoint where a {q.method} changes nothing.</div>}
        </>}
      </div>
    </Modal>
  );
}

// Every address at once. One line per row shown (name, environment, address, with tabs between, which is how a
// spreadsheet copies and pastes): edit them here, paste a sheet's columns over them, or fill them from a pattern.
// A pasted line finds its row by name and environment; with no environment it goes to every row of that name.
function Addresses({ rows, filtered, onClose, onApply }: { rows: { key: string; name: string; env: string; url: string }[]; filtered: boolean; onClose: () => void; onApply: (urls: Map<string, string>) => void }) {
  const T = String.fromCharCode(9);
  const [text, setText] = useState(() => rows.map((x) => [x.name, x.env, x.url].join(T)).join('\n'));
  const [pattern, setPattern] = useState('');
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const p = (l.includes(T) ? l.split(T) : l.includes(',') ? l.split(',') : l.split(/\s+/)).map((c) => c.trim());
    const url = /^https?:\/\//i.test(p[p.length - 1]) ? p[p.length - 1] : '';
    const rest = url ? p.slice(0, -1) : p;
    return { name: rest[0] ?? '', env: rest[1] ?? '', url };
  });
  const urls = new Map<string, string>(); let unknown = 0;
  for (const l of lines) {
    const hit = rows.filter((x) => x.name.toLowerCase() === l.name.toLowerCase() && (!l.env || x.env.toLowerCase() === l.env.toLowerCase()));
    if (!hit.length) unknown++;
    for (const x of hit) urls.set(x.key, l.url);
  }
  const changed = [...urls].filter(([k, u]) => u !== rows.find((x) => x.key === k)!.url).length;
  const fill = (every: boolean) => setText(lines.map((l) => {
    const made = pattern.trim().replace(/\{name\}/gi, l.name).replace(/\{env\}/gi, l.env.toLowerCase());
    return [l.name, l.env, every || !l.url ? made : l.url].join(T);
  }).join('\n'));
  const ok = /^https?:\/\/\S+$/i.test(pattern.trim());
  return (
    <Modal title="Addresses to check" width={820} onCancel={onClose}
      sub={`${rows.length} ${rows.length === 1 ? 'row' : 'rows'}${filtered ? ', the ones the filters show' : ''}`}
      footer={<><span className="mr-auto text-[12px] text-content-faint">{unknown > 0 ? `${unknown} ${unknown === 1 ? 'line matches' : 'lines match'} no row and will be skipped. ` : ''}{changed} {changed === 1 ? 'address changes' : 'addresses change'}.</span>
        <button className={btn} onClick={onClose}>Cancel</button><button className={btnPrimary} disabled={!changed} onClick={() => onApply(urls)}>Apply</button></>}>
      <div className="flex flex-col gap-3">
        <div>
          <div className="text-[12px] font-medium">Fill from a pattern</div>
          <div className="mt-1 flex items-center gap-2">
            <input value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder="https://{env}.example.com/{name}/health" spellCheck={false} aria-label="Address pattern"
              className="flex-1 min-w-0 h-7 px-2 rounded-md border border-line bg-surface-input font-mono text-[11.5px] text-content outline-none focus:border-accent" />
            <button className={btn} disabled={!ok} onClick={() => fill(false)} title="Only the rows with no address yet">Fill the empty ones</button>
            <button className={btn} disabled={!ok} onClick={() => fill(true)}>Fill all</button>
          </div>
          <div className="mt-1 text-[11.5px] text-content-faint"><span className="font-mono">{'{name}'}</span> is the row's name and <span className="font-mono">{'{env}'}</span> its environment in small letters. Filter the table first to fill one environment at a time.</div>
        </div>
        <div>
          <div className="text-[12px] font-medium">Or edit and paste</div>
          <div className="mt-0.5 text-[11.5px] text-content-faint">Name, environment and address on each line, with a tab between them. Copy it into a spreadsheet, fill the last column and paste it back; lines find their row by name and environment.</div>
          <textarea value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} wrap="off" rows={16} aria-label="Addresses, one row per line"
            onKeyDown={(e) => { if (e.key === 'Tab') { e.preventDefault(); const t = e.currentTarget, at = t.selectionStart; setText(text.slice(0, at) + T + text.slice(t.selectionEnd)); requestAnimationFrame(() => { t.selectionStart = t.selectionEnd = at + 1; }); } }}
            className="mt-1.5 w-full px-2.5 py-2 rounded-md border border-line bg-surface-input font-mono text-[11.5px] leading-[1.7] text-content outline-none focus:border-accent resize-y" style={{ tabSize: 34 }} />
        </div>
      </div>
    </Modal>
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
