// The Design Center side of the app (M3), as in the mockups: Connect to Anypoint, Pull from Design Center,
// and in the title bar the branch and "Push N changes" / "Up to date with Design Center".
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { documentDir } from '@tauri-apps/api/path';
import { Icons } from './components/Icons';
import { Modal, TextDialog, btn, btnPrimary } from './App';
import * as S from './sync';

export type Me = { username: string; user_id: string; org_id: string; org_name: string; host: string; mode: string };
const REGIONS: [string, string][] = [['US', 'https://anypoint.mulesoft.com'], ['EU', 'https://eu1.anypoint.mulesoft.com']];
const REDIRECT = 'http://localhost:8765/callback';
// Where secrets go, in the words of each system.
const KEYCHAIN = /Windows/.test(navigator.userAgent) ? 'Windows Credential Manager' : /Mac/.test(navigator.userAgent) ? 'the macOS Keychain' : 'the system keyring';
const ago = (t: number) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`; };

// What a notice says about dependencies that couldn't be fetched (fetched ones need no mention).
export const depsNote = (d: { fetched: string[]; failed: string[] }) => d.failed.length
  ? `Some Exchange dependencies couldn't be fetched, so checking may report missing files: ${d.failed.join('; ')}.` : null;

// Connect to Anypoint, then pick a project and where to put it. Opens on the project list when signed in.
export function ConnectDialog({ onClose, onPulled }: { onClose: () => void; onPulled: (root: string, note: string | null) => void }) {
  const [me, setMe] = useState<Me | null>(null);
  const [step, setStep] = useState<'checking' | 'choose' | 'waiting' | 'projects'>('checking');
  const [way, setWay] = useState<'ours' | 'byok'>('ours');
  const [acts, setActs] = useState<'user' | 'app'>('user');
  const [region, setRegion] = useState(REGIONS[0][1]);
  const [clientId, setClientId] = useState(''); const [secret, setSecret] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [list, setList] = useState<S.Remote[] | null>(null);
  const [q, setQ] = useState(''); const [pick, setPick] = useState<S.Remote | null>(null);
  const [branchList, setBranchList] = useState<string[]>([]); const [branch, setBranch] = useState('master');
  const [into, setInto] = useState(''); const [busy, setBusy] = useState<string | null>(null);

  const loadProjects = async () => { setStep('projects'); setList(null); try { setList(await S.projects()); } catch (e) { setErr(String(e)); } };
  useEffect(() => {
    invoke<Me | null>('anypoint_status').then((m) => { if (m) { setMe(m); loadProjects(); } else setStep('choose'); }, (e) => { setErr(String(e)); setStep('choose'); });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!pick) return;
    setBranchList([]); setBranch('master');
    S.branches(pick.id).then((b) => { setBranchList(b.map((x) => x.name)); if (!b.some((x) => x.name === 'master') && b[0]) setBranch(b[0].name); }, () => {});
    documentDir().then((d) => setInto(`${d.replace(/[\\/]+$/, '')}${d.includes('\\') ? '\\' : '/'}${pick.name}`), () => setInto(pick.name));
  }, [pick]);

  const connect = async () => {
    setErr(null); if (way === 'ours' || acts === 'user') setStep('waiting');
    try {
      const mode = way === 'ours' ? 'anypoint' : acts === 'user' ? 'code' : 'client';
      // __ADS_BROKER and __ADS_HOST: a local broker and stand-in Anypoint for development tests (release builds ignore the broker one).
      const dev = window as unknown as { __ADS_BROKER?: string; __ADS_HOST?: string };
      const m = await invoke<Me>('anypoint_connect', { mode, clientId: clientId.trim(), clientSecret: secret.trim(), host: dev.__ADS_HOST ?? region, broker: dev.__ADS_BROKER ?? null });
      setMe(m); setSecret(''); await loadProjects();
    } catch (e) { setErr(String(e)); setStep('choose'); }
  };
  const pull = async () => {
    if (!pick || !into.trim()) return;
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
    title = 'Pull from Design Center'; sub = undefined;
    const shown = (list ?? []).filter((p) => p.name.toLowerCase().includes(q.trim().toLowerCase()));
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
            <div key={p.id} onClick={() => setPick(p)} className={`flex items-center gap-2 px-3 py-2 border-b border-line-secondary last:border-b-0 cursor-pointer ${pick?.id === p.id ? 'bg-accent-dim' : 'hover:bg-[var(--hover-overlay)]'}`}>
              <span className="text-content-faint flex"><Icons.ApiSpec size={14} /></span>
              <span className="font-semibold truncate">{p.name}</span>
              <span className="ml-auto text-[11.5px] text-content-faint whitespace-nowrap">changed {ago(p.updated)}</span>
            </div>
          ))}
        </div>
        {pick && (
          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-2.5"><span className="w-[64px] text-[11.5px] text-content-faint">Branch</span>
              <select value={branch} onChange={(e) => setBranch(e.target.value)} className="h-[26px] px-1.5 rounded-md border border-line bg-surface-input text-[12px]">
                {(branchList.length ? branchList : ['master']).map((b) => <option key={b}>{b}</option>)}
              </select></label>
            <label className="flex items-center gap-2.5"><span className="w-[64px] text-[11.5px] text-content-faint">Pull into</span>
              <input value={into} onChange={(e) => setInto(e.target.value)} spellCheck={false} className="flex-1 h-[28px] px-2 rounded-md border border-line bg-surface-input font-mono text-[12px] outline-none focus:border-accent" />
              <button className={btn} onClick={async () => { const d = await openDialog({ directory: true, title: 'Pull into which folder?' }); if (typeof d === 'string') setInto(d); }}>Browse…</button></label>
            <div className="text-[11.5px] text-content-faint">Pulling never locks the project. The lock is only taken while you push.</div>
          </div>
        )}
      </div>
    );
    foot = <><span className="flex-1 text-[12px] text-content-faint">{busy}</span><button className={btn} onClick={onClose}>Cancel</button>
      <button className={btnPrimary} disabled={!pick || !into.trim() || !!busy} onClick={pull}>Pull and open</button></>;
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
  useEffect(() => { invoke<Me | null>('anypoint_status').then((m) => setMe(m), () => setMe('error')); }, []);
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-[0.5px] text-content-faint mt-3.5 mb-2">Anypoint</div>
      {me && me !== 'error' ? (
        <div className="flex items-center gap-2 text-[12px]">
          <span className="min-w-0 flex-1"><span className="block truncate">{me.username}</span><span className="block truncate text-[11px] text-content-faint">{me.org_name}</span></span>
          <button className={btn} onClick={async () => { await invoke('anypoint_disconnect'); setMe(null); }}>Sign out</button>
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
  const timer = useRef(0);

  const refresh = async (remote = true) => {
    const l = await S.readLink(root); setLink(l); if (!l) return;
    setToPush((await S.localChanges(root, l, await listFiles())).count);
    if (remote) S.remoteState(l).then((r) => setBehind(r.behind), () => {});
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
  if (!link) return null;

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    try { await saveAll(); await fn(); } catch (e) { onNotice(String(e).replace(/^Error: /, ''), true); }
    finally { setBusy(null); await refresh(); }
  };
  const push = () => run('Pushing…', async () => {
    const r = await S.push(root, (await S.readLink(root))!, await listFiles());
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
  const switchTo = (b: string) => { setMenu(null); run(`Switching to ${b}…`, async () => { const d = await S.switchBranch(root, (await S.readLink(root))!, b, await listFiles()); await onChanged(); onNotice(depsNote(d) ?? `Now on ${b}.`, !!depsNote(d)); }); };
  const newBranch = (name: string) => {
    setAsking(false);
    run('Creating the branch…', async () => { const l = (await S.readLink(root))!; await S.createBranch(l, name); const d = await S.switchBranch(root, l, name, await listFiles()); await onChanged(); onNotice(depsNote(d) ?? `Created ${name} and switched to it.`, !!depsNote(d)); });
  };

  return (
    <>
      <button onClick={openBranches} title="Branches" className="h-7 px-2.5 rounded-md flex items-center gap-1.5 text-[12px] text-content-secondary hover:bg-surface-2">
        <Icons.Branch size={13} /><span>{link.projectName}/<b>{link.branch}</b></span><Icons.ChevronDown size={11} />
      </button>
      <span className="text-[12px] text-content-faint flex items-center gap-2">
        {busy ? <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full border-2 border-accent border-t-transparent animate-spin" />{busy}</span>
          : dirty ? null
          : behind ? <><span>Design Center has changes</span><button onClick={pull} className="h-6 px-2.5 rounded-md text-[12px] font-semibold bg-accent text-accent-ink hover:bg-accent-hover">Pull</button></>
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
            <button onClick={() => { setMenu(null); setAsking(true); }} className="w-full h-7 px-2 rounded text-left text-[12.5px] text-content-secondary hover:bg-surface-3 hover:text-content">New branch…</button>
          </div>
        </div>
      )}
      {asking && <TextDialog title={`New branch from ${link.branch}`} label="Name" value="" okLabel="Create and switch" hint="Design Center makes it from the branch you're on. Your folder switches to it."
        onCancel={() => setAsking(false)} onOk={(v) => newBranch(v.trim())} />}
    </>
  );
}
