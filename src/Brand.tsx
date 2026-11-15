// The app's own face: the startup splash (DataWeave Studio's loaders) and the About popup the logo opens.
import { useEffect, useMemo, useState } from 'react';
import logo from './assets/logo.svg';
import RELEASES from './releases.json';
import { isVsCode } from './components/WindowControls';
import { invoke } from '@tauri-apps/api/core';
import { openUrl } from '@tauri-apps/plugin-opener';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { Icons } from './components/Icons';
import { isTauri } from './components/WindowControls';
import { OrbitalLoader, PendulumLoader, RingsLoader } from './components/Loaders';

export const APP_NAME = 'Design Studio';
export const APP_FULL_NAME = 'Design Studio for MuleSoft';

// Every "are you sure?" goes through this and is awaited. In the app, window.confirm is Tauri's dialog
// plugin's and returns a promise, which counts as "yes" when tested like a boolean: so it never waited.
// They show in the app's own dialog (App.tsx mounts it and registers here), with the action named on the button
// and, where saving is the likely answer, a second choice: "Save and close" beside "Close without saving".
export type Question = { message: string; ok: string; alt?: string; danger?: boolean; done: (a: 'ok' | 'alt' | null) => void };
let asker: ((q: Question) => void) | null = null;
export const setAsker = (f: typeof asker) => { asker = f; };
export const choose = (message: string, ok: string, alt?: string, danger?: boolean) => new Promise<'ok' | 'alt' | null>((done) => {
  if (asker) asker({ message, ok, alt, danger, done }); else done(window.confirm(message) ? 'ok' : null);
});
export const ask = async (message: string, ok = 'OK', danger = false) => (await choose(message, ok, undefined, danger)) === 'ok';

const css = (name: string, fallback: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
const STAGES = ['Starting…', 'Loading the editor…', 'Warming up the AMF engine…', 'Almost ready…'];

// Updates: checked a few seconds after start, downloaded quietly, then offered once ("Update ready" in the
// title bar, and in About). Installing restarts the app: on Windows the installer runs silently and opens
// the new version by itself; elsewhere the app relaunches. Store builds never update themselves.
export type UpdateState = { state: 'idle' | 'checking' | 'downloading' | 'ready' | 'none' | 'error' | 'off'; version?: string; pct?: number };
let updateState: UpdateState = { state: 'idle' };
let pending: Update | null = null;
const setUpdate = (u: UpdateState) => { updateState = u; window.dispatchEvent(new Event('ads-update')); };
export const autoUpdates = () => { try { return localStorage.getItem('ads.updateCheck') !== '0'; } catch { return true; } };
const storeBuild = import.meta.env.VITE_STORE_BUILD === '1' || import.meta.env.VITE_VSCODE === '1'; // the Store and the Marketplace update it themselves
export async function checkForUpdate(manual = false) {
  if (!isTauri || storeBuild || pending) return;
  if (!manual && !autoUpdates()) { setUpdate({ state: 'off' }); return; }
  setUpdate({ state: 'checking' });
  try {
    const u = await check();
    if (!u) { setUpdate({ state: 'none' }); return; }
    setUpdate({ state: 'downloading', version: u.version, pct: 0 });
    let total = 0, got = 0;
    await u.download((e) => {
      if (e.event === 'Started') total = e.data.contentLength ?? 0;
      else if (e.event === 'Progress') { got += e.data.chunkLength; if (total) setUpdate({ state: 'downloading', version: u.version, pct: Math.min(99, Math.round((got / total) * 100)) }); }
    });
    pending = u;
    setUpdate({ state: 'ready', version: u.version });
  } catch {
    // Offline, or GitHub unreachable: not news. A manual check says so.
    setUpdate({ state: manual ? 'error' : 'idle' });
  }
}
// Installs the downloaded update and restarts. The caller saves unsaved work first.
export async function installUpdate() {
  if (!pending) return;
  await pending.install(); // Windows: the silent installer takes over and reopens the app
  await relaunch();
}
export function useUpdate() {
  const [u, setU] = useState(updateState);
  useEffect(() => { const f = () => setU(updateState); window.addEventListener('ads-update', f); return () => window.removeEventListener('ads-update', f); }, []);
  return u;
}

// Covers the window until the AMF engine answers (any answer: an unknown op still means it's up), so the
// first project opens straight into a checked spec. One of the three loaders, picked at random per launch.
export function Splash() {
  const Loader = useMemo(() => [OrbitalLoader, PendulumLoader, RingsLoader][Math.floor(Math.random() * 3)], []);
  const colors = useMemo(() => ({ accent: css('--accent', '#10b981'), fg: css('--content', '#f3efe6') }), []);
  const [ready, setReady] = useState(false);
  const [warn, setWarn] = useState(false);
  const [progress, setProgress] = useState(0);
  const [fade, setFade] = useState(false);
  const [gone, setGone] = useState(false);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    if (!isTauri) { setReady(true); return; }
    invoke('amf', { op: 'ping', args: {} }).then(() => setReady(true), (e) => {
      if (/didn't answer|isn't running|Couldn't start Java|didn't start/.test(String(e))) setWarn(true);
      setReady(true);
    });
    const s = setTimeout(() => setSlow(true), 5000);
    const cap = setTimeout(() => { setWarn(true); setReady(true); }, 20000); // never stand between the user and the app
    return () => { clearTimeout(s); clearTimeout(cap); };
  }, []);
  useEffect(() => {
    if (gone) return;
    const t = setInterval(() => setProgress((p) => (ready ? (p + (100 - p) * 0.3 >= 99.5 ? 100 : p + (100 - p) * 0.3) : p < 25 ? p + 2.5 : p < 50 ? p + 1.2 : p < 70 ? p + 0.6 : p < 85 ? p + 0.2 : p)), 80);
    return () => clearInterval(t);
  }, [ready, gone]);
  useEffect(() => { if (progress >= 100 && !fade) { setFade(true); setTimeout(() => setGone(true), 500); } }, [progress, fade]);
  if (gone) return null;
  const stage = progress < 15 ? 0 : progress < 45 ? 1 : progress < 90 ? 2 : 3;
  return (
    <div className={`fixed inset-0 z-[200] flex flex-col items-center justify-center bg-bg transition-opacity duration-500 ${fade ? 'opacity-0 pointer-events-none' : ''}`}>
      <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(1200px 800px at 50% 50%, color-mix(in oklch, var(--content) 3%, transparent), transparent 70%), radial-gradient(600px 400px at 50% 110%, color-mix(in oklch, var(--accent) 6%, transparent), transparent 70%)' }} />
      <div className="relative" style={{ width: 260, height: 260 }}><Loader accent={colors.accent} fg={colors.fg} size={260} /></div>
      <h1 className="relative mt-7 mb-1 text-2xl font-bold tracking-tight text-content">{APP_NAME}</h1>
      <p className="relative mb-9 text-sm text-content-faint">for MuleSoft API specs</p>
      <div className="relative w-72 mb-4 h-1.5 rounded-full bg-surface-2 overflow-hidden">
        <div className="h-full rounded-full bg-accent transition-all duration-200 ease-out" style={{ width: `${progress}%` }} />
      </div>
      <div className="relative flex items-center gap-2 text-xs">
        <span className="text-content-muted">{warn ? 'Started with warnings' : STAGES[stage]}</span>
        <span className="font-mono text-content-ghost">{Math.round(progress)}%</span>
      </div>
      {slow && !ready && <div className="relative mt-3 max-w-[340px] text-center text-[11px] leading-relaxed text-content-ghost">The AMF engine takes a few extra seconds on slow or heavily monitored machines. Only once per launch.</div>}
    </div>
  );
}

// About, as in DataWeave Studio: what it is, version, licence, engine, and who made it.
// The release notes (src/releases.json, newest first): what this runtime shows ("only" keeps an item to desktop or VS Code).
type Release = { version: string; date: string; headline: string; highlights: { title: string; desc: string; tag?: string; only?: string }[] };
const shows = (h: { only?: string }) => !h.only || h.only === (isVsCode ? 'vscode' : 'desktop');
export const NOTES = (RELEASES as Release[]).map((r) => ({ ...r, highlights: r.highlights.filter(shows) })).filter((r) => r.highlights.length);

export function About({ version, onClose, onRestart, whatsNew = false }: { version: string; onClose: () => void; onRestart: () => void; whatsNew?: boolean }) {
  const upd = useUpdate();
  const current = NOTES.find((r) => r.version === version) ?? NOTES[0];
  const [earlier, setEarlier] = useState(false);
  const [notes, setNotes] = useState(whatsNew);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  const Stat = ({ kicker, value, sub, accent }: { kicker: string; value: string; sub: string; accent?: boolean }) => (
    <div>
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.8px] text-content-faint">{kicker}</div>
      <div className={`text-[26px] font-bold leading-[1.1] tracking-[-0.8px] ${accent ? 'text-accent' : 'text-content'}`}>{value}</div>
      <div className="mt-0.5 text-[11px] text-content-faint">{sub}</div>
    </div>
  );
  const Rule = () => <div className="my-6 h-px bg-line-subtle" />;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto px-4 pt-[5vh]" onClick={onClose}
      style={{ background: 'color-mix(in oklch, var(--bg) 70%, transparent)', backdropFilter: 'blur(3px)' }}>
      <div className="relative my-auto w-full max-w-[760px] overflow-hidden rounded-xl border border-line bg-surface" onClick={(e) => e.stopPropagation()}
        style={{ boxShadow: '0 32px 90px color-mix(in oklch, oklch(0% 0 0) 55%, transparent)' }}>
        <button onClick={onClose} aria-label="Close" className="absolute right-[14px] top-[14px] z-10 flex h-7 w-7 items-center justify-center rounded-md text-content-faint hover:bg-surface-2 hover:text-content"><Icons.X size={13} /></button>
        <div className="px-8 pb-6 pt-7">
          <div className="flex items-center gap-8">
            <div className="min-w-0 flex-1">
              <div className="mb-3 text-[11px] font-semibold uppercase tracking-[1px] text-accent">A free {isVsCode ? 'VS Code' : 'desktop'} tool for MuleSoft developers</div>
              <h1 className="m-0 text-[46px] font-bold leading-[1.04] tracking-[-1.5px] text-content">{APP_NAME}.<br /><span className="text-accent">Code and visual, in sync.</span></h1>
            </div>
            <img src={logo} alt="" width={124} height={124} className="mr-2 shrink-0" style={{ filter: 'drop-shadow(0 10px 28px rgba(0, 90, 255, 0.28))' }} />
          </div>
          <p className="mb-0 mt-[18px] max-w-[580px] text-[15px] leading-[1.55] text-content-muted">
            Design Center's API Designer {isVsCode ? 'in VS Code' : 'on your desktop'}: RAML and OAS, big specs that open in seconds, every edit checked by MuleSoft's own AMF engine,
            and the same pull, push and publish to Exchange. Works offline; you only sign in to sync.
          </p>
          <Rule />
          <div className="grid grid-cols-3 gap-x-7 gap-y-6">
            <Stat kicker="version" value={version || '–'} sub="installed" accent />
            <Stat kicker="license" value="MIT" sub="free and open source" />
            <Stat kicker="engine" value="AMF 5.15" sub="Apache 2.0 · MuleSoft" />
          </div>
          {current && <>
            <Rule />
            <button onClick={() => setNotes(!notes)} className="w-full flex items-baseline gap-2.5 text-left group">
              <span className="text-[10.5px] font-semibold uppercase tracking-[0.8px] text-content-faint">What's new in {current.version}</span>
              <span className="text-[13px] font-semibold text-content group-hover:text-accent">{current.headline}</span>
              <span className="text-[11px] text-content-faint">{current.date}</span>
              <span className="ml-auto text-[11.5px] text-accent">{notes ? 'Hide' : 'Show'}</span>
            </button>
            {notes && <>
            <div className="mt-2 flex flex-col gap-2">
              {current.highlights.map((h) => (
                <div key={h.title} className="text-[12.5px] leading-[1.5] text-content-muted">
                  <span className="font-semibold text-content">{h.title}</span>{h.tag && <span className="ml-1.5 rounded px-1 py-px text-[9.5px] font-bold text-accent bg-accent-dim align-middle">{h.tag}</span>}
                  <span className="text-content-faint"> · </span>{h.desc}
                </div>
              ))}
            </div>
            {NOTES.length > 1 && <button onClick={() => setEarlier(!earlier)} className="mt-2.5 text-[11.5px] text-accent hover:underline">{earlier ? 'Hide earlier releases' : 'Earlier releases'}</button>}
            {earlier && NOTES.filter((r) => r !== current).map((r) => (
              <div key={r.version} className="mt-2 text-[12px] text-content-muted"><span className="font-semibold text-content">{r.version}</span> {r.headline}: {r.highlights.map((h) => h.title).join(', ')}.</div>
            ))}
            </>}
          </>}
          <Rule />
          <div className="grid items-start gap-6" style={{ gridTemplateColumns: '180px 1fr' }}>
            <div>
              <div className="mb-[10px] text-[10.5px] font-semibold uppercase tracking-[0.8px] text-content-faint">From the maker</div>
              <div className="mb-[10px] flex items-center gap-[10px]">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[14px] font-bold text-accent-ink" style={{ background: 'linear-gradient(135deg, var(--accent), var(--violet))' }}>AV</div>
                <div>
                  <div className="text-[13px] font-semibold text-content">Ashutosh Vijay</div>
                  <div className="text-[10.5px] text-content-faint">MuleSoft dev</div>
                </div>
              </div>
              <div className="flex gap-1">
                {([['Portfolio', 'https://ashutosh-vijay.dev/'], ['GitHub', 'https://github.com/Ashutosh-Vijay'], ['LinkedIn', 'https://www.linkedin.com/in/ashutosh-vijay/']] as const).map(([label, url]) => (
                  <button key={label} title={label} onClick={() => openUrl(url)} className="h-7 rounded-md border border-line-subtle px-2 text-[11px] text-content-muted hover:bg-surface-2">{label}</button>
                ))}
              </div>
            </div>
            <div className="border-l-[3px] border-accent pl-[18px] text-[16px] leading-[1.55] tracking-[-0.1px] text-content">
              &ldquo;On a big spec, Design Center's suggestions crawl, so we all ended up copying an endpoint, pasting it and editing by hand.
              {` ${APP_NAME}`} makes that fast again, and keeps the visual side and the code in step both ways.&rdquo;
            </div>
          </div>
          <div className="my-[18px] h-px bg-line-subtle" />
          {isTauri && !storeBuild && <div className="mb-3 flex items-center gap-2 text-[12px] text-content-muted">
            <span className={`w-2 h-2 rounded-full ${upd.state === 'ready' ? 'bg-accent' : upd.state === 'error' ? 'bg-err' : 'bg-content-ghost'}`} />
            <span>{upd.state === 'checking' ? 'Checking for updates…' : upd.state === 'downloading' ? `Downloading ${upd.version} in the background… ${upd.pct ?? 0}%`
              : upd.state === 'ready' ? `Version ${upd.version} is ready.` : upd.state === 'none' ? 'Up to date.' : upd.state === 'error' ? "Couldn't reach GitHub to check for updates."
              : upd.state === 'off' ? 'Automatic update checks are off (Settings).' : `Version ${version}.`}</span>
            {upd.state === 'ready' ? <button onClick={onRestart} className="text-accent font-semibold hover:underline">Restart to update</button>
              : upd.state !== 'checking' && upd.state !== 'downloading' && <button onClick={() => checkForUpdate(true)} className="text-accent hover:underline">Check now</button>}
          </div>}
          <div className="text-[10px] leading-[1.6] text-content-faint">
            {APP_FULL_NAME}. AMF by MuleSoft / Salesforce, Apache License 2.0. Editor fonts JetBrains Mono, Fira Code, Cascadia Code, IBM Plex Mono and Geist Mono, SIL Open Font License 1.1. Anypoint, Design Center, Exchange and MuleSoft are trademarks of Salesforce, Inc.
            Not affiliated with, endorsed by, or sponsored by MuleSoft or Salesforce.
          </div>
        </div>
      </div>
    </div>
  );
}
