// The Design Center side of the app (M3), as in the mockups: Connect to Anypoint, Pull from Design Center,
// and in the title bar the branch and "Push N changes" / "Up to date with Design Center".
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { windowLabel } from './components/WindowControls';
import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';
import { downloadDir } from '@tauri-apps/api/path';
import { openUrl, revealItemInDir } from '@tauri-apps/plugin-opener';
import { Icons } from './components/Icons';
import { Select } from './components/Popup';
import { ask } from './Brand';
import { Modal, TextDialog, Spinner, btn, btnPrimary } from './App';
import * as S from './sync';
import { AddDependency } from './ExchangeUI';

export type Me = { username: string; user_id: string; org_id: string; org_name: string; host: string; mode: string; read_only: boolean };
// Anypoint's control planes (docs.mulesoft.com/control-planes). Sign in with Anypoint uses our Connected App in
// each cloud listed in clients.json; a cloud without one (US Government) signs in with the organization's own.
const REGIONS: [string, string][] = [['US', 'https://anypoint.mulesoft.com'], ['EU', 'https://eu1.anypoint.mulesoft.com'],
  ['Canada', 'https://ca1.platform.mulesoft.com'], ['United Kingdom', 'https://gb1.platform.mulesoft.com'], ['Japan', 'https://jp1.platform.mulesoft.com'],
  ['India', 'https://in1.platform.mulesoft.com'], ['Australia', 'https://au1.platform.mulesoft.com'], ['US Government', 'https://gov.anypoint.mulesoft.com']];
const REDIRECT = 'http://localhost:8765/callback';
// Where secrets go, in the words of each system.
const KEYCHAIN = /Windows/.test(navigator.userAgent) ? 'Windows Credential Manager' : /Mac/.test(navigator.userAgent) ? 'the macOS Keychain' : 'the system keyring';
const ago = (t: number) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`; };

// What a notice says about dependencies that couldn't be fetched (fetched ones need no mention).
// Lock while I edit (off by default): the first edit takes the branch's lock in Design Center, as Design Center
// does, and it's let go on Push, on closing the project and on quitting.
// Read only off, after a second look (the title bar's "Allow changes", Put in Design Center, and Settings' switch).
export async function allowChanges() {
  const me = await invoke<Me | null>('anypoint_status').catch(() => null);
  if (!me) { window.dispatchEvent(new Event('ads-connect')); return false; }
  if (!me.read_only) return true;
  if (!(await ask(`Let Design Studio push changes to Design Center in ${me.org_name || 'this organization'}? Pushing saves files, takes the lock and can delete files there.`, 'Allow changes'))) return false;
  await invoke('anypoint_set_read_only', { on: false });
  window.dispatchEvent(new Event('ads-signed-in'));
  return true;
}
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
  // Clouds where Sign in with Anypoint works: asked of the broker, so a new one needs no app update.
  const [ourRegions, setOurRegions] = useState<string[]>(['us']);
  useEffect(() => { invoke<string[]>('anypoint_broker_regions').then(setOurRegions, () => {}); }, []);
  const code = (h: string) => (h.match(/\/\/(eu|ca|gb|jp|in|au)1\./)?.[1] ?? 'us');
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
  // Business groups (Design Center's org picker), from who-am-I; shown when there's more than one.
  const [groups, setGroups] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    if (!me) return;
    invoke<{ json: { user?: { memberOfOrganizations?: { id: string; name: string }[] } } }>('anypoint_api', { method: 'GET', path: '/accounts/api/me' })
      .then((r) => setGroups(r.json?.user?.memberOfOrganizations ?? []), () => {});
  }, [me?.user_id]);
  // The picked project's details and actions, as in Design Center's list.
  const [info, setInfo] = useState<{ created: number; owner: string; type: string; perms: S.Perms } | null>(null);
  const [infoErr, setInfoErr] = useState<string | null>(null);
  const [dlg, setDlg] = useState<ReactNode>(null);
  useEffect(() => {
    setInfo(null); setInfoErr(null); if (!pick) return;
    Promise.all([S.projectInfo(pick.id), S.sharedWith(pick.id).catch(() => [] as S.Person[])]).then(([i, sw]) => setInfo({
      created: i.meta.createdDate, type: i.meta.type === 'raml-fragment' ? 'API fragment' : 'API specification', perms: i.perms,
      owner: i.meta.createdBy === me?.user_id ? 'you' : sw.find((x) => x.isOwner)?.name ?? 'someone else',
    }), (e) => setInfoErr(`Couldn't read this project's details: ${String(e).replace(/^Error: /, '')}`));
  }, [pick]);
  const stop = useRef(false);

  const locate = (p: S.Remote, org: string) => S.projectHome(org, p.name, p.id);
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
  }, []);
  useEffect(() => {
    if (!pick) return;
    setBranchList([]); setBranch('master'); setCustom(false);
    S.branches(pick.id).then((b) => { setBranchList(b.map((x) => x.name)); if (!b.some((x) => x.name === 'master') && b[0]) setBranch(b[0].name); }, (e) => setErr(`Couldn't read the branches of ${pick.name}, so only master is offered: ${String(e).replace(/^Error: /, '')}`));
    setInto(where[pick.id]?.root ?? '');
  }, [pick]);

  const connect = async () => {
    setErr(null); if (way === 'ours' || acts === 'user') setStep('waiting');
    try {
      const mode = way === 'ours' ? 'anypoint' : acts === 'user' ? 'code' : 'client';
      // __ADS_BROKER and __ADS_HOST: a local broker and stand-in Anypoint for development tests (release builds ignore the broker one).
      const dev = window as unknown as { __ADS_BROKER?: string; __ADS_HOST?: string };
      const m = await invoke<Me>('anypoint_connect', { mode, clientId: clientId.trim(), clientSecret: secret.trim(), host: dev.__ADS_HOST ?? region, broker: dev.__ADS_BROKER ?? null, readOnly });
      setMe(m); setSecret(''); window.dispatchEvent(new Event('ads-signed-in')); await loadProjects(m);
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
    const ours = way === 'ours', usOnly = ours && !ourRegions.includes(code(region));
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
          <Select value={region} onChange={setRegion} className="text-[12px]" options={REGIONS.map(([n, h]) => ({ value: h, label: n }))} />
          <span className="text-[11.5px] text-content-faint">Where your Anypoint organization lives.</span></label>
        {usOnly && <div className="flex items-center gap-2 px-2.5 py-2 rounded-md border border-[color-mix(in_oklch,var(--warn)_45%,transparent)] bg-[color-mix(in_oklch,var(--warn)_8%,transparent)] text-[11.5px]">
          <span className="flex-1">Sign in with Anypoint isn't available for the {REGIONS.find(([, h]) => h === region)?.[0]} cloud yet (it works in {ourRegions.map((r) => REGIONS.find(([, h]) => code(h) === r)?.[0] ?? r).join(', ')}). Organizations there sign in with their own Connected App, made once by an admin in Access Management.</span>
          <button className={`${btn} !h-6 !text-[11.5px] shrink-0`} onClick={() => setWay('byok')}>Use my own Connected App</button></div>}
        {/* Clouds without Design Center (anypoint.rs, no_design_center): said before signing in, not found out after. */}
        {/gb1\.|in1\.|au1\./.test(region) && <div className="px-2.5 py-2 rounded-md border border-line bg-surface-2 text-[11.5px] text-content-secondary">
          Design Center isn't offered in Anypoint's {REGIONS.find(([, h]) => h === region)?.[0]} cloud, so there are no projects there to pull or push. Exchange, the Dashboard and your projects on this computer all work.</div>}
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
          {groups.length > 1 && me ? (
            <Select value={me.org_id} title="Business group" onChange={async (id) => {
              const g = groups.find((x) => x.id === id)!;
              await invoke('anypoint_set_org', { orgId: g.id, orgName: g.name });
              const m = { ...me, org_id: g.id, org_name: g.name }; setMe(m); setPick(null); loadProjects(m);
            }} className="!h-[24px] text-[11.5px]" options={groups.map((g) => ({ value: g.id, label: g.name }))} />
          ) : <span className="text-[11.5px] text-content-faint">{me?.org_name}</span>}
          <span className="flex-1" />
          <label className="flex items-center gap-1.5 h-[26px] w-[200px] px-2 rounded-md bg-surface-2 border border-line text-content-faint focus-within:border-accent-border">
            <Icons.Search size={12} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter projects" spellCheck={false} className="flex-1 min-w-0 bg-transparent outline-none text-[12px] text-content" /></label>
        </div>
        <div className="max-h-[260px] overflow-auto rounded-md border border-line">
          {list == null && !err && <div className="p-4 flex items-center gap-2 text-content-muted"><Spinner />Listing your projects…</div>}
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
        {pick && (
          <div className="flex items-center gap-2 text-[11.5px] text-content-faint">
            <span className="flex-1 min-w-0 truncate">{info ? `${info.type}, created ${new Date(info.created).toLocaleDateString()} by ${info.owner}` : <span className="inline-flex items-center gap-1.5"><Spinner size={10} />Reading the details…</span>}</span>
            {([['Share…', 'canShare', () => setDlg(<ShareDialog projectId={pick.id} name={pick.name} org={me!.org_id} onClose={() => setDlg(null)} onSaved={(t) => { setDlg(null); setReport(t); }} />)],
              ['Rename…', 'canRename', () => setDlg(<TextDialog title="Rename project" label="Name in Design Center" value={pick.name} okLabel="Rename" onCancel={() => setDlg(null)}
                onOk={async (v) => { setDlg(null); try { await S.renameProject(pick.id, v); setReport(`Renamed to ${v}.`); setPick({ ...pick, name: v }); await loadProjects(); } catch (e) { setErr(String(e)); } }} />)],
              ['Delete…', 'canDelete', () => setDlg(<DeleteProject name={pick.name} onCancel={() => setDlg(null)} onOk={async (alsoHere) => {
                setDlg(null);
                try {
                  await S.deleteProject(pick.id);
                  const w = where[pick.id];
                  if (alsoHere && w?.here && w.root !== openRoot?.replace(/\\/g, '/')) { const r = w.root.replace(/\/+$/, ''); await invoke('delete_file', { root: r.slice(0, r.lastIndexOf('/')), path: r.slice(r.lastIndexOf('/') + 1) }); }
                  setReport(`Deleted ${pick.name} from Design Center.`); setPick(null); await loadProjects();
                } catch (e) { setErr(String(e)); }
              }} />)],
            ] as const).map(([label, perm, fn]) => {
              const off = me?.read_only ? 'The connection is read only. Turn it off in settings.' : info && info.perms[perm] === false ? "Your Design Center permissions don't allow it." : !info ? (infoErr ?? 'Reading permissions…') : null;
              return <button key={label} title={off ?? undefined} onClick={off ? () => setErr(`${label.replace(/…$/, '')}: ${off}`) : fn} className={`shrink-0 hover:text-content underline ${off ? 'no-underline opacity-50' : ''} ${label === 'Delete…' ? 'text-err' : ''}`}>{label}</button>;
            })}
            <button className="shrink-0 flex items-center gap-1 hover:text-content underline" onClick={() => me && openUrl(S.projectUrls(me.host, me.org_id, pick.id).web)}><Icons.DesignCenter size={13} />Open in Design Center</button>
          </div>
        )}
        {dlg}
        {pick && (here ? (
          <div className="flex items-start gap-3 text-[11.5px] text-content-faint">
            <span className="flex-1 min-w-0">Opens your copy in <span className="font-mono select-text break-all">{where[pick.id].root}</span>. If Design Center has newer changes, the title bar offers a Pull.</span>
            <button className={linkBtn} onClick={() => { setCustom(true); setInto(''); }}>Pull into another folder</button>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-2.5"><span className="w-[64px] text-[11.5px] text-content-faint">Branch</span>
              <Select value={branch} onChange={setBranch} className="min-w-[160px] text-[12px]" options={(branchList.length ? branchList : ['master']).map((x) => ({ value: x }))} /></label>
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
    foot = <><span className="flex-1 min-w-0 flex items-center gap-2 text-[12px] text-content-muted">{busy && <><Spinner /><span className="truncate">{busy}</span></>}</span>
      {pullingAll ? <button className={btn} onClick={() => { stop.current = true; }}>Stop</button> : <button className={btn} onClick={onClose}>Close</button>}
      <button className={btn} disabled={!list?.length || !!busy} onClick={pullAll} title="Pull every project: new ones into their own folders, the ones already here brought up to date">Pull all</button>
      <button className={btnPrimary} disabled={!pick || !into.trim() || !!busy} onClick={pull}>{here ? 'Open' : 'Pull and open'}</button></>;
  }
  return (
    <Modal title={title} sub={sub} onCancel={onClose} width={600} footer={foot}>
      {body}
      {err && <div className="mt-3 text-[12px] text-err select-text">{err}
        {/* Blocked networks: the way out is the user's own Connected App, which talks only to Anypoint. */}
        {/Couldn't reach the sign-in service/.test(err) && way === 'ours' && <button className={`${btn} ml-2 !h-6 !text-[11.5px]`} onClick={() => { setWay('byok'); setErr(null); setStep('choose'); }}>Use my own Connected App</button>}
      </div>}
    </Modal>
  );
}

// Settings: who's connected, and a way out.
// The title bar for a project linked to Design Center: the branch, and what there is to push or pull.
export function SyncBar({ root, dirty, listFiles, saveAll, onNotice, onChanged, onPublish }: {
  root: string; dirty: number; listFiles: () => Promise<string[]>; saveAll: () => Promise<void>;
  onNotice: (text: string, err: boolean, actions?: [string, () => void][]) => void; onChanged: () => Promise<void>; onPublish: () => void;
}) {
  const [link, setLink] = useState<S.Link | null>(null);
  const [toPush, setToPush] = useState(0);
  const [review, setReview] = useState(false);
  const [behind, setBehind] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; branches: string[] } | null>(null);
  useEffect(() => { if (!menu) return; const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [menu]);
  const [asking, setAsking] = useState(false);
  const [readOnly, setReadOnly] = useState<boolean | null>(null);
  const [conflicts, setConflicts] = useState(0);
  const [lockedBy, setLockedBy] = useState<string | null>(null);
  const [holding, setHolding] = useState(false);
  const [perms, setPerms] = useState<S.Perms>({}); // a Viewer can't push or publish
  const holdingRef = useRef(false); holdingRef.current = holding;
  const lockTried = useRef(0);
  const timer = useRef(0);
  // While publishing, Design Center rewrites exchange.json and the app pulls it back at the end: in between it
  // looks a change ahead, so nothing is checked until the publish is over.
  const publishing = useRef(false);
  // The checks run from a timer and window events set up once per project, so they read these, not old state.
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty;
  const busyRef = useRef(busy); busyRef.current = busy;
  const autoPull = useRef<() => void>(() => {});

  const refresh = async (remote = true) => {
    if (publishing.current) return;
    const l = await S.readLink(root); setLink(l); if (!l) return;
    const ch = await S.localChanges(root, l, await listFiles());
    setToPush(ch.count);
    let marked = 0;
    for (const p of [...ch.added, ...ch.modified]) { const t = await invoke<string>('read_text_file', { root, path: p }).catch(() => ''); marked += t.split(S.MARK).length - 1; }
    setConflicts(marked);
    if (remote) {
      S.remoteState(l).then((r) => {
        setBehind(r.behind); setLockedBy(r.lockedBy);
        // Design Center moved and nothing here differs from what was last pulled or pushed (no unsaved edit, no
        // saved change to push): take theirs straight away. With changes here, Pull stays a button, as before.
        if (r.behind && !ch.count && !dirtyRef.current && !busyRef.current && !publishing.current) autoPull.current();
      }, () => {});
      S.projectPermissions(l.projectId).then(setPerms, () => {});
      invoke<Me | null>('anypoint_status').then((m) => setReadOnly(!!m?.read_only), () => {});
    }
  };
  // Local changes after every save; Design Center's side every minute and when the window comes back.
  useEffect(() => { refresh(); }, [root]);
  useEffect(() => { clearTimeout(timer.current); timer.current = window.setTimeout(() => refresh(false), 400); }, [dirty]);
  useEffect(() => {
    const t = window.setInterval(() => refresh(), 60000);
    const f = () => refresh();
    const local = () => refresh(false);
    const pub = (e: Event) => { publishing.current = (e as CustomEvent<boolean>).detail; if (!publishing.current) { setBehind(false); setHolding(false); lockTried.current = 0; refresh(); } }; // publish lets the lock go too
    window.addEventListener('focus', f); window.addEventListener('ads-files-changed', local); window.addEventListener('ads-publishing', pub);
    return () => { clearInterval(t); window.removeEventListener('focus', f); window.removeEventListener('ads-files-changed', local); window.removeEventListener('ads-publishing', pub); };
  }, [root]);
  // Lock while I edit: the first unsaved edit takes the lock; a lock someone else holds is said once a minute at most.
  useEffect(() => {
    if (!dirty || holding || readOnly !== false || !link || !lockWhileEditing() || Date.now() - lockTried.current < 60000) return;
    lockTried.current = Date.now();
    invoke('anypoint_hold_lock', { project: link.projectId, branch: link.branch })
      .then(() => setHolding(true), (e) => onNotice(`${String(e).replace(/^Error: /, '')} Your changes stay on this computer, and a Pull merges theirs later.`, true));
  }, [dirty, holding, readOnly, link]);
  // Closing the project lets the lock go.
  useEffect(() => () => { if (holdingRef.current) invoke('anypoint_release_lock').catch(() => {}); }, []);
  // The keep-alive failed twice (the network dropped): the lock has lapsed in Design Center, so the mark goes and it's said.
  useEffect(() => {
    const un = listen<{ win?: string }>('lock-lost', (e) => {
      if (e.payload.win && e.payload.win !== windowLabel) return;
      setHolding(false); lockTried.current = 0;
      onNotice("Design Center couldn't be reached, so your lock on the branch has lapsed. Your changes are safe here, and the lock is taken again with your next edit.", true);
    });
    return () => { un.then((f) => f()); };
  }, []);
  // Only on this computer: one quiet button says so and offers the way into Design Center (the project menu holds its dialog).
  if (!link) return (
    <button onClick={() => window.dispatchEvent(new Event('ads-put-in-dc'))} title="This project is only on this computer. Give it a Design Center project of its own, linked to this folder."
      className="h-7 px-2.5 rounded-md flex items-center gap-1.5 text-[12px] text-content-faint hover:bg-surface-2 hover:text-content"><Icons.DesignCenter size={14} />Put in Design Center…</button>
  );

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    try { await saveAll(); await fn(); } catch (e) { onNotice(String(e).replace(/^Error: /, ''), true); }
    finally { setBusy(null); await refresh(); }
  };
  const push = () => run('Pushing…', async () => {
    // Push lets the lock go whether it works or not, so the lock mark goes either way.
    const r = await S.push(root, (await S.readLink(root))!, await listFiles()).finally(() => { setHolding(false); lockTried.current = 0; });
    // Files that aren't text (images, PDFs) can't go through Design Center's save call: named, not dropped quietly.
    const left = r.binary.length ? ` Not sent: ${r.binary.join(', ')}. ${r.binary.length === 1 ? "It isn't" : "They aren't"} text, so add ${r.binary.length === 1 ? 'it' : 'them'} with Import in Design Center.` : '';
    onNotice((r.sent ? `Pushed ${r.sent} ${r.sent === 1 ? 'change' : 'changes'} to Design Center.` : 'Nothing to push.') + left, !!left);
  });
  const pull = (auto = false) => run('Pulling…', async () => {
    // A pull by itself checks again first: an edit made since the check means it's left to the button.
    if (auto && (dirtyRef.current || (await S.localChanges(root, (await S.readLink(root))!, await listFiles())).count)) return;
    const r = await S.pull(root, (await S.readLink(root))!);
    await onChanged();
    if (auto && r.upToDate) return;
    if (auto && !r.conflicts.length && !depsNote(r.deps)) { onNotice(`Pulled ${r.updated.length + r.removed.length} ${r.updated.length + r.removed.length === 1 ? 'change' : 'changes'} from Design Center by itself: nothing here was changed.`, false); return; }
    const dn = depsNote(r.deps); if (dn) { onNotice(dn, true); return; }
    if (r.conflicts.length) onNotice(`Pulled. ${r.conflicts.length === 1 ? 'One file needs' : `${r.conflicts.length} files need`} a look: ${r.conflicts.map((c) => c.kind === 'lines' ? `${c.path} (both changed the same lines; the file holds both versions between <<<<<<< and >>>>>>>)` : c.kind === 'binary' ? `${c.path} (changed on both sides and not text, so yours was kept)` : `${c.path} (${c.kind}, the changed version was kept)`).join('; ')}.`, true);
    else onNotice(r.upToDate ? 'Already up to date.' : `Pulled ${r.updated.length + r.removed.length} ${r.updated.length + r.removed.length === 1 ? 'change' : 'changes'} from Design Center.`, false);
  });
  autoPull.current = () => { pull(true); };
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
      <button onClick={openBranches} title={`Branches (${link.projectName}/${link.branch})`} className="h-7 px-2.5 min-w-[90px] shrink rounded-md flex items-center gap-1.5 text-[12px] text-content-secondary whitespace-nowrap hover:bg-surface-2">
        <Icons.Branch size={13} className="shrink-0" /><span className="truncate min-w-0">{link.projectName}/<b>{link.branch}</b></span><Icons.ChevronDown size={11} className="shrink-0" />
      </button>
      <span className="text-[12px] text-content-faint flex items-center gap-2 whitespace-nowrap min-w-0 shrink-[3] [&>span]:truncate [&>span]:min-w-0 [&>button]:shrink-0">
        {holding && <span className="flex" title="You hold the lock in Design Center while you edit. It's let go when you push or close the project."><Icons.Lock size={12} /></span>}
        {busy ? <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full border-2 border-accent border-t-transparent animate-spin" />{busy}</span>
          : dirty ? null
          : conflicts ? <span title="Pick Keep mine, Keep theirs or Keep both on each one in the editor, then push">{conflicts} {conflicts === 1 ? 'conflict' : 'conflicts'} to sort out before pushing</span>
          : behind ? <><span>Design Center has changes</span><button onClick={() => pull()} className="h-6 px-2.5 rounded-md text-[12px] font-semibold bg-accent text-accent-ink hover:bg-accent-hover">Pull</button></>
          : toPush && readOnly ? <><span title="Saved on this computer. The connection is read only, so nothing is sent to Design Center.">Saved on this computer · read only, <button onClick={() => setReview(true)} title="See what would be sent to Design Center" className="underline decoration-dotted underline-offset-2 hover:text-content">{toPush} {toPush === 1 ? 'change' : 'changes'} not sent</button></span>
            <button onClick={async () => { if (await allowChanges()) refresh(); }} title="The connection is read only, so nothing is sent to Design Center. Allow changes to push, lock and publish."
              className="h-6 px-2.5 rounded-md text-[12px] font-semibold border border-accent-border text-accent hover:bg-accent-dim">Allow changes…</button></>
          : toPush && perms.canModify === false ? <span title="Design Center shares this project with you as a Viewer. Your changes stay on this computer.">Saved on this computer · view only in Design Center</span>
          : toPush && lockedBy ? <span title="Push when they're done. If they change the same lines, a Pull shows both versions.">Saved on this computer · {lockedBy} is editing in Design Center</span>
          : toPush ? <><span>Saved on this computer</span><button onClick={() => setReview(true)} title="See what will be sent to Design Center, then push" className="h-6 px-2.5 rounded-md text-[12px] font-semibold bg-accent text-accent-ink hover:bg-accent-hover">Push {toPush} {toPush === 1 ? 'change' : 'changes'}</button></>
          : <button onClick={() => run('Checking Design Center…', async () => {})} title="Check Design Center now" className="hover:text-content">Up to date with Design Center</button>}
      </span>
      <button onClick={onPublish} disabled={!!busy || perms.canPublish === false} title={perms.canPublish === false ? "Your Design Center permissions don't allow publishing this project." : readOnly ? 'This connection is read only. Turn it off in settings to publish.' : 'Publish this project to Exchange'}
        className="h-7 px-2.5 shrink-0 whitespace-nowrap rounded-md flex items-center gap-1.5 text-[12px] text-accent border border-accent-border hover:bg-accent-dim disabled:opacity-50">
        <Icons.Exchange size={14} />Publish
      </button>
      {review && <ReviewPush root={root} link={link} listFiles={listFiles} readOnly={readOnly !== false} lockedBy={lockedBy} onClose={() => setReview(false)}
        onPush={() => { setReview(false); push(); }} onAllow={async () => { if (await allowChanges()) refresh(); }} />}
      {menu && (
        <div className="fixed inset-0 z-40" onMouseDown={() => setMenu(null)}>
          <div className="fixed w-[260px] p-1 rounded-lg bg-surface-2 border border-line shadow-[var(--shadow)]" style={{ left: Math.max(8, menu.x), top: menu.y }} onMouseDown={(e) => e.stopPropagation()}>
            <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.5px] text-content-faint">Branches</div>
            {!menu.branches.length && <div className="px-2 py-1.5 flex items-center gap-2 text-[12px] text-content-muted"><Spinner size={10} />Reading branches…</div>}
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

// ---------- The project menu (Design Center's gear menu), in the title bar ----------
export function ProjectMenu({ root, name, onNotice, onOpen, onGone, onChanged }: {
  root: string; name: string; onNotice: (text: string, err: boolean) => void; onOpen: (root: string) => void; onGone: () => void; onChanged: () => void;
}) {
  const [at, setAt] = useState<DOMRect | null>(null);
  useEffect(() => { if (!at) return; const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setAt(null); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [at]);
  const [st, setSt] = useState<{ link: S.Link | null; me: Me | null; perms: S.Perms } | null>(null);
  const [dlg, setDlg] = useState<ReactNode>(null);
  const open = async (r: DOMRect) => {
    setAt(r); setSt(null);
    const [link, me] = await Promise.all([S.readLink(root), invoke<Me | null>('anypoint_status').catch(() => null)]);
    setSt({ link, me, perms: link && me ? await S.projectPermissions(link.projectId).catch(() => ({})) : {} });
  };
  const run = async (fn: () => Promise<string | void>) => { try { const t = await fn(); if (t) onNotice(t, false); } catch (e) { onNotice(String(e).replace(/^Error: /, ''), true); } };
  // Put in Design Center: the title bar's button for a project that's only here (signs in or allows changes first, if needed).
  useEffect(() => {
    const f = async () => {
      if (await S.readLink(root) || !(await allowChanges())) return;
      setDlg(<PutInDesignCenter root={root} name={name} onClose={() => setDlg(null)} onDone={(t) => { setDlg(null); window.dispatchEvent(new Event('ads-files-changed')); onChanged(); onNotice(t, false); }} />);
    };
    window.addEventListener('ads-put-in-dc', f);
    return () => window.removeEventListener('ads-put-in-dc', f);
  }, [root, name]);
  const l = st?.link, me = st?.me, p = st?.perms ?? {};
  const why = (can?: boolean) => (!l ? 'This folder isn\'t linked to a Design Center project.' : !me ? 'Sign in to Anypoint first.' : me.read_only ? 'The connection is read only. Turn it off in settings.' : can === false ? 'Your Design Center permissions don\'t allow it on this project.' : null);
  const urls = l && me ? S.projectUrls(me.host, me.org_id, l.projectId) : null;
  // Import, as Design Center's gear menu: files or a zip, one file from a URL, or an asset from Exchange.
  const importFiles = () => run(async () => {
    const picked = await openDialog({ multiple: true, title: 'Import files or a zip into this project' });
    const paths = Array.isArray(picked) ? picked : typeof picked === 'string' ? [picked] : [];
    if (!paths.length) return;
    let r = await invoke<{ written: string[]; existing: string[] }>('import_into', { root, folder: '', sources: paths, overwrite: false });
    if (r.existing.length) {
      if (!(await ask(`${r.existing.length === 1 ? r.existing[0] + ' is' : r.existing.length + ' files are'} already in the project${r.existing.length > 1 ? ` (${r.existing.slice(0, 5).join(', ')}${r.existing.length > 5 ? '…' : ''})` : ''}. Replace?`, 'Replace'))) return;
      r = await invoke('import_into', { root, folder: '', sources: paths, overwrite: true });
    }
    onChanged();
    return `Imported ${r.written.length} ${r.written.length === 1 ? 'file' : 'files'}.`;
  });
  const items: [string, string | null, () => void][] = !st ? [] : [
    ['Import file or zip…', null, importFiles],
    ['Import from URL…', null, () => setDlg(<UrlImport root={root} onClose={() => setDlg(null)} onDone={(t) => { setDlg(null); onChanged(); onNotice(t, false); }} />)],
    ['Import from Exchange…', me ? null : 'Sign in to Anypoint first.', () => setDlg(<AddDependency importing onClose={() => setDlg(null)} onAdd={(d) => { setDlg(null); run(async () => {
      // A folder with that name is already here: ask, and send the old one to the trash rather than deleting it.
      if (await invoke('open_project', { root: `${root}/${d.assetId}` }).then(() => true, () => false)) {
        if (!(await ask(`The project already has a ${d.assetId} folder. Replace it? The old one goes to the ${TRASH}.`, 'Replace'))) return '';
        await invoke('delete_file', { root, path: d.assetId });
      }
      onNotice(`Importing ${d.assetId} ${d.version}…`, false);
      const n = await invoke<number>('anypoint_fetch_dependency', { root, group: d.groupId, asset: d.assetId, version: d.version, published: null, into: d.assetId });
      onChanged();
      return `Imported ${d.assetId} ${d.version}: ${n} ${n === 1 ? 'file' : 'files'} in ${d.assetId}/.`;
    }); }} />)],
    ['Rename project…', why(p.canRename), () => setDlg(<TextDialog title="Rename project" label="Name in Design Center" value={l!.projectName} okLabel="Rename" hint="Only the name in Design Center changes. The folder on this computer stays where it is."
      onCancel={() => setDlg(null)} onOk={(v) => { setDlg(null); run(async () => {
        await S.renameProject(l!.projectId, v);
        await invoke('write_file_exact', { root, path: '.apidesigner/link.json', text: JSON.stringify({ ...l!, projectName: v }, null, 2) + '\n' });
        window.dispatchEvent(new Event('ads-files-changed'));
        return `Renamed to ${v} in Design Center.`;
      }); }} />)],
    ['Duplicate project…', why(), () => setDlg(<TextDialog title="Duplicate project" label="Name of the copy" value={`${l!.projectName} copy`} okLabel="Duplicate" hint="A new Design Center project with these files, pulled into its own folder."
      onCancel={() => setDlg(null)} onOk={(v) => { setDlg(null); run(async () => { onNotice(`Making ${v} in Design Center…`, false); const dest = await S.duplicateProject(root, v, me!.org_name || 'Anypoint'); onOpen(dest); }); }} />)],
    ['Share…', why(p.canShare), () => setDlg(<ShareDialog projectId={l!.projectId} name={l!.projectName} org={me!.org_id} onClose={() => setDlg(null)} onSaved={(t) => { setDlg(null); onNotice(t, false); }} />)],
    ['Download as zip…', null, () => run(async () => {
      const dest = await saveDialog({ title: 'Download as zip', defaultPath: `${(await downloadDir()).replace(/[\\/]+$/, '')}/${name}.zip`, filters: [{ name: 'Zip', extensions: ['zip'] }] });
      if (!dest) return;
      const n = await invoke<number>('export_zip', { root, dest });
      return `Saved ${n} files to ${dest}.`;
    })],
    ['Copy Git URL', l ? (urls ? null : 'Sign in to Anypoint first.') : 'This folder isn\'t linked to a Design Center project.', () => run(async () => { await navigator.clipboard.writeText(urls!.git); return 'Copied the Git URL. Pushing to it with git doesn\'t reach Design Center: use Push here.'; })],
    ['Open in Design Center', urls ? null : l ? 'Sign in to Anypoint first.' : 'This folder isn\'t linked to a Design Center project.', () => openUrl(urls!.web)],
    ['Show in folder', null, () => run(async () => { await revealItemInDir(root); })],
    ['Delete project…', why(p.canDelete), () => setDlg(<DeleteProject name={l!.projectName} onCancel={() => setDlg(null)} onOk={(alsoHere) => { setDlg(null); run(async () => {
      await S.deleteProject(l!.projectId);
      if (alsoHere) { const r = root.replace(/[\\/]+$/, ''); await invoke('delete_file', { root: r.slice(0, r.search(/[\\/][^\\/]*$/)), path: r.split(/[\\/]/).pop() }); onGone(); return `Deleted ${l!.projectName} from Design Center, and moved this copy to the ${TRASH}.`; }
      await invoke('delete_file', { root, path: '.apidesigner' }).catch(() => {});
      window.dispatchEvent(new Event('ads-files-changed'));
      return `Deleted ${l!.projectName} from Design Center. This copy stays here, no longer linked.`;
    }); }} />)],
  ];
  return (
    <>
      <button title="Project" onClick={(e) => (at ? setAt(null) : open(e.currentTarget.getBoundingClientRect()))} className="w-6 h-6 rounded flex items-center justify-center text-content-faint hover:bg-surface-2 hover:text-content"><Icons.More size={14} /></button>
      {at && (
        <div className="fixed inset-0 z-40" onMouseDown={() => setAt(null)}>
          <div className="fixed w-[230px] p-1 rounded-lg bg-surface-2 border border-line shadow-[var(--shadow)]" style={{ left: at.left, top: at.bottom + 4 }} onMouseDown={(e) => e.stopPropagation()}>
            {!st && <div className="px-2 py-1.5 flex items-center gap-2 text-[12px] text-content-muted"><Spinner size={10} />Checking what you can do…</div>}
            {items.map(([label, off, fn], i) => (
              <div key={label}>
                {['Import file or zip…', 'Rename project…', 'Download as zip…', 'Delete project…'].includes(label) && i > 0 && <div className="my-1 border-t border-line-subtle" />}
                <button title={off ?? undefined} onClick={() => { setAt(null); if (off) onNotice(`${label.replace(/…$/, '')}: ${off}`, false); else fn(); }}
                  className={`w-full h-7 px-2 flex items-center gap-2 rounded text-left text-[12.5px] hover:bg-surface-3 ${off ? '!text-content-ghost' : ''} ${label.startsWith('Delete') ? 'text-err' : 'text-content-secondary hover:text-content'}`}>
                  <span className="flex-1">{label}</span>{label === 'Open in Design Center' && <Icons.DesignCenter size={14} />}</button>
              </div>
            ))}
          </div>
        </div>
      )}
      {dlg}
    </>
  );
}
export const TRASH = /Windows/.test(navigator.userAgent) ? 'Recycle Bin' : 'Trash';

// Put in Design Center: a name Design Center doesn't have yet (it refuses the same name), checked as you type
// against the org's projects; a taken name gets a free one suggested.
function PutInDesignCenter({ root, name, onClose, onDone }: { root: string; name: string; onClose: () => void; onDone: (text: string) => void }) {
  const [v, setV] = useState(name);
  const [taken, setTaken] = useState<Set<string> | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    // The name it was created with (exchange.json), not the folder's, which may carry a suffix.
    Promise.all([S.projects(), S.readDescriptor(root)]).then(([list, x]) => {
      const t = new Set(list.map((p) => p.name)); setTaken(t);
      const want = (x?.d.name || name).trim(); setV(want);
      if (t.has(want)) { let n = 2; while (t.has(`${want} ${n}`)) n++; setV(`${want} ${n}`); setNote(`Design Center already has ${want}, so this suggests a free name.`); }
    }, (e) => setErr(String(e).replace(/^Error: /, '')));
  }, []);
  const n = v.trim();
  const clash = !!taken?.has(n);
  const go = async () => {
    setBusy(true); setErr(null);
    try { await S.putInDesignCenter(root, n); onDone(`${n} is in Design Center now. Publish is in the title bar.`); }
    catch (e) { setErr(String(e).replace(/^Error: /, '')); setBusy(false); }
  };
  const ok = !!n && !!taken && !clash && !busy;
  return (
    <Modal title="Put in Design Center" sub="So you can push, pull and publish it" onCancel={onClose} width={480}
      footer={<><span className="flex-1 flex items-center gap-2 text-[12px] text-content-muted">{busy && <><Spinner />Making it and sending the files…</>}</span>
        <button className={btn} onClick={onClose}>Cancel</button><button className={btnPrimary} disabled={!ok} onClick={go}>Put in Design Center</button></>}>
      <div className="flex flex-col gap-3 text-[12.5px]">
        <label className="flex flex-col gap-1"><span className="text-[11.5px] text-content-faint">Name in Design Center</span>
          <input autoFocus value={v} onChange={(e) => { setV(e.target.value); setNote(null); }} onKeyDown={(e) => { if (e.key === 'Enter' && ok) go(); }} spellCheck={false}
            className={`h-[28px] px-2 rounded-md border bg-surface-input font-mono text-[12px] outline-none focus:border-accent ${clash ? 'border-err' : 'border-line'}`} /></label>
        {!taken && !err && <span className="flex items-center gap-2 text-[11.5px] text-content-faint"><Spinner size={10} />Reading your Design Center projects…</span>}
        {clash ? <span className="text-[11.5px] text-err">Design Center already has a project called {n}. Pick another name.</span>
          : note && <span className="text-[11.5px] text-content-faint">{note}</span>}
        <span className="text-[11.5px] text-content-faint">A new Design Center project gets every file here, and this folder stays where it is, linked to it.</span>
        {err && <div className="text-[12px] text-err select-text">{err}</div>}
      </div>
    </Modal>
  );
}

// Import from URL: one file, named after the address unless renamed.
function UrlImport({ root, onClose, onDone }: { root: string; onClose: () => void; onDone: (text: string) => void }) {
  const [url, setUrl] = useState(''); const [file, setFile] = useState(''); const [named, setNamed] = useState(false);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const guess = (u: string) => decodeURIComponent(u.split(/[?#]/)[0].split('/').filter(Boolean).pop() ?? '').replace(/[<>:"\\|?*]/g, '-');
  const go = async () => {
    setBusy(true); setErr(null);
    try {
      const text = await invoke<string>('fetch_url', { url: url.trim() });
      const exists = await invoke<string>('read_text_file', { root, path: file.trim() }).then(() => true, () => false);
      if (exists && !(await ask(`${file.trim()} is already in the project. Replace it?`, 'Replace'))) { setBusy(false); return; }
      await invoke('write_file_exact', { root, path: file.trim(), text });
      onDone(`Imported ${file.trim()}. Files it includes aren't fetched: import them too, or fix the paths.`);
    } catch (e) { setErr(String(e).replace(/^Error: /, '')); setBusy(false); }
  };
  const field = 'h-[28px] px-2 rounded-md border border-line bg-surface-input font-mono text-[12px] outline-none focus:border-accent';
  return (
    <Modal title="Import from URL" sub="One file, as in Design Center" onCancel={onClose} width={520}
      footer={<><span className="flex-1" /><button className={btn} onClick={onClose}>Cancel</button><button className={btnPrimary} disabled={!url.trim() || !file.trim() || busy} onClick={go}>{busy ? <span className="flex items-center gap-2"><Spinner />Fetching…</span> : 'Import'}</button></>}>
      <div className="flex flex-col gap-3 text-[12.5px]">
        <label className="flex flex-col gap-1"><span className="text-[11.5px] text-content-faint">Address</span>
          <input autoFocus value={url} onChange={(e) => { setUrl(e.target.value); if (!named) setFile(guess(e.target.value)); }} placeholder="https://…/api.raml" spellCheck={false} className={field} /></label>
        <label className="flex flex-col gap-1"><span className="text-[11.5px] text-content-faint">Save as</span>
          <input value={file} onChange={(e) => { setFile(e.target.value); setNamed(true); }} spellCheck={false} className={field} /></label>
        {err && <div className="text-[12px] text-err select-text">{err}</div>}
      </div>
    </Modal>
  );
}

function DeleteProject({ name, onCancel, onOk }: { name: string; onCancel: () => void; onOk: (alsoHere: boolean) => void }) {
  const [also, setAlso] = useState(false);
  const [typed, setTyped] = useState('');
  return (
    <Modal title="Delete project" onCancel={onCancel} footer={<><button className={btn} onClick={onCancel}>Cancel</button>
      <button className={`${btnPrimary} !bg-err`} disabled={typed.trim() !== name} onClick={() => onOk(also)}>Delete</button></>}>
      <div className="flex flex-col gap-3 text-[12.5px]">
        <div><b>{name}</b> goes from Design Center for everyone it's shared with, with all its branches. That can't be undone there. Assets already in Exchange stay.</div>
        <label className="flex flex-col gap-1"><span className="text-[11.5px] text-content-faint">Type the project's name to confirm</span>
          <input value={typed} onChange={(e) => setTyped(e.target.value)} spellCheck={false} className="h-[28px] px-2 rounded-md border border-line bg-surface-input font-mono text-[12px] outline-none focus:border-accent" /></label>
        <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={also} onChange={(e) => setAlso(e.target.checked)} className="accent-[var(--accent)]" />Also move my copy on this computer to the {TRASH}</label>
      </div>
    </Modal>
  );
}

// ---------- Share (Design Center's: Viewer, Editor, Admin, Remove Access, for people and teams) ----------
export function ShareDialog({ projectId, name, org, onClose, onSaved }: { projectId: string; name: string; org: string; onClose: () => void; onSaved: (text: string) => void }) {
  const [list, setList] = useState<S.Person[] | null>(null);
  const [orig, setOrig] = useState<Record<string, string>>({});
  const [q, setQ] = useState(''); const [found, setFound] = useState<S.Person[]>([]);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  useEffect(() => { S.sharedWith(projectId).then((l) => { setList(l); setOrig(Object.fromEntries(l.map((x) => [x.id, x.role ?? '']))); }, (e) => setErr(String(e))); }, [projectId]);
  useEffect(() => {
    if (q.trim().length < 2) { setFound([]); return; }
    const t = setTimeout(() => S.findPeople(org, q.trim()).then((f) => { setFound(f); setErr(null); }, (e) => setErr(`Couldn't search for people: ${String(e).replace(/^Error: /, '')}`)), 250);
    return () => clearTimeout(t);
  }, [q, org]);
  const ROLES: [string, string][] = [['VIEWER', 'Viewer'], ['EDITOR', 'Editor'], ['ADMIN', 'Admin'], ['REMOVE_ACCESS', 'Remove access']];
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const changed = list!.filter((x) => !x.isOwner && x.role !== orig[x.id]);
      const shared = changed.filter((x) => x.role !== 'REMOVE_ACCESS').map((x) => ({ id: x.id, role: x.role!, type: x.type }));
      const revoked = changed.filter((x) => x.role === 'REMOVE_ACCESS' && orig[x.id]).map((x) => ({ id: x.id, role: orig[x.id], type: x.type }));
      if (shared.length || revoked.length) await S.saveShare(projectId, shared, revoked);
      onSaved(shared.length || revoked.length ? `Sharing for ${name} saved.` : 'Nothing changed.');
    } catch (e) { setErr(String(e).replace(/^Error: /, '')); setBusy(false); }
  };
  return (
    <Modal title={`Share ${name}`} onCancel={onClose} width={520} footer={<><button className={btn} onClick={onClose}>Cancel</button><button className={btnPrimary} disabled={!list || busy} onClick={save}>Save</button></>}>
      <div className="flex flex-col gap-3 text-[12.5px]">
        <div className="relative">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Add people or teams by name" spellCheck={false} className="w-full h-[28px] px-2 rounded-md border border-line bg-surface-input text-[12.5px] outline-none focus:border-accent" />
          {found.filter((f) => !list?.some((x) => x.id === f.id)).length > 0 && (
            <div className="absolute left-0 right-0 top-full mt-1 z-10 max-h-[180px] overflow-auto p-1 rounded-lg bg-surface-2 border border-line shadow-[var(--shadow)]">
              {found.filter((f) => !list?.some((x) => x.id === f.id)).map((f) => (
                <button key={f.id} onClick={() => { setList([...(list ?? []), { ...f, role: 'VIEWER' }]); setQ(''); }} className="w-full px-2 py-1.5 rounded text-left hover:bg-surface-3">
                  <span className="font-semibold">{f.name}</span> <span className="text-[11.5px] text-content-faint">{f.type === 'team' ? 'team' : f.username ?? f.email}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="max-h-[260px] overflow-auto rounded-md border border-line">
          {!list && !err && <div className="p-3 flex items-center gap-2 text-content-muted"><Spinner />Reading who has access…</div>}
          {list?.map((x) => (
            <div key={x.id} className="flex items-center gap-2 px-3 py-2 border-b border-line-secondary last:border-b-0">
              <span className="min-w-0 flex-1"><span className="block font-semibold truncate">{x.name}</span><span className="block text-[11.5px] text-content-faint truncate">{x.type === 'team' ? 'Team' : x.username ?? x.email}</span></span>
              {x.isOwner ? <span className="text-[12px] text-content-faint">Owner</span> : (
                <Select value={x.role ?? ''} onChange={(role) => setList(list.map((y) => (y.id === x.id ? { ...y, role } : y)))} className="text-[12px]" options={ROLES.map(([v, label]) => ({ value: v, label }))} />
              )}
            </div>
          ))}
        </div>
        <div className="text-[11.5px] text-content-faint">Saved in Design Center, the same as sharing there. Transfer ownership is only in Design Center.</div>
        {err && <div className="text-[12px] text-err select-text">{err}</div>}
      </div>
    </Modal>
  );
}

// Review before pushing: every file the push sends to Design Center, with what changed in it against the copy
// last pulled or pushed. Push is here, so nothing goes without being seen first.
function ReviewPush({ root, link, listFiles, readOnly, lockedBy, onClose, onPush, onAllow }: {
  root: string; link: S.Link; listFiles: () => Promise<string[]>; readOnly: boolean; lockedBy: string | null;
  onClose: () => void; onPush: () => void; onAllow: () => void;
}) {
  const [files, setFiles] = useState<S.FileDiff[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  useEffect(() => {
    (async () => {
      try {
        const l = (await S.readLink(root)) ?? link;
        const f = await S.pushPreview(root, l, await listFiles());
        setFiles(f); setOpen(new Set(f.slice(0, 3).map((x) => x.path)));
      } catch (e) { setErr(String(e).replace(/^Error: /, '')); }
    })();
  }, []);
  const n = (k: S.FileDiff['status']) => files?.filter((f) => f.status === k).length ?? 0;
  const summary = files && [n('modified') && `${n('modified')} changed`, n('added') && `${n('added')} added`, n('deleted') && `${n('deleted')} deleted`].filter(Boolean).join(', ');
  const tag: Record<S.FileDiff['status'], string> = { modified: 'text-accent', added: 'text-ok', deleted: 'text-err' };
  const binaries = files?.filter((f) => f.binary && f.status !== 'deleted') ?? [];
  return (
    <Modal title="Review changes" width={900} onCancel={onClose}
      sub={<>What a push sends to <b>{link.projectName}</b> on <b>{link.branch}</b> in Design Center{files ? `: ${files.length} ${files.length === 1 ? 'file' : 'files'}${summary ? ` (${summary})` : ''}` : ''}.</>}
      footer={<>
        <span className="mr-auto text-[12px] text-content-muted">
          {readOnly ? 'The connection is read only, so nothing is sent until you allow changes.' : lockedBy ? `${lockedBy} is editing in Design Center; push when they're done.` : 'Push holds the branch lock while it sends, as Design Center does.'}
        </span>
        <button className={btn} onClick={onClose}>Close</button>
        {readOnly ? <button className={btnPrimary} onClick={onAllow}>Allow changes…</button>
          : <button className={btnPrimary} disabled={!files?.length || !!lockedBy} onClick={onPush}>Push {files?.length ?? ''} {files?.length === 1 ? 'file' : 'files'}</button>}
      </>}>
      {err ? <div className="text-[12px] text-err select-text">{err}</div>
        : !files ? <div className="flex items-center gap-2 text-[12px] text-content-faint"><Spinner />Comparing with the copy last synced…</div>
        : !files.length ? <div className="text-[12.5px] text-content-muted">Nothing to push: every file matches Design Center's copy.</div>
        : <div className="flex flex-col gap-2 max-h-[62vh] overflow-auto pr-1">
          {binaries.length > 0 && <div className="text-[12px] text-warn">Not sent (Design Center's save takes text only): {binaries.map((b) => b.path).join(', ')}</div>}
          {files.map((f) => {
            const on = open.has(f.path);
            const changed = f.hunks.flat().filter((d) => d.kind !== ' ').length;
            return (
              // shrink-0: in the scrolling column a file's box would otherwise be squeezed to fit, cutting off its lines.
              <div key={f.path} className="shrink-0 rounded-md border border-line overflow-hidden">
                <button onClick={() => { const s = new Set(open); if (on) s.delete(f.path); else s.add(f.path); setOpen(s); }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-left text-[12.5px] bg-surface-2 hover:bg-surface-3">
                  <Icons.ChevronDown size={11} className={on ? '' : '-rotate-90'} />
                  <span className={`text-[11px] font-semibold uppercase tracking-wide w-[64px] ${tag[f.status]}`}>{f.status === 'modified' ? 'changed' : f.status}</span>
                  <span className="font-mono truncate min-w-0 flex-1">{f.path}</span>
                  <span className="text-[11px] text-content-faint">{f.binary ? 'binary' : `${changed} ${changed === 1 ? 'line' : 'lines'}`}</span>
                </button>
                {on && !f.binary && <div className="font-mono text-[11.5px] leading-[1.6] overflow-x-auto select-text">
                  {f.hunks.map((h, i) => (
                    <div key={i} className={i ? 'border-t border-dashed border-line' : ''}>
                      {h.map((d, k) => (
                        <div key={k} className={`flex whitespace-pre ${d.kind === '+' ? 'bg-ok-tint' : d.kind === '-' ? 'bg-err-tint' : ''}`}>
                          <span className="w-10 shrink-0 text-right pr-2 text-content-faint select-none">{d.old ?? ''}</span>
                          <span className="w-10 shrink-0 text-right pr-2 text-content-faint select-none">{d.now ?? ''}</span>
                          <span className={`w-4 shrink-0 select-none ${d.kind === '+' ? 'text-ok' : d.kind === '-' ? 'text-err' : 'text-content-faint'}`}>{d.kind}</span>
                          <span className="pr-3">{d.text}</span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>}
              </div>
            );
          })}
        </div>}
    </Modal>
  );
}
