// The Design Center side of the app (M3), as in the mockups: Connect to Anypoint, Pull from Design Center,
// and in the title bar the branch and "Push N changes" / "Up to date with Design Center".
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { documentDir } from '@tauri-apps/api/path';
import { Icons } from './components/Icons';
import { Modal, TextDialog, btn, btnPrimary } from './App';
import * as S from './sync';

export type Me = { username: string; user_id: string; org_id: string; org_name: string; host: string; mode: string; read_only: boolean };
const REGIONS: [string, string][] = [['US', 'https://anypoint.mulesoft.com'], ['EU', 'https://eu1.anypoint.mulesoft.com']];
const REDIRECT = 'http://localhost:8765/callback';
// Where secrets go, in the words of each system.
const KEYCHAIN = /Windows/.test(navigator.userAgent) ? 'Windows Credential Manager' : /Mac/.test(navigator.userAgent) ? 'the macOS Keychain' : 'the system keyring';
const ago = (t: number) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`; };

// What a notice says about dependencies that couldn't be fetched (fetched ones need no mention).
// Lock while I edit (off by default): the first edit takes the branch's lock in Design Center, as Design Center
// does, and it's let go on Push, on closing the project and on quitting.
export const lockWhileEditing = () => { try { return localStorage.getItem('ads.lockWhileEditing') === '1'; } catch { return false; } };

export const depsNote = (d: { fetched: string[]; failed: string[] }) => d.failed.length
  ? `Some Exchange dependencies couldn't be fetched, so checking may report missing files: ${d.failed.join('; ')}.` : null;

// Connect to Anypoint, then pick a project and where to put it. Opens on the project list when signed in.
export function ConnectDialog({ openRoot, onClose, onPulled }: { openRoot?: string; onClose: () => void; onPulled: (root: string, note: string | null) => void }) {
  const [me, setMe] = useState<Me | null>(null);
  const [step, setStep] = useState<'checking' | 'choose' | 'waiting' | 'projects'>('checking');
  const [way, setWay] = useState<'ours' | 'byok'>('ours');
  const [readOnly, setReadOnly] = useState(true);
  const [acts, setActs] = useState<'user' | 'app'>('user');
  const [region, setRegion] = useState(REGIONS[0][1]);
  const [clientId, setClientId] = useState(''); const [secret, setSecret] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [list, setList] = useState<S.Remote[] | null>(null);
  const [q, setQ] = useState(''); const [pick, setPick] = useState<S.Remote | null>(null);
  const [branchList, setBranchList] = useState<string[]>([]); const [branch, setBranch] = useState('master');
  const [into, setInto] = useState(''); const [busy, setBusy] = useState<string | null>(null);
  const [custom, setCustom] = useState(false);
  // Where each project lives on this computer: its own folder under Documents, found again by its link.
  const [where, setWhere] = useState<Record<string, { root: string; here: boolean }>>({});
  const [report, setReport] = useState<string | null>(null);
  const stop = useRef(false);

  const locate = async (p: S.Remote, org: string) => {
    const safe = (x: string) => x.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/[. ]+$/, '') || 'project';
    const home = (await documentDir()).replace(/\\/g, '/').replace(/\/+$/, '') + `/API Designer Studio/${safe(org)}/`;
    for (const root of [home + safe(p.name), `${home}${safe(p.name)} (${p.id.slice(0, 8)})`]) {
      const l = await S.readLink(root);
      if (l?.projectId === p.id) return { root, here: true };
      if (!l && !(await invoke<{ files: unknown[] }>('open_project', { root }).then((x) => x.files.length, () => 0))) return { root, here: false };
    }
    throw new Error(`Couldn't find a free folder for ${p.name}.`);
  };
  const loadProjects = async (m?: Me) => {
    setStep('projects'); setList(null);
    try {
      const l = await S.projects(); setList(l);
      // Copies pulled into a folder of your own are found through the recent projects list.
      const known = new Map<string, string>();
      let recent: { root: string }[] = []; try { recent = JSON.parse(localStorage.getItem('ads.recent') || '[]'); } catch { /* none */ }
      for (const r of recent) { const k = await S.readLink(r.root); if (k && !known.has(k.projectId)) known.set(k.projectId, r.root); }
      const w: Record<string, { root: string; here: boolean }> = {};
      for (const p of l) w[p.id] = known.has(p.id) ? { root: known.get(p.id)!, here: true } : await locate(p, (m ?? me)?.org_name || 'Anypoint');
      setWhere(w);
    } catch (e) { setErr(String(e)); }
  };
  useEffect(() => {
    invoke<Me | null>('anypoint_status').then((m) => { if (m) { setMe(m); loadProjects(m); } else setStep('choose'); }, (e) => { setErr(String(e)); setStep('choose'); });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!pick) return;
    setBranchList([]); setBranch('master'); setCustom(false);
    S.branches(pick.id).then((b) => { setBranchList(b.map((x) => x.name)); if (!b.some((x) => x.name === 'master') && b[0]) setBranch(b[0].name); }, () => {});
    setInto(where[pick.id]?.root ?? '');
  }, [pick]); // eslint-disable-line react-hooks/exhaustive-deps

  const connect = async () => {
    setErr(null); if (way === 'ours' || acts === 'user') setStep('waiting');
    try {
      const mode = way === 'ours' ? 'anypoint' : acts === 'user' ? 'code' : 'client';
      // __ADS_BROKER and __ADS_HOST: a local broker and stand-in Anypoint for development tests (release builds ignore the broker one).
      const dev = window as unknown as { __ADS_BROKER?: string; __ADS_HOST?: string };
      const m = await invoke<Me>('anypoint_connect', { mode, clientId: clientId.trim(), clientSecret: secret.trim(), host: dev.__ADS_HOST ?? region, broker: dev.__ADS_BROKER ?? null, readOnly });
      setMe(m); setSecret(''); await loadProjects(m);
    } catch (e) { setErr(String(e)); setStep('choose'); }
  };
  const pull = async () => {
    if (!pick || !into.trim()) return;
    // Already on this computer: open it as it is. The title bar offers a Pull when Design Center has more.
    if (!custom && where[pick.id]?.here) { onPulled(where[pick.id].root, null); return; }
    setErr(null); setBusy('Pulling the files…');
    try {
      const root = into.trim().replace(/\\/g, '/');
      // Only into an empty or new folder: a pull never mixes with files already there.
      const existing = await invoke<{ files: unknown[] }>('open_project', { root }).catch(() => null);
      if (existing && existing.files.length) throw new Error('That folder already has files. Pick an empty or new folder.');
      setBusy('Pulling the files and their Exchange dependencies…');
      const r = await S.clone(root, pick.id, pick.name, branch);
      onPulled(root, depsNote(r.deps));
    } catch (e) { setErr(String(e)); setBusy(null); }
  };
  // Every project: new ones into their own folders, ones already here brought up to date (merging, as Pull does).
  // The project open in the window is left to its own Pull button.
  const pullAll = async () => {
    if (!list) return;
    setErr(null); setReport(null); stop.current = false;
    const added: string[] = [], updated: string[] = [], conflicts: string[] = [], failed: string[] = [], skipped: string[] = [];
    for (const [i, p] of list.entries()) {
      if (stop.current) break;
      setBusy(`Pulling ${i + 1} of ${list.length}: ${p.name}…`);
      try {
        const w = where[p.id] ?? await locate(p, me?.org_name || 'Anypoint');
        if (openRoot && w.root.toLowerCase() === openRoot.replace(/\\/g, '/').toLowerCase()) { skipped.push(p.name); continue; }
        if (!w.here) {
          const b = await S.branches(p.id);
          const r = await S.clone(w.root, p.id, p.name, b.some((x) => x.name === 'master') || !b[0] ? 'master' : b[0].name);
          added.push(p.name); if (r.deps.failed.length) failed.push(`${p.name}: some Exchange dependencies (${r.deps.failed.join('; ')})`);
          setWhere((x) => ({ ...x, [p.id]: { root: w.root, here: true } }));
        } else {
          const r = await S.pull(w.root, (await S.readLink(w.root))!);
          if (!r.upToDate) updated.push(p.name);
          if (r.conflicts.length) conflicts.push(p.name);
        }
      } catch (e) { failed.push(`${p.name}: ${String(e).replace(/^Error: /, '')}`); }
    }
    setBusy(null);
    const n = (k: string[], one: string, many: string) => k.length ? `${k.length} ${k.length === 1 ? one : many}` : '';
    setReport([
      stop.current ? 'Stopped.' : 'Done.',
      [n(added, 'new project pulled', 'new projects pulled'), n(updated, 'brought up to date', 'brought up to date')].filter(Boolean).join(', ') || 'Everything was already up to date.',
      conflicts.length ? `Needs a look (both sides changed the same lines): ${conflicts.join(', ')}.` : '',
      skipped.length ? `${skipped.join(', ')} is open in the window, so use Pull in the title bar for it.` : '',
      failed.length ? `Couldn't pull: ${failed.join('; ')}.` : '',
    ].filter(Boolean).join(' '));
  };

  let title = 'Connect to Anypoint', sub: ReactNode = 'Pull projects from Design Center, push your changes back, and publish to Exchange.', body: ReactNode = null, foot: ReactNode = null;
  if (step === 'checking') body = <div className="py-6 text-center text-content-faint text-[12.5px]">Checking the connection…</div>;
  else if (step === 'choose') {
    const ours = way === 'ours', usOnly = ours && region !== REGIONS[0][1];
    const choice = (id: 'ours' | 'byok', t: ReactNode, d: string) => (
      <button onClick={() => setWay(id)} className={`w-full flex gap-2.5 p-2.5 rounded-lg border text-left ${way === id ? 'border-accent-border bg-accent-dim' : 'border-line hover:border-content-ghost'}`}>
        <span className={`mt-0.5 w-3.5 h-3.5 shrink-0 rounded-full border-2 ${way === id ? 'border-accent bg-accent' : 'border-content-ghost'}`} />
        <span><span className="block font-semibold text-[12.5px]">{t}</span><span className="block text-[11.5px] text-content-faint">{d}</span></span>
      </button>
    );
    body = (
      <div className="flex flex-col gap-2.5 text-[12.5px]">
        {choice('ours', <>Sign in with Anypoint <span className="ml-1 text-[10px] font-semibold px-1.5 rounded border border-accent-border text-accent">Recommended</span></>, 'Your usual Anypoint login in the browser, with SSO and MFA. Nothing to set up.')}
        {choice('byok', 'Use your own Connected App', 'For companies that only allow their own. An admin creates it in Access Management.')}
        {!ours && <div className="ml-6 flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-[11.5px] text-content-faint">The app acts</span>
            <div className="flex gap-0.5 p-0.5 rounded-md bg-surface border border-line w-fit">
              {([['user', 'On behalf of a user'], ['app', 'On its own behalf']] as const).map(([id, label]) => (
                <button key={id} onClick={() => setActs(id)} className={`h-6 px-2.5 rounded text-[11.5px] ${acts === id ? 'bg-surface-3 text-content font-semibold' : 'text-content-faint'}`}>{label}</button>
              ))}
            </div>
            <span className="text-[11.5px] text-content-faint leading-snug">{acts === 'user'
              ? <>You sign in in the browser, with SSO and MFA as usual. In the Connected App, add <span className="font-mono text-content-secondary select-text">{REDIRECT}</span> as a redirect URI, and the Full Access and Background Access scopes.</>
              : 'No browser sign-in. Good for shared machines. Give the app the Design Center Developer scope.'}</span>
          </div>
          <div className="flex gap-2">
            <label className="flex-1 flex flex-col gap-1"><span className="text-[11.5px] text-content-faint">Client ID</span>
              <input value={clientId} onChange={(e) => setClientId(e.target.value)} spellCheck={false} placeholder="Paste the client ID" className="h-[28px] px-2 rounded-md border border-line bg-surface-input font-mono text-[12px] outline-none focus:border-accent" /></label>
            <label className="flex-1 flex flex-col gap-1"><span className="text-[11.5px] text-content-faint">Client secret</span>
              <input value={secret} onChange={(e) => setSecret(e.target.value)} type="password" placeholder="Paste the client secret" className="h-[28px] px-2 rounded-md border border-line bg-surface-input font-mono text-[12px] outline-none focus:border-accent" /></label>
          </div>
          <div className="flex items-center gap-1.5 text-[11.5px] text-content-faint"><Icons.Key size={12} />Kept in {KEYCHAIN}, never in a project file.</div>
        </div>}
        <label className="mt-1 flex items-center gap-2.5"><span className="text-[11.5px] text-content-faint">Region</span>
          <select value={region} onChange={(e) => setRegion(e.target.value)} className="h-[26px] px-1.5 rounded-md border border-line bg-surface-input text-[12px]">
            {REGIONS.map(([n, h]) => <option key={h} value={h}>{n}</option>)}
          </select>
          <span className="text-[11.5px] text-content-faint">Where your Anypoint organization lives.</span></label>
        {usOnly && <div className="text-[11.5px] text-warn">Sign in with Anypoint works for organizations in the US region. In another region, use your own Connected App.</div>}
        <label className="mt-1 flex items-start gap-2 cursor-pointer">
          <input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} className="mt-0.5 accent-[var(--accent)]" />
          <span><span className="block text-[12.5px]">Read only</span>
            <span className="block text-[11.5px] text-content-faint">Pull and look, never change anything in Design Center: saving, deleting, locking and new branches are refused before anything is sent. You can turn it off later in settings.</span></span>
        </label>
      </div>
    );
    foot = <><span className="flex-1" /><button className={btn} onClick={onClose}>Cancel</button>
      <button className={btnPrimary} disabled={ours ? usOnly : !clientId.trim() || !secret.trim()} onClick={connect}>{ours || acts === 'user' ? 'Continue in the browser' : 'Connect'}</button></>;
  } else if (step === 'waiting') {
    body = (
      <div className="py-6 flex flex-col items-center gap-2 text-center">
        <span className="w-6 h-6 rounded-full border-2 border-accent border-t-transparent animate-spin" />
        <div className="text-[13.5px] font-semibold">Finish signing in in your browser</div>
        <div className="text-[12px] text-content-faint">This window carries on by itself once you're done.</div>
      </div>
    );
    foot = <><span className="flex-1" /><button className={btn} onClick={onClose}>Cancel</button></>;
  } else {
    title = 'Design Center projects'; sub = undefined;
    const shown = (list ?? []).filter((p) => p.name.toLowerCase().includes(q.trim().toLowerCase()));
    const here = !!pick && !custom && !!where[pick.id]?.here;
    const linkBtn = 'shrink-0 underline hover:text-content';
    body = (
      <div className="flex flex-col gap-3 text-[12.5px]">
        <div className="flex items-center gap-2.5">
          <span className="text-[12px] text-content-secondary">{me?.username}</span>
          <span className="text-[11.5px] text-content-faint">{me?.org_name}</span>
          <span className="flex-1" />
          <label className="flex items-center gap-1.5 h-[26px] w-[200px] px-2 rounded-md bg-surface-2 border border-line text-content-faint focus-within:border-accent-border">
            <Icons.Search size={12} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter projects" spellCheck={false} className="flex-1 min-w-0 bg-transparent outline-none text-[12px] text-content" /></label>
        </div>
        <div className="max-h-[260px] overflow-auto rounded-md border border-line">
          {list == null && !err && <div className="p-4 text-content-faint">Listing your projects…</div>}
          {list != null && shown.length === 0 && <div className="p-4 text-content-faint">{list.length ? 'No project matches.' : 'No projects in Design Center yet.'}</div>}
          {shown.map((p) => (
            <div key={p.id} onClick={() => setPick(p)} onDoubleClick={() => { if (where[p.id]?.here && !busy) onPulled(where[p.id].root, null); }}
              className={`flex items-center gap-2 px-3 py-2 border-b border-line-secondary last:border-b-0 cursor-pointer ${pick?.id === p.id ? 'bg-accent-dim' : 'hover:bg-[var(--hover-overlay)]'}`}>
              <span className="text-content-faint flex"><Icons.ApiSpec size={14} /></span>
              <span className="font-semibold truncate">{p.name}</span>
              {where[p.id]?.here && <span className="text-[10.5px] px-1.5 rounded border border-line text-content-faint whitespace-nowrap" title={where[p.id].root}>On this computer</span>}
              <span className="ml-auto text-[11.5px] text-content-faint whitespace-nowrap">changed {ago(p.updated)}</span>
            </div>
          ))}
        </div>
        {pick && (here ? (
          <div className="flex items-start gap-3 text-[11.5px] text-content-faint">
            <span className="flex-1 min-w-0">Opens your copy in <span className="font-mono select-text break-all">{where[pick.id].root}</span>. If Design Center has newer changes, the title bar offers a Pull.</span>
            <button className={linkBtn} onClick={() => { setCustom(true); setInto(''); }}>Pull into another folder</button>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-2.5"><span className="w-[64px] text-[11.5px] text-content-faint">Branch</span>
              <select value={branch} onChange={(e) => setBranch(e.target.value)} className="h-[26px] px-1.5 rounded-md border border-line bg-surface-input text-[12px]">
                {(branchList.length ? branchList : ['master']).map((x) => <option key={x}>{x}</option>)}
              </select></label>
            {custom ? (
              <label className="flex items-center gap-2.5"><span className="w-[64px] text-[11.5px] text-content-faint">Pull into</span>
                <input value={into} onChange={(e) => setInto(e.target.value)} spellCheck={false} placeholder="An empty or new folder" className="flex-1 h-[28px] px-2 rounded-md border border-line bg-surface-input font-mono text-[12px] outline-none focus:border-accent" />
                <button className={btn} onClick={async () => { const d = await openDialog({ directory: true, title: 'Pull into which folder?' }); if (typeof d === 'string') setInto(d); }}>Browse…</button></label>
            ) : (
              <div className="flex items-start gap-3 text-[11.5px] text-content-faint">
                <span className="flex-1 min-w-0">Goes into <span className="font-mono select-text break-all">{into}</span></span>
                <button className={linkBtn} onClick={() => setCustom(true)}>Pull into another folder</button>
              </div>
            )}
          </div>
        ))}
        {report && <div className="text-[12px] text-content-secondary select-text">{report}</div>}
        <div className="text-[11.5px] text-content-faint">Pulling never locks a project in Design Center.</div>
      </div>
    );
    const pullingAll = !!busy?.includes(' of ');
    foot = <><span className="flex-1 min-w-0 truncate text-[12px] text-content-faint">{busy}</span>
      {pullingAll ? <button className={btn} onClick={() => { stop.current = true; }}>Stop</button> : <button className={btn} onClick={onClose}>Close</button>}
      <button className={btn} disabled={!list?.length || !!busy} onClick={pullAll} title="Pull every project: new ones into their own folders, the ones already here brought up to date">Pull all</button>
      <button className={btnPrimary} disabled={!pick || !into.trim() || !!busy} onClick={pull}>{here ? 'Open' : 'Pull and open'}</button></>;
  }
  return (
    <Modal title={title} sub={sub} onCancel={onClose} width={600} footer={foot}>
      {body}
      {err && <div className="mt-3 text-[12px] text-err select-text">{err}</div>}
    </Modal>
  );
}

// Settings: who's connected, and a way out.
export function AnypointSettings({ onConnect }: { onConnect: () => void }) {
  const [me, setMe] = useState<Me | null | 'error'>(null);
  const [lockOn, setLockOn] = useState(lockWhileEditing);
  useEffect(() => { invoke<Me | null>('anypoint_status').then((m) => setMe(m), () => setMe('error')); }, []);
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-[0.5px] text-content-faint mt-3.5 mb-2">Anypoint</div>
      {me && me !== 'error' ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2 text-[12px]">
            <span className="min-w-0 flex-1"><span className="block truncate">{me.username}</span><span className="block truncate text-[11px] text-content-faint">{me.org_name}</span></span>
            <button className={btn} onClick={async () => { await invoke('anypoint_disconnect'); setMe(null); }}>Sign out</button>
          </div>
          <label className="flex items-center gap-2 text-[12px] cursor-pointer" title="Read only refuses every change to Design Center before it's sent">
            <input type="checkbox" checked={me.read_only} className="accent-[var(--accent)]" onChange={async (e) => {
              const on = e.target.checked;
              // Turning writes on is the one that needs a second look.
              if (!on && !window.confirm(`Let API Designer Studio push changes to Design Center in ${me.org_name || 'this organization'}? Pushing saves files, takes the lock and can delete files there.`)) return;
              await invoke('anypoint_set_read_only', { on }); setMe({ ...me, read_only: on });
            }} />Read only
          </label>
          <label className={`flex items-center gap-2 text-[12px] ${me.read_only ? 'opacity-50' : 'cursor-pointer'}`}
            title={me.read_only ? 'Needs read only off: locking is a change in Design Center' : 'Your first edit locks the branch in Design Center, so others can only read it until you push or close the project'}>
            <input type="checkbox" disabled={me.read_only} checked={lockOn && !me.read_only} className="accent-[var(--accent)]" onChange={(e) => {
              try { localStorage.setItem('ads.lockWhileEditing', e.target.checked ? '1' : '0'); } catch { /* ignore */ }
              setLockOn(e.target.checked);
            }} />Lock while I edit
          </label>
        </div>
      ) : (
        <div className="flex items-center gap-2 text-[12px]">
          <span className="flex-1 text-content-faint">{me === 'error' ? 'The sign-in has expired.' : 'Not connected'}</span>
          <button className={btn} onClick={onConnect}>{me === 'error' ? 'Sign in again' : 'Connect…'}</button>
        </div>
      )}
    </div>
  );
}

// The title bar for a project linked to Design Center: the branch, and what there is to push or pull.
export function SyncBar({ root, dirty, listFiles, saveAll, onNotice, onChanged }: {
  root: string; dirty: number; listFiles: () => Promise<string[]>; saveAll: () => Promise<void>;
  onNotice: (text: string, err: boolean, actions?: [string, () => void][]) => void; onChanged: () => Promise<void>;
}) {
  const [link, setLink] = useState<S.Link | null>(null);
  const [toPush, setToPush] = useState(0);
  const [behind, setBehind] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; branches: string[] } | null>(null);
  const [asking, setAsking] = useState(false);
  const [readOnly, setReadOnly] = useState<boolean | null>(null);
  const [conflicts, setConflicts] = useState(0);
  const [lockedBy, setLockedBy] = useState<string | null>(null);
  const [holding, setHolding] = useState(false);
  const holdingRef = useRef(false); holdingRef.current = holding;
  const lockTried = useRef(0);
  const timer = useRef(0);

  const refresh = async (remote = true) => {
    const l = await S.readLink(root); setLink(l); if (!l) return;
    const ch = await S.localChanges(root, l, await listFiles());
    setToPush(ch.count);
    let marked = 0;
    for (const p of [...ch.added, ...ch.modified]) { const t = await invoke<string>('read_text_file', { root, path: p }).catch(() => ''); marked += t.split(S.MARK).length - 1; }
    setConflicts(marked);
    if (remote) {
      S.remoteState(l).then((r) => { setBehind(r.behind); setLockedBy(r.lockedBy); }, () => {});
      invoke<Me | null>('anypoint_status').then((m) => setReadOnly(!!m?.read_only), () => {});
    }
  };
  // Local changes after every save; Design Center's side every minute and when the window comes back.
  useEffect(() => { refresh(); }, [root]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { clearTimeout(timer.current); timer.current = window.setTimeout(() => refresh(false), 400); }, [dirty]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const t = window.setInterval(() => refresh(), 60000);
    const f = () => refresh();
    window.addEventListener('focus', f);
    return () => { clearInterval(t); window.removeEventListener('focus', f); };
  }, [root]); // eslint-disable-line react-hooks/exhaustive-deps
  // Lock while I edit: the first unsaved edit takes the lock; a lock someone else holds is said once a minute at most.
  useEffect(() => {
    if (!dirty || holding || readOnly !== false || !link || !lockWhileEditing() || Date.now() - lockTried.current < 60000) return;
    lockTried.current = Date.now();
    invoke('anypoint_hold_lock', { project: link.projectId, branch: link.branch })
      .then(() => setHolding(true), (e) => onNotice(`${String(e).replace(/^Error: /, '')} Your changes stay on this computer, and a Pull merges theirs later.`, true));
  }, [dirty, holding, readOnly, link]); // eslint-disable-line react-hooks/exhaustive-deps
  // Closing the project lets the lock go.
  useEffect(() => () => { if (holdingRef.current) invoke('anypoint_release_lock').catch(() => {}); }, []);
  if (!link) return null;

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    try { await saveAll(); await fn(); } catch (e) { onNotice(String(e).replace(/^Error: /, ''), true); }
    finally { setBusy(null); await refresh(); }
  };
  const push = () => run('Pushing…', async () => {
    const r = await S.push(root, (await S.readLink(root))!, await listFiles());
    setHolding(false); lockTried.current = 0;
    onNotice(r.sent ? `Pushed ${r.sent} ${r.sent === 1 ? 'change' : 'changes'} to Design Center.` : 'Nothing to push.', false);
  });
  const pull = () => run('Pulling…', async () => {
    const r = await S.pull(root, (await S.readLink(root))!);
    await onChanged();
    const dn = depsNote(r.deps); if (dn) { onNotice(dn, true); return; }
    if (r.conflicts.length) onNotice(`Pulled. ${r.conflicts.length === 1 ? 'One file needs' : `${r.conflicts.length} files need`} a look: ${r.conflicts.map((c) => c.kind === 'lines' ? `${c.path} (both changed the same lines; the file holds both versions between <<<<<<< and >>>>>>>)` : `${c.path} (${c.kind}, the changed version was kept)`).join('; ')}.`, true);
    else onNotice(r.upToDate ? 'Already up to date.' : `Pulled ${r.updated.length + r.removed.length} ${r.updated.length + r.removed.length === 1 ? 'change' : 'changes'} from Design Center.`, false);
  });
  const openBranches = async (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({ x: r.left + r.width / 2 - 130, y: r.bottom + 4, branches: [] });
    try { setMenu({ x: r.left + r.width / 2 - 130, y: r.bottom + 4, branches: (await S.branches(link.projectId)).map((b) => b.name) }); } catch (err) { setMenu(null); onNotice(String(err), true); }
  };
  const letGo = async () => { if (holding) { await invoke('anypoint_release_lock'); setHolding(false); lockTried.current = 0; } };
  const switchTo = (b: string) => { setMenu(null); run(`Switching to ${b}…`, async () => { await letGo(); const d = await S.switchBranch(root, (await S.readLink(root))!, b, await listFiles()); await onChanged(); onNotice(depsNote(d) ?? `Now on ${b}.`, !!depsNote(d)); }); };
  const newBranch = (name: string) => {
    setAsking(false);
    run('Creating the branch…', async () => { await letGo(); const l = (await S.readLink(root))!; await S.createBranch(l, name); const d = await S.switchBranch(root, l, name, await listFiles()); await onChanged(); onNotice(depsNote(d) ?? `Created ${name} and switched to it.`, !!depsNote(d)); });
  };

  return (
    <>
      <button onClick={openBranches} title="Branches" className="h-7 px-2.5 rounded-md flex items-center gap-1.5 text-[12px] text-content-secondary hover:bg-surface-2">
        <Icons.Branch size={13} /><span>{link.projectName}/<b>{link.branch}</b></span><Icons.ChevronDown size={11} />
      </button>
      <span className="text-[12px] text-content-faint flex items-center gap-2">
        {holding && <span className="flex" title="You hold the lock in Design Center while you edit. It's let go when you push or close the project."><Icons.Lock size={12} /></span>}
        {busy ? <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full border-2 border-accent border-t-transparent animate-spin" />{busy}</span>
          : dirty ? null
          : conflicts ? <span title="Pick Keep mine, Keep theirs or Keep both on each one in the editor, then push">{conflicts} {conflicts === 1 ? 'conflict' : 'conflicts'} to sort out before pushing</span>
          : behind ? <><span>Design Center has changes</span><button onClick={pull} className="h-6 px-2.5 rounded-md text-[12px] font-semibold bg-accent text-accent-ink hover:bg-accent-hover">Pull</button></>
          : toPush && readOnly ? <span title="This connection is read only. Turn it off in settings to push.">Saved on this computer · read only, {toPush} {toPush === 1 ? 'change' : 'changes'} not sent</span>
          : toPush && lockedBy ? <span title="Push when they're done. If they change the same lines, a Pull shows both versions.">Saved on this computer · {lockedBy} is editing in Design Center</span>
          : toPush ? <><span>Saved on this computer</span><button onClick={push} title="Send your saved changes to Design Center" className="h-6 px-2.5 rounded-md text-[12px] font-semibold bg-accent text-accent-ink hover:bg-accent-hover">Push {toPush} {toPush === 1 ? 'change' : 'changes'}</button></>
          : <button onClick={() => run('Checking Design Center…', async () => {})} title="Check Design Center now" className="hover:text-content">Up to date with Design Center</button>}
      </span>
      {menu && (
        <div className="fixed inset-0 z-40" onMouseDown={() => setMenu(null)}>
          <div className="fixed w-[260px] p-1 rounded-lg bg-surface-2 border border-line shadow-[var(--shadow)]" style={{ left: Math.max(8, menu.x), top: menu.y }} onMouseDown={(e) => e.stopPropagation()}>
            <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.5px] text-content-faint">Branches</div>
            {!menu.branches.length && <div className="px-2 py-1.5 text-[12px] text-content-faint">Loading…</div>}
            {menu.branches.map((b) => (
              <button key={b} onClick={() => b !== link.branch && switchTo(b)} className="w-full h-7 px-2 rounded flex items-center gap-2 text-left text-[12.5px] text-content-secondary hover:bg-surface-3 hover:text-content">
                <span className="w-4 flex">{b === link.branch ? <Icons.Dot size={12} /> : null}</span>{b}
              </button>
            ))}
            <div className="my-1 border-t border-line-subtle" />
            {!readOnly && <button onClick={() => { setMenu(null); setAsking(true); }} className="w-full h-7 px-2 rounded text-left text-[12.5px] text-content-secondary hover:bg-surface-3 hover:text-content">New branch…</button>}
          </div>
        </div>
      )}
      {asking && <TextDialog title={`New branch from ${link.branch}`} label="Name" value="" okLabel="Create and switch" hint="Design Center makes it from the branch you're on. Your folder switches to it."
        onCancel={() => setAsking(false)} onOk={(v) => newBranch(v.trim())} />}
    </>
  );
}
