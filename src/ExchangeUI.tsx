// M4: Publish to Exchange, and the Dependencies and Exchange panels on the left rail, as in the mockups.
// Everything Anypoint goes through sync.ts; the panels read exchange.json, which works offline too.
import { useEffect, useState, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { Icons } from './components/Icons';
import { Select } from './components/Popup';
import { Modal, Spinner, btn, btnPrimary } from './App';
import { Badge, type AmfModel } from './Inspector';
import type { Me } from './SyncUI';
import * as S from './sync';
import * as G from './governance';

const ago = (t: number) => { const m = Math.round((Date.now() - t) / 60000); return !t ? '' : m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`; };
const status = () => invoke<Me | null>('anypoint_status').catch(() => null);
const exchangeUrl = (me: Me | null, g: string, a: string) => `${me?.host ?? 'https://anypoint.mulesoft.com'}/exchange/${g}/${a}/`;
const life = (s: string) => (
  <span className={`text-[10px] font-semibold px-1.5 rounded border whitespace-nowrap ${s === 'published' ? 'border-[color-mix(in_oklch,var(--ok)_40%,transparent)] text-ok' : s === 'development' ? 'border-[color-mix(in_oklch,var(--warn)_40%,transparent)] text-warn' : 'border-line text-content-faint'}`}>
    {s === 'published' ? 'Stable' : s === 'development' ? 'Development' : s === 'deprecated' ? 'Deprecated' : s}
  </span>
);
const H = ({ children }: { children: ReactNode }) => <div className="mt-4 mb-1.5 text-[10px] font-semibold uppercase tracking-[0.5px] text-content-faint">{children}</div>;
const MULESOFT = '68ef9520-24e9-4cf2-b2f5-620025690913'; // MuleSoft's own organization, where its public assets live
const Note = ({ children }: { children: ReactNode }) => <div className="text-[12px] text-content-faint leading-relaxed">{children}</div>;

// ---------- Publish to Exchange ----------
export function PublishDialog({ root, main, paths, errors, model, version, unsaved, saveAll, onClose, onDone, onShowErrors }: {
  root: string; main: string | null; paths: () => Promise<string[]>; errors: number; model: AmfModel | null; version?: string; unsaved: number; saveAll: () => Promise<void>;
  onClose: () => void; onDone: (text: string) => void; onShowErrors: () => void;
}) {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [linked, setLinked] = useState<boolean | null>(null);
  const [d, setD] = useState<S.Descriptor | null>(null);
  const [versions, setVersions] = useState<S.Version[] | null>(null);
  const [v, setV] = useState(version ?? '');
  const [apiVersion, setApiVersion] = useState(model?.version?.v || 'v1');
  const [dev, setDev] = useState(false);
  const [groups, setGroups] = useState<{ id: string; name: string }[]>([]);
  const [group, setGroup] = useState(''); const [name, setName] = useState(''); const [assetId, setAssetId] = useState('');
  const [step, setStep] = useState<number | null>(null); const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<{ text: string; pushed: number } | null>(null);
  const busy = step != null && !done;

  useEffect(() => {
    (async () => {
      const m = await status(); setMe(m);
      setLinked(!!(await S.readLink(root)));
      const x = await S.readDescriptor(root); if (!x) { setVersions([]); return; }
      setD(x.d); setGroup(x.d.groupId); setName(x.d.name); setAssetId(x.d.assetId);
      if (!m) return;
      // Business groups this user can publish to, from who-am-I.
      invoke<{ json: { user?: { memberOfOrganizations?: { id: string; name: string }[] } } }>('anypoint_api', { method: 'GET', path: '/accounts/api/me' })
        .then((r) => setGroups(r.json?.user?.memberOfOrganizations ?? []), () => {});
      try {
        const a = await S.assetVersions(x.d.groupId, x.d.assetId, x.d.version);
        const vs = a?.versions ?? []; setVersions(vs);
        // Design Center's rule: the last published version plus a patch, or the project's version the first time.
        if (!version) setV(vs[0] ? S.bump(vs[0].version, 'patch') : x.d.version || '1.0.0');
      } catch (e) { setErr(String(e)); setVersions([]); if (!version) setV(x.d.version || '1.0.0'); }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const taken = versions?.find((x) => x.version === v.trim());
  const bad = !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(v.trim()) ? 'Use a version like 1.2.0.' : taken?.status === 'published' ? `${v.trim()} is already in Exchange as Stable. Stable versions can't be published again.` : null;
  const blocked = me === null ? 'Sign in to Anypoint to publish.' : me?.read_only ? 'read only'
    : linked === false ? 'Publishing goes through Design Center: pull this project from Design Center to publish it.' : !d ? 'This project has no exchange.json, so it has no Exchange asset to publish as.' : null;
  const go = async () => {
    setErr(null); setStep(0);
    window.dispatchEvent(new CustomEvent('ads-publishing', { detail: true }));
    try {
      // Exchange gets what Design Center has, so unsaved edits are saved here first, then pushed by publish.
      await saveAll();
      const r = await S.publish(root, await paths(), { name: name.trim(), assetId: assetId.trim(), groupId: group, version: v.trim(), apiVersion: apiVersion.trim() || 'v1', main: main ?? d!.main ?? '', classifier: d!.classifier ?? 'raml', development: dev }, setStep);
      setDone({ text: `Published ${v.trim()} to Exchange${dev ? ' as Development' : ''}.${r.pushed ? ` Your ${r.pushed} ${r.pushed === 1 ? 'change was' : 'changes were'} pushed first.` : ''}`, pushed: r.pushed });
    } catch (e) { setErr(String(e).replace(/^Error: /, '')); setStep(null); }
    finally { window.dispatchEvent(new CustomEvent('ads-publishing', { detail: false })); }
  };
  const spin = <span className="w-3.5 h-3.5 shrink-0 rounded-full border-2 border-accent border-t-transparent animate-spin" />;
  const field = 'h-[28px] px-2 rounded-md border border-line bg-surface-input text-[12.5px] outline-none focus:border-accent disabled:opacity-60';
  const last = versions?.[0];
  return (
    // While publishing there's nothing to cancel (Design Center has the request); once done, closing reloads the project.
    <Modal title="Publish to Exchange" sub={d ? `${d.name}` : undefined} onCancel={done ? () => onDone(done.text) : busy ? () => {} : onClose} width={520}
      footer={done ? <>
        <button className={btn} onClick={() => openUrl(exchangeUrl(me ?? null, group, assetId.trim()) + v.trim() + '/')}>Open in Exchange</button>
        <button className={btnPrimary} onClick={() => onDone(done.text)}>Done</button></>
      : <><button className={btn} disabled={busy} onClick={onClose}>Cancel</button>
        <button className={`${btnPrimary} flex items-center gap-2`} disabled={!!blocked || !!errors || !!bad || busy || versions == null && !!me || !name.trim() || !assetId.trim()} onClick={go}>
          {busy && <span className="w-3 h-3 rounded-full border-2 border-current border-t-transparent animate-spin" />}{busy ? 'Publishing…' : 'Publish to Exchange'}</button></>}>
      {done ? (
        <div className="flex flex-col items-center text-center gap-2 py-4">
          <span className="w-11 h-11 rounded-full flex items-center justify-center bg-[color-mix(in_oklch,var(--ok)_15%,transparent)] text-ok"><Icons.Check size={24} /></span>
          <div className="text-[14px] font-semibold">Published to Exchange</div>
          <div className="text-[12.5px] text-content-secondary max-w-[400px]">
            {name.trim()} {v.trim()} is in Exchange{dev ? ' as a Development version' : ''}.{done.pushed ? ` Your ${done.pushed} ${done.pushed === 1 ? 'change was' : 'changes were'} saved to Design Center first.` : ''}
          </div>
        </div>
      ) : busy ? (
        <div className="flex flex-col gap-2.5 py-2 text-[12.5px]">
          <div className="text-content-secondary mb-1">Publishing {v.trim()}{dev ? ' as Development' : ''}. This can take a minute, so keep this window open.</div>
          {['Saving your changes to Design Center', 'Publishing to Exchange', 'Waiting for Exchange to list the new version', "Pulling Design Center's updated exchange.json"].map((t, i) => (
            <div key={t} className={`flex items-center gap-2.5 ${i > step! ? 'text-content-faint' : i === step ? 'text-content font-medium' : 'text-content-secondary'}`}>
              {i < step! ? <span className="w-3.5 h-3.5 shrink-0 flex items-center justify-center text-ok"><Icons.Check size={14} /></span> : i === step ? spin : <span className="w-3.5 h-3.5 shrink-0 rounded-full border-2 border-line" />}{t}
            </div>
          ))}
        </div>
      ) : me === undefined || (me && versions == null && !err) || (me && d === null && linked === null) ? (
        <div className="flex items-center gap-2.5 py-6 justify-center text-[12.5px] text-content-muted"><Spinner size={14} />Reading this API's versions from Exchange…</div>
      ) : (
      <div className="flex flex-col gap-3 text-[12.5px]">
        {!!errors && <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-[color-mix(in_oklch,var(--err)_30%,transparent)] bg-[color-mix(in_oklch,var(--err)_8%,transparent)]">
          <span className="flex-1">{errors} {errors === 1 ? 'error' : 'errors'} to fix first. Exchange won't accept a spec with errors.</span><button className={btn} onClick={onShowErrors}>Show</button></div>}
        {!!unsaved && !blocked && <div className="px-3 py-2 rounded-lg border border-accent-border bg-accent-dim text-content-secondary">{unsaved} unsaved {unsaved === 1 ? 'file' : 'files'}: {unsaved === 1 ? "it's" : "they're"} saved and sent to Design Center first, so Exchange gets what you see.</div>}
        {blocked === 'read only' ? (
          <div className="px-3 py-2.5 rounded-lg border-2 border-err bg-[color-mix(in_oklch,var(--err)_10%,transparent)]">
            <div className="flex items-center gap-2 font-semibold text-err"><Icons.Lock size={14} />Can't publish: this connection is read only</div>
            <div className="mt-1 text-content-secondary">Read only stops the app from changing anything in Anypoint. To publish, turn it off:</div>
            <ol className="mt-1.5 ml-4 list-decimal text-content-secondary leading-relaxed">
              <li>Close this window.</li>
              <li>Click <span className="inline-flex align-[-2px] text-content"><Icons.Sliders size={14} /></span> <b className="text-content">Settings</b> at the bottom left.</li>
              <li>Under Anypoint, untick <b className="text-content">Read only</b> and confirm.</li>
              <li>Click Publish again.</li>
            </ol>
          </div>
        ) : blocked && <div className="px-3 py-2.5 rounded-lg border-2 border-[color-mix(in_oklch,var(--warn)_60%,transparent)] bg-[color-mix(in_oklch,var(--warn)_8%,transparent)] text-content">{blocked}</div>}
        <div className="flex gap-2.5">
          <label className="flex-1 flex flex-col gap-1"><span className="text-[11.5px] text-content-faint">Asset version</span>
            <input value={v} onChange={(e) => setV(e.target.value)} spellCheck={false} className={`${field} font-mono`} />
            <span className={`text-[11.5px] ${bad && v ? 'text-err' : 'text-content-faint'}`}>{bad && v ? bad : last ? `Last published ${last.version}${last.status === 'development' ? ' (Development)' : ''}.` : versions ? 'First version in Exchange.' : ''}</span></label>
          <label className="w-[120px] flex flex-col gap-1"><span className="text-[11.5px] text-content-faint">API version</span>
            <input value={apiVersion} onChange={(e) => setApiVersion(e.target.value)} spellCheck={false} className={`${field} font-mono`} /></label>
        </div>
        <div className="flex flex-col gap-1"><span className="text-[11.5px] text-content-faint">Lifecycle state</span>
          <div className="flex gap-0.5 p-0.5 rounded-md bg-surface border border-line w-fit">
            {([[false, 'Stable'], [true, 'Development']] as const).map(([x, label]) => (
              <button key={label} onClick={() => setDev(x)} className={`h-6 px-2.5 rounded text-[11.5px] ${dev === x ? 'bg-surface-3 text-content font-semibold' : 'text-content-faint'}`}>{label}</button>
            ))}
          </div>
          <span className="text-[11.5px] text-content-faint">{dev ? 'A Development version can be published again with changes.' : "A Stable version can't be changed once published."}</span></div>
        <details>
          <summary className="cursor-pointer text-[12px] text-content-muted">Advanced</summary>
          <div className="mt-2.5 flex flex-col gap-2.5">
            <label className="flex flex-col gap-1"><span className="text-[11.5px] text-content-faint">Business group</span>
              <Select value={group} onChange={setGroup} className="w-full !h-[28px] text-[12.5px]"
                options={(groups.some((g) => g.id === group) ? groups : [{ id: group, name: me?.org_name ?? group }, ...groups]).map((g) => ({ value: g.id, label: g.name }))} /></label>
            <div className="flex gap-2.5">
              <label className="flex-1 flex flex-col gap-1"><span className="text-[11.5px] text-content-faint">Asset name</span><input value={name} onChange={(e) => setName(e.target.value)} className={field} /></label>
              <label className="flex-1 flex flex-col gap-1"><span className="text-[11.5px] text-content-faint">Asset ID</span><input value={assetId} onChange={(e) => setAssetId(e.target.value)} spellCheck={false} className={`${field} font-mono`} /></label>
            </div>
          </div>
        </details>
        {err && <div className="px-3 py-2 rounded-lg border border-[color-mix(in_oklch,var(--err)_40%,transparent)] bg-[color-mix(in_oklch,var(--err)_8%,transparent)] text-[12px] text-err select-text">{err}</div>}
      </div>
      )}
    </Modal>
  );
}

// ---------- The Exchange panel: versions, and what changed since the last one ----------
export function ExchangePanel({ root, model, modelOf, onPublish }: {
  root: string; model: AmfModel | null; modelOf: (dir: string, main: string) => Promise<AmfModel>; onPublish: (version: string) => void;
}) {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [d, setD] = useState<S.Descriptor | null | undefined>(undefined);
  const [a, setA] = useState<{ name: string; versions: S.Version[] } | null | undefined>(undefined);
  const [diff, setDiff] = useState<{ base: string; changes: S.Change[]; part: 'major' | 'minor' | 'patch' } | null>(null);
  const [busy, setBusy] = useState<string | null>(null); const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const m = await status(); setMe(m);
      const x = await S.readDescriptor(root); setD(x?.d ?? null);
      if (!m || !x) return;
      try { setA(await S.assetVersions(x.d.groupId, x.d.assetId, x.d.version)); } catch (e) { setErr(String(e)); }
    })();
  }, [root]);
  // Compare with the newest version: its files (with dependencies) are fetched once into .apidesigner/published/.
  useEffect(() => {
    const base = a?.versions[0]?.version;
    if (!base || !d || !model || diff?.base === base) return;
    (async () => {
      setBusy(`Comparing with ${base}…`); setErr(null);
      try {
        const dir = `.apidesigner/published/${base}/`;
        const have = await invoke<{ files: unknown[] }>('open_project', { root: `${root}/${dir}` }).then((p) => p.files.length > 0, () => false);
        if (!have) await invoke('anypoint_fetch_dependency', { root, group: d.groupId, asset: d.assetId, version: base, published: true });
        const pd = await S.readDescriptor(`${root}/${dir}`);
        const old = await modelOf(`${root}/${dir}`, pd?.d.main ?? d.main ?? '');
        setDiff({ base, ...S.compareModels(old, model, dir) });
      } catch (e) { setErr(`Couldn't compare with ${base}: ${String(e).replace(/^Error: /, '')}`); }
      setBusy(null);
    })();
  }, [a, d, model]); // eslint-disable-line react-hooks/exhaustive-deps

  if (me === undefined || d === undefined) return <div className="p-3"><Note><span className="flex items-center gap-2"><Spinner />Reading Exchange…</span></Note></div>;
  if (!d) return <div className="p-3"><Note>This project has no exchange.json, so it isn't an Exchange asset yet. Projects pulled from Design Center have one.</Note></div>;
  if (!me) return <div className="p-3"><Note>Sign in to Anypoint to see {d.name} in Exchange: its versions and what changed since the last one.</Note></div>;
  const last = a?.versions[0];
  const stable = a?.versions.find((v) => v.status === 'published');
  const next = diff && last ? S.bump(stable && S.cmpVersion(stable.version, last.version) >= 0 ? stable.version : last.version, diff.part) : null;
  return (
    <div className="flex-1 overflow-auto px-3 pb-4 text-[12.5px]">
      {a === undefined && !err && <div className="mt-3"><Note>Reading Exchange…</Note></div>}
      {a === null && <div className="mt-3"><Note>{d.name} isn't in Exchange yet. Publish it to make the first version.</Note><button className={`${btn} mt-2.5`} onClick={() => onPublish(d.version || '1.0.0')}>Publish…</button></div>}
      {a && last && <>
        <div className="mt-3">Last published <b>{last.version}</b> {ago(last.created)}{last.by ? ` by ${last.by === me.username ? 'you' : last.by}` : ''}.</div>
        <button className="mt-1 text-[12px] text-accent hover:underline" onClick={() => openUrl(exchangeUrl(me, d.groupId, d.assetId))}>Open in Exchange</button>
        <H>Changed since {last.version}</H>
        {busy && <Note><span className="flex items-center gap-2"><Spinner />{busy}</span></Note>}
        {!model && !busy && <Note>Shown after the spec is checked.</Note>}
        {diff && diff.base === last.version && <>
          {diff.changes.length === 0 && <Note>No changes to resources, methods or types.</Note>}
          {diff.changes.slice(0, 80).map((c, i) => (
            <div key={i} className="flex items-start gap-2 py-1">
              <span className={`w-3 shrink-0 font-mono font-bold ${c.kind === '+' ? 'text-ok' : c.kind === '-' ? 'text-err' : 'text-warn'}`}>{c.kind === '~' ? '~' : c.kind}</span>
              {c.method ? <Badge m={c.method.toLowerCase()} /> : <span className="font-mono text-[9.5px] font-bold w-4 h-4 shrink-0 rounded-[3px] inline-flex items-center justify-center text-[var(--syn-number)] bg-[color-mix(in_oklch,var(--syn-number)_16%,transparent)]">T</span>}
              <span className="min-w-0"><span className="font-mono text-[11.5px] break-all">{c.name}</span>{c.detail && <span className={`block text-[11px] ${c.breaking ? 'text-warn' : 'text-content-faint'}`}>{c.detail}</span>}</span>
            </div>
          ))}
          {diff.changes.length > 80 && <Note>And {diff.changes.length - 80} more.</Note>}
          {diff.changes.length === 0 && <button className={`${btn} mt-2.5`} onClick={() => onPublish('')}>Publish…</button>}
          {next && diff.changes.length > 0 && <div className="mt-2.5 flex flex-col gap-2">
            <Note>{diff.part === 'major' ? 'Something was removed or changed in a way that can break callers' : diff.part === 'minor' ? 'Only additions' : 'Nothing that changes the API itself'}. Suggested next version: <b className="text-content">{next}</b></Note>
            <button className={`${btn} w-fit`} onClick={() => onPublish(next)}>Publish {next}…</button>
          </div>}
        </>}
        <H>Versions</H>
        {a.versions.map((v) => (
          <div key={v.version} className="flex items-center gap-2 py-1">
            <span className="font-mono text-[12px]">{v.version}</span>{life(v.status)}
            <span className="ml-auto text-[11.5px] text-content-faint whitespace-nowrap">{ago(v.created)}</span>
          </div>
        ))}
      </>}
      {err && <div className="mt-3 text-[12px] text-err select-text">{err}</div>}
    </div>
  );
}

// ---------- The Dependencies panel: exchange.json's dependencies, with updates from Exchange ----------
export function DepsPanel({ root, paths, onChanged, onNotice, onOpenFile }: {
  root: string; paths: () => Promise<string[]>; onChanged: () => Promise<void>; onNotice: (text: string, err: boolean) => void; onOpenFile: (path: string) => void;
}) {
  const [me, setMe] = useState<Me | null>(null);
  const [deps, setDeps] = useState<S.Descriptor['dependencies'] | null>(null);
  const [info, setInfo] = useState<Record<string, { name: string; type: string; latest?: string; versions: S.Version[] } | null>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState<'fragment' | 'ruleset' | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  // Rulesets (Design Center's governance dependencies) and which of their rules are on here.
  const [sets, setSets] = useState<G.Ruleset[]>([]);
  const [gs, setGs] = useState<G.Settings>({ off: {}, auto: true });
  const [open, setOpen] = useState<string | null>(null);

  const load = async () => {
    const x = await S.readDescriptor(root); setDeps(x ? x.d.dependencies ?? [] : null);
    setSets(await G.rulesets(root)); setGs(await G.readSettings(root));
    const m = await status(); setMe(m);
    if (!m || !x) return;
    for (const d of x.d.dependencies ?? []) {
      S.assetVersions(d.groupId, d.assetId, d.version).then((a) => setInfo((i) => ({ ...i, [`${d.groupId}/${d.assetId}`]: a && { name: a.name, type: a.type, versions: a.versions, latest: a.versions.find((v) => v.status === 'published')?.version ?? a.versions[0]?.version } })), () => {});
    }
  };
  useEffect(() => { load(); }, [root]); // eslint-disable-line react-hooks/exhaustive-deps
  const run = async (label: string, fn: () => Promise<string>) => {
    setBusy(label); setMenu(null);
    try { const t = await fn(); await onChanged(); await load(); onNotice(t, false); window.dispatchEvent(new Event('ads-governance-changed')); } catch (e) { onNotice(String(e).replace(/^Error: /, ''), true); }
    setBusy(null);
  };
  const mainOf = async (d: { groupId: string; assetId: string; version: string }) => {
    const dir = `exchange_modules/${d.groupId}/${d.assetId}/${d.version}/`;
    return dir + ((await S.readDescriptor(`${root}/${dir}`))?.d.main ?? 'ruleset.yaml');
  };
  const setOff = async (key: string, off: string[]) => {
    const next = { ...gs, off: { ...gs.off, [key]: off } };
    if (!off.length) delete next.off[key];
    setGs(next); await G.writeSettings(root, next);
    window.dispatchEvent(new Event('ads-governance-changed'));
  };
  if (deps === null) return <div className="p-3"><Note>This project has no exchange.json, so it can't have Exchange dependencies. Projects pulled from Design Center have one.</Note></div>;
  const isSet = (d: { groupId: string; assetId: string }) => sets.some((r) => r.key === `${d.groupId}/${d.assetId}`);
  const header = (title: string, n: number, kind: 'fragment' | 'ruleset') => (
    <div className="flex items-center gap-1 px-3 h-8 mt-1">
      <span className="flex-1 text-[10px] font-semibold uppercase tracking-[0.5px] text-content-faint">{title} <span className="font-normal">({n})</span></span>
      <button title={me ? (kind === 'ruleset' ? 'Add a ruleset from Exchange' : 'Add a dependency from Exchange') : 'Sign in to Anypoint to add dependencies'} disabled={!me || !!busy} onClick={() => setAdding(kind)}
        className="w-6 h-6 rounded flex items-center justify-center text-content-faint hover:bg-surface-3 hover:text-content disabled:opacity-40"><Icons.Plus size={14} /></button>
    </div>
  );
  const row = (d: { groupId: string; assetId: string; version: string }) => {
    const k = `${d.groupId}/${d.assetId}`, i = info[k], rs = sets.find((r) => r.key === k);
    const newer = i?.latest && S.cmpVersion(i.latest, d.version) > 0 ? i.latest : null;
    const off = gs.off[k] ?? [];
    return (
      <div key={k} className="border-b border-line-subtle">
        <div className="relative flex items-start gap-2 px-3 py-2">
          {rs && <button onClick={() => setOpen(open === k ? null : k)} title="Rules" className="mt-0.5 w-4 h-4 flex items-center justify-center text-content-faint hover:text-content">{open === k ? <Icons.ChevronDown size={11} /> : <Icons.ChevronRight size={11} />}</button>}
          <span className="min-w-0 flex-1">
            <span className="block font-semibold truncate">{rs?.name ?? i?.name ?? d.assetId} <span className="font-mono font-normal text-[11px] text-content-muted">{d.version}</span></span>
            <span className="block text-[11px] text-content-faint truncate">{rs ? `${rs.rules.length - off.length} of ${rs.rules.length} rules on` : `${d.groupId === me?.org_id ? me.org_name : d.groupId}${i?.type ? ` · ${i.type === 'raml-fragment' ? 'RAML fragment' : i.type}` : ''}`}</span>
            {newer && <button className={`${btn} mt-1.5 !h-[22px] !text-[11px]`} disabled={!!busy}
              onClick={() => run(`Updating ${d.assetId} to ${newer}…`, async () => { const ch = await S.changeDependency(root, await paths(), d, newer); return `${d.assetId} is now ${newer}.${ch.length ? ` References updated in ${ch.join(', ')}.` : ''}`; })}>Update to {newer}</button>}
          </span>
          <button title="More actions" onClick={() => setMenu(menu === k ? null : k)} className="w-6 h-6 rounded flex items-center justify-center text-content-faint hover:bg-surface-3 hover:text-content"><Icons.More size={13} /></button>
          {menu === k && (
            <div className="absolute right-3 top-9 z-30 w-[200px] p-1 rounded-lg bg-surface-2 border border-line shadow-[var(--shadow)]" onMouseLeave={() => setMenu(null)}>
              {[
                ['Show in Files', async () => { setMenu(null); onOpenFile(await mainOf(d)); }],
                ...(me ? [['Open in Exchange', () => { setMenu(null); openUrl(exchangeUrl(me, d.groupId, d.assetId)); }]] : []),
                ...((i?.versions.length ?? 0) > 1 ? i!.versions.filter((v) => v.version !== d.version).slice(0, 6).map((v) => [`Change to ${v.version}`, () => run(`Changing ${d.assetId} to ${v.version}…`, async () => { const ch = await S.changeDependency(root, await paths(), d, v.version); return `${d.assetId} is now ${v.version}.${ch.length ? ` References updated in ${ch.join(', ')}.` : ''}`; })]) : []),
                ['Remove', () => run(`Removing ${d.assetId}…`, async () => { await S.removeDependency(root, await paths(), d); if (rs) await setOff(k, []); return `Removed ${d.assetId}.`; })],
              ].map(([label, f]) => (
                <button key={label as string} onClick={f as () => void} className="w-full h-7 px-2 rounded text-left text-[12.5px] text-content-secondary hover:bg-surface-3 hover:text-content">{label as string}</button>
              ))}
            </div>
          )}
        </div>
        {rs && open === k && (
          <div className="pl-9 pr-3 pb-2">
            {rs.description && <div className="mb-1.5 text-[11.5px] text-content-faint">{rs.description}</div>}
            <div className="flex gap-3 mb-1 text-[11px]">
              <button className="text-accent hover:underline" onClick={() => setOff(k, [])}>All on</button>
              <button className="text-accent hover:underline" onClick={() => setOff(k, rs.rules.map((r) => r.name))}>All off</button>
            </div>
            {(['violation', 'warning', 'info'] as const).map((lv) => {
              const list = rs.rules.filter((r) => r.level === lv);
              return list.length ? (
                <div key={lv} className="mt-1.5">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.5px] text-content-faint">{lv === 'violation' ? 'Violations' : lv === 'warning' ? 'Warnings' : 'Info'} ({list.length})</div>
                  {list.map((r) => (
                    <label key={r.name} className="flex items-start gap-2 py-0.5 cursor-pointer" title={r.message}>
                      <input type="checkbox" className="mt-0.5 accent-[var(--accent)]" checked={!off.includes(r.name)}
                        onChange={(e) => setOff(k, e.target.checked ? off.filter((x) => x !== r.name) : [...off, r.name])} />
                      <span className="min-w-0"><span className="block font-mono text-[11.5px] truncate">{r.name}</span>{r.message && <span className="block text-[11px] text-content-faint">{r.message}</span>}</span>
                    </label>
                  ))}
                </div>
              ) : null;
            })}
          </div>
        )}
      </div>
    );
  };
  const frags = (deps ?? []).filter((d) => !isSet(d)), rsDeps = (deps ?? []).filter(isSet);
  return (
    <div className="flex-1 overflow-auto pb-4 text-[12.5px]">
      {busy && <div className="px-3 pt-2"><Note><span className="flex items-center gap-2"><Spinner />{busy}</span></Note></div>}
      {header('Fragments', frags.length, 'fragment')}
      {frags.length === 0 && <div className="px-3"><Note>None yet. Fragments from Exchange, like shared libraries and traits, go here.</Note></div>}
      {frags.map(row)}
      {header('Rulesets', rsDeps.length, 'ruleset')}
      {rsDeps.length === 0 && <div className="px-3"><Note>Add a ruleset to check this API against your organization's rules, or Anypoint's own: Best Practices, OWASP and more. Results show under Governance in Project errors.</Note></div>}
      {rsDeps.map(row)}
      {rsDeps.length > 0 && <div className="px-3 pt-2"><Note>Switching rules off is kept on this computer. Design Center and Exchange apply each ruleset whole.</Note></div>}
      {adding && <AddDependency rulesets={adding === 'ruleset'} onClose={() => setAdding(null)} onAdd={(dep) => { const kind = adding; setAdding(null); run(`Adding ${dep.assetId}…`, async () => {
        const r = await S.addDependency(root, dep);
        if (r.failed.length) throw new Error(`Added to exchange.json, but the files couldn't be fetched: ${r.failed.join('; ')}`);
        return kind === 'ruleset' ? `Added ${dep.assetId} ${dep.version}. Governance checks the API against it.` : `Added ${dep.assetId} ${dep.version}. Use it with ${r.path}`;
      }); }} />}
    </div>
  );
}

// Add dependency (fragments, into exchange_modules) and Import from Exchange (fragments and API specs, their
// files into a folder of the project): the same search and version picker.
export function AddDependency({ onClose, onAdd, importing, rulesets }: { onClose: () => void; onAdd: (d: { groupId: string; assetId: string; version: string }) => void; importing?: boolean; rulesets?: boolean }) {
  const [q, setQ] = useState('');
  const [dev, setDev] = useState(false);
  const [list, setList] = useState<Awaited<ReturnType<typeof S.searchAssets>> | null>(null);
  const [pick, setPick] = useState<{ groupId: string; assetId: string; name: string } | null>(null);
  const [versions, setVersions] = useState<S.Version[]>([]); const [version, setVersion] = useState('');
  const [loadingVersions, setLoadingVersions] = useState(false);
  const [owner, setOwner] = useState('');
  const [again, setAgain] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => { status().then(setMe); }, []);
  // Exchange's search covers everything this user can see: MuleSoft's public assets and their own organization's.
  useEffect(() => {
    const t = setTimeout(() => { setErr(null); setList(null); S.searchAssets(q.trim(), rulesets ? ['ruleset'] : importing ? ['raml-fragment', 'rest-api'] : ['raml-fragment']).then(setList, (e) => setErr(String(e))); }, 250);
    return () => clearTimeout(t);
  }, [q, again]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!pick) return;
    let gone = false;
    setVersions([]); setVersion(''); setLoadingVersions(true);
    S.assetVersions(pick.groupId, pick.assetId, (pick as { version?: string }).version).then((a) => { if (!gone) setVersions(a?.versions ?? []); }, (e) => setErr(String(e))).finally(() => { if (!gone) setLoadingVersions(false); });
    return () => { gone = true; };
  }, [pick]);
  const shown = versions.filter((v) => dev || v.status === 'published');
  useEffect(() => { if (shown[0] && !shown.some((v) => v.version === version)) setVersion(shown[0].version); }, [versions, dev]); // eslint-disable-line react-hooks/exhaustive-deps
  // Who owns an asset: the search names other organizations; MuleSoft's public assets come without a name.
  const ownerOf = (a: { groupId: string; org: string }) => a.groupId === me?.org_id ? me.org_name : a.org || (a.groupId === MULESOFT ? 'MuleSoft' : a.groupId);
  const visible = (list ?? []).filter((a) => (dev || a.status !== 'development') && (!owner || ownerOf(a) === owner));
  const owners = [...new Set((list ?? []).map(ownerOf))];
  const why = !pick ? `Pick ${rulesets ? 'a ruleset' : 'an asset'} first.` : loadingVersions ? 'Reading its versions from Exchange…' : !version ? (versions.length ? 'Only Development versions: tick the box to see them.' : 'No versions found.') : null;
  return (
    <Modal title={rulesets ? 'Add ruleset' : importing ? 'Import from Exchange' : 'Add dependency'} sub={rulesets ? 'Governance rulesets from Exchange' : importing ? 'Its files go into a folder of this project' : 'Fragments from Exchange'} onCancel={onClose} width={560}
      footer={<><label className="flex-1 flex items-center gap-2 text-[12px] text-content-secondary cursor-pointer"><input type="checkbox" checked={dev} onChange={(e) => setDev(e.target.checked)} className="accent-[var(--accent)]" />Include versions in Development</label>
        <button className={btn} onClick={onClose}>Cancel</button>
        <button className={btnPrimary} title={why ?? undefined} disabled={!!why} onClick={() => pick && onAdd({ groupId: pick.groupId, assetId: pick.assetId, version })}>{importing ? 'Import' : rulesets ? 'Add ruleset' : 'Add dependency'}</button></>}>
      <div className="flex flex-col gap-3 text-[12.5px]">
        <div className="flex gap-2">
          <label className="flex-1 flex items-center gap-1.5 h-[28px] px-2 rounded-md bg-surface-2 border border-line text-content-faint focus-within:border-accent-border">
            <Icons.Search size={12} /><input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search Exchange by name" spellCheck={false} className="flex-1 min-w-0 bg-transparent outline-none text-[12.5px] text-content" /></label>
          <button className={btn} title="Search Exchange again, for anything published since" disabled={list == null && !err} onClick={() => setAgain((n) => n + 1)}>Refresh</button>
        </div>
        {owners.length > 1 && <div className="flex items-center gap-1.5 flex-wrap text-[11.5px]">
          <span className="text-content-faint">From</span>
          {['', ...owners].map((o) => (
            <button key={o} onClick={() => setOwner(o)} className={`h-6 px-2 rounded-md border ${owner === o ? 'border-accent-border bg-accent-dim text-content' : 'border-line text-content-muted hover:text-content'}`}>{o || 'Everyone'}</button>
          ))}
        </div>}
        <div className="h-[240px] overflow-auto rounded-md border border-line">
          {list == null && !err && <div className="p-4 flex items-center gap-2 text-content-faint"><span className="w-3 h-3 rounded-full border-2 border-accent border-t-transparent animate-spin" />Searching Exchange…</div>}
          {list != null && !visible.length && <div className="p-4 text-content-faint">{q.trim() ? 'Nothing matches.' : rulesets ? "No rulesets found. Rulesets your organization publishes to Exchange show here too." : 'Nothing found.'}</div>}
          {visible.map((a) => (
            <div key={a.groupId + a.assetId} onClick={() => { setPick(a); setErr(null); }} className={`flex items-center gap-2 px-3 py-2 border-b border-line-secondary last:border-b-0 cursor-pointer ${pick?.assetId === a.assetId && pick.groupId === a.groupId ? 'bg-accent-dim' : 'hover:bg-[var(--hover-overlay)]'}`}>
              <span className="text-[9.5px] font-semibold px-1.5 rounded border border-line text-content-faint">{a.type === 'rest-api' ? 'API' : a.type === 'ruleset' ? 'Rules' : 'RAML'}</span>
              <span className="min-w-0 flex-1"><span className="block font-semibold truncate">{a.name}</span><span className="block text-[11px] text-content-faint truncate">{ownerOf(a)}</span></span>
              <span className="font-mono text-[11px] text-content-muted">{a.version}</span>{a.status !== 'published' && life(a.status)}
            </div>
          ))}
        </div>
        {pick && <label className="flex items-center gap-2.5"><span className="text-[11.5px] text-content-faint">Version</span>
          {loadingVersions ? <span className="flex items-center gap-2 text-[12px] text-content-muted"><span className="w-3 h-3 rounded-full border-2 border-accent border-t-transparent animate-spin" />Reading versions from Exchange…</span>
          : <Select value={version} onChange={setVersion} className="min-w-[140px] text-[12px]"
            options={shown.map((v) => ({ value: v.version, hint: v.status !== 'published' ? (v.status === 'development' ? 'Development' : v.status) : undefined }))} />}
          {!loadingVersions && !shown.length && versions.length > 0 && <span className="text-[11.5px] text-content-faint">Only Development versions: tick the box below to see them.</span>}</label>}
        {err && <div className="text-[12px] text-err select-text">{err}</div>}
      </div>
    </Modal>
  );
}
