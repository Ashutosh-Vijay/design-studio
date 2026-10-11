import { Component, memo, useEffect, useMemo, useRef, useState, type CSSProperties, type MutableRefObject, type ReactNode } from 'react';
import { EditorState, type Extension } from '@codemirror/state';
import { autocompletion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { EditorView, hoverTooltip, keymap } from '@codemirror/view';
import { setDiagnostics, type Diagnostic } from '@codemirror/lint';
import { listen } from '@tauri-apps/api/event';
import { METHODS, baseExtensions, languageFor, yamlPathAt } from './editor';
import { BUILTIN_TYPES, SCALAR_KEYS, entries, kids, normalizePath, buildOutline, buildOasOutline, keyPathAt, libraryPaths, shelfContext, shelfEdit, type Decl, type Outline, type Resource, type ShelfCtx } from './raml';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { Icons } from './components/Icons';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { WindowControls, isTauri } from './components/WindowControls';
import { Inspector, OasInspector, type AmfModel, type At } from './Inspector';
import { OasJsonInspector, buildOasJsonOutline, oasJsonSelection } from './OasJson';
import { ConnectDialog, AnypointSettings, SyncBar, ProjectMenu } from './SyncUI';
import { PublishDialog, ExchangePanel, DepsPanel } from './ExchangeUI';
import { DocsPanel } from './Docs';
import { ApiMap } from './ApiMap';
import { CreateDialog, NewFileDialog } from './Create';
import { diff, remove as removeNode, dropRefs, declLines, usesName, qualify, addChild, find } from './splice';
import { ACCENTS, ThemePref, applyTheme, isDarkPref, savedTheme } from './theme';

// What the Rust side returns for an opened folder (src-tauri/src/lib.rs, open_project).
type Project = { root: string; name: string; main: string | null; files: { path: string; size: number }[]; dirs: string[] };
type Recent = { root: string; name: string; opened: number };
type SyncHooks = { saveAll: () => Promise<void>; notice: (t: string, err: boolean) => void; reload: () => Promise<void>; publish: () => void };

const APP_NAME = 'API Designer Studio';

function readRecent(): Recent[] {
  try { return JSON.parse(localStorage.getItem('ads.recent') || '[]'); } catch { return []; }
}
function writeRecent(list: Recent[]) {
  try { localStorage.setItem('ads.recent', JSON.stringify(list.slice(0, 12))); } catch { /* ignore */ }
}
function ago(t: number) {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'Now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24); return d === 1 ? 'Yesterday' : `${d} days ago`;
}
const base = (p: string) => p.split('/').pop() || p;
const isReadOnly = (p: string) => p === 'exchange.json' || p.startsWith('exchange_modules/');
// An OpenAPI 3 file written in YAML: the forms, tree and outline read it with the same line parser as RAML.
const isOasYaml = (p: string, text: string) => /\.ya?ml$/i.test(p) && /^\s*openapi\s*:\s*['"]?3\./m.test(text);
const isOasJson = (p: string, text: string) => /\.json$/i.test(p) && /"openapi"\s*:\s*"3\./.test(text);

export default function App() {
  const [project, setProject] = useState<Project | null>(null);
  const [recent, setRecent] = useState<Recent[]>(readRecent);
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState(savedTheme);
  const [settingsAt, setSettingsAt] = useState<DOMRect | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [dirtyCount, setDirtyCount] = useState(0);
  const [connectOpen, setConnectOpen] = useState(false);
  const [creating, setCreating] = useState<'api' | 'fragment' | null>(null);
  // What the project view lends the title bar's sync controls: save everything, show a notice, reload.
  const syncRef = useRef<SyncHooks | null>(null);
  const openFileRef = useRef<(path: string) => void>(() => {});

  useEffect(() => { applyTheme(theme.pref, theme.accent); }, [theme]);

  // Leaving a project (or the window) with unsaved files asks first.
  const okToLeave = () => dirtyCount === 0 || window.confirm(`${dirtyCount} ${dirtyCount === 1 ? 'file has' : 'files have'} unsaved changes. Leave without saving?`);
  // Closing the window with unsaved files asks first. (A browser-style beforeunload prompt would be
  // a blocking native dialog in WebView2, so the guard sits on Tauri's close request instead.)
  const dirtyRef = useRef(0);
  dirtyRef.current = dirtyCount;
  useEffect(() => {
    if (!isTauri) return;
    const un = getCurrentWindow().onCloseRequested((e) => {
      const n = dirtyRef.current;
      if (n && !window.confirm(`${n} ${n === 1 ? 'file has' : 'files have'} unsaved changes. Close without saving?`)) e.preventDefault();
    });
    return () => { un.then((f) => f()); };
  }, []);

  async function openFolder(root?: string) {
    if (project && !okToLeave()) return;
    setError(null);
    let dir = root;
    if (!dir) {
      const picked = await openDialog({ directory: true, title: 'Open a spec project folder' });
      if (typeof picked !== 'string') return;
      dir = picked;
    }
    setOpening(dir);
    try {
      const p = await invoke<Project>('open_project', { root: dir });
      setProject(p); setDirtyCount(0);
      const list = [{ root: p.root, name: p.name, opened: Date.now() }, ...readRecent().filter((r) => r.root !== p.root)];
      writeRecent(list); setRecent(list);
    } catch (e) {
      setError(String(e));
    } finally {
      setOpening(null);
    }
  }

  // A zip is unpacked into a new folder, and that folder is the project from then on.
  const [zipAsk, setZipAsk] = useState<{ zip: string; dest: string } | null>(null);
  const [pendingNotice, setPendingNotice] = useState<string | null>(null);
  async function openZip() {
    const zip = await openDialog({ title: 'Open a Design Center or Exchange zip', filters: [{ name: 'Zip', extensions: ['zip'] }] });
    if (typeof zip !== 'string') return;
    const norm = zip.replace(/\\/g, '/');
    const dir = norm.slice(0, norm.lastIndexOf('/'));
    const stem = norm.slice(norm.lastIndexOf('/') + 1).replace(/\.zip$/i, '').replace(/-\d+\.\d+\.\d+(-[\w.]+)?$/, '');
    setZipAsk({ zip, dest: `${dir}/${stem}` });
  }
  async function unpack(zip: string, dest: string) {
    const r = await invoke<{ root: string; files: number; duplicates: string[] }>('import_zip', { zipPath: zip, dest });
    setZipAsk(null);
    if (r.duplicates.length) setPendingNotice(`The zip held ${r.duplicates.length === 1 ? 'a file' : r.duplicates.length + ' files'} twice: ${r.duplicates.join(', ')}. The last copy was used, as Design Center does.`);
    await openFolder(r.root);
  }

  // App-wide keys. The editor handles its own (Ctrl S lives in the project view).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (import.meta.env.PROD && (e.key === 'F5' || (mod && e.key.toLowerCase() === 'r'))) { e.preventDefault(); return; }
      if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(true); }
      else if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); if (isTauri) openFolder(); }
      else if (e.key === 'Escape') { setSettingsAt(null); setPaletteOpen(false); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const settingsBtn = (cls: string) => (
    <button className={cls} title="Theme and accent" onClick={(e) => setSettingsAt(settingsAt ? null : e.currentTarget.getBoundingClientRect())}>
      <Icons.Sliders size={17} />
    </button>
  );

  return (
    <div className="h-screen w-screen flex flex-col bg-bg text-content select-none">
      {/* Title bar: the window has no OS decorations, so this is the drag region */}
      <header data-tauri-drag-region className="h-11 shrink-0 flex items-center gap-2.5 pl-3 bg-surface border-b border-line">
        <button className="w-8 h-7 flex items-center justify-center rounded-md hover:bg-surface-2" title={project ? 'All projects' : APP_NAME}
          onClick={() => { if (project && okToLeave()) { setProject(null); setDirtyCount(0); } }}>
          <img src="/logo.svg" width={22} height={22} alt="" />
        </button>
        <span data-tauri-drag-region className="text-[13px] font-semibold">{project ? project.name : APP_NAME}</span>
        {project && isTauri && <ProjectMenu key={project.root} root={project.root} name={project.name} onNotice={(t, err) => syncRef.current?.notice(t, err)}
          onOpen={(root) => openFolder(root)} onGone={() => { const l = recent.filter((r) => r.root !== project.root); writeRecent(l); setRecent(l); setProject(null); setDirtyCount(0); }} />}
        {project && <span data-tauri-drag-region className="text-[12px] text-content-faint">{dirtyCount ? `${dirtyCount} unsaved` : 'All changes saved'}</span>}
        <div data-tauri-drag-region className="flex-1 h-full" />
        {project && isTauri && (
          <SyncBar key={project.root} root={project.root} dirty={dirtyCount}
            listFiles={async () => (await invoke<Project>('open_project', { root: project.root })).files.map((f) => f.path)}
            saveAll={async () => { await syncRef.current?.saveAll(); }}
            onNotice={(t, err) => syncRef.current?.notice(t, err)}
            onChanged={async () => { await syncRef.current?.reload(); }} onPublish={() => syncRef.current?.publish()} />
        )}
        <div data-tauri-drag-region className="flex-1 h-full" />
        <button className="w-8 h-7 flex items-center justify-center rounded-md text-content-faint hover:bg-surface-2 hover:text-content" title="Search files and commands (Ctrl K)" onClick={() => setPaletteOpen(true)}>
          <Icons.Search size={15} />
        </button>
        {!project && settingsBtn('w-8 h-7 flex items-center justify-center rounded-md text-content-faint hover:bg-surface-2 hover:text-content')}
        <WindowControls />
      </header>

      {project ? (
        <Boundary resetKey={project.root} fallback={(e) => (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 text-[13px] text-content-secondary select-text">
            <span className="text-err">Something went wrong: {e}</span>
            <span className="text-content-faint">Unsaved work, as of a few seconds ago, is offered back when the project opens again.</span>
            <button className="h-[28px] px-3 rounded-md border border-line bg-surface-2 hover:text-content" onClick={() => location.reload()}>Reload the window</button>
          </div>
        )}>
        <ProjectView
          key={project.root}
          project={project}
          onDirtyCount={setDirtyCount}
          initialNotice={pendingNotice}
          onRefresh={async () => { const p = await invoke<Project>('open_project', { root: project.root }); setProject(p); }}
          openFileRef={openFileRef}
          syncRef={syncRef}
          settingsButton={settingsBtn('relative h-9 mx-2 my-0.5 rounded-md flex items-center justify-center text-content-faint hover:text-content-secondary')}
        />
        </Boundary>
      ) : (
        <StartView recent={recent} opening={opening} error={error} onOpen={openFolder} onOpenZip={openZip} onPull={() => setConnectOpen(true)} onCreate={setCreating}
          onRemove={(root) => { const l = recent.filter((r) => r.root !== root); writeRecent(l); setRecent(l); }} />
      )}

      {connectOpen && <ConnectDialog openRoot={project?.root} onClose={() => setConnectOpen(false)} onPulled={(root, note) => { setConnectOpen(false); if (note) setPendingNotice(note); openFolder(root); }} />}
      {creating && <CreateDialog what={creating} onClose={() => setCreating(null)} onCreated={(root) => { setCreating(null); openFolder(root); }} />}
      {zipAsk && <ZipDialog zip={zipAsk.zip} dest={zipAsk.dest} onCancel={() => setZipAsk(null)} onOk={unpack} />}
      {settingsAt && (
        <SettingsPopover at={settingsAt} pref={theme.pref} accent={theme.accent} onChange={(pref, accent) => setTheme({ pref, accent })} onClose={() => setSettingsAt(null)}
          onConnect={() => { setSettingsAt(null); setConnectOpen(true); }} />
      )}
      {paletteOpen && (
        <Palette project={project} recent={recent} onClose={() => setPaletteOpen(false)}
          onOpenFile={(p) => openFileRef.current(p)} onOpenFolder={(root) => openFolder(root)} onTheme={(pref) => setTheme((t) => ({ ...t, pref }))} />
      )}
    </div>
  );
}

function StartView({ recent, opening, error, onOpen, onOpenZip, onPull, onCreate, onRemove }: {
  recent: Recent[]; opening: string | null; error: string | null;
  onOpen: (root?: string) => void; onOpenZip: () => void; onPull: () => void; onCreate: (what: 'api' | 'fragment') => void; onRemove: (root: string) => void;
}) {
  const [createMenu, setCreateMenu] = useState(false);
  return (
    <div className="flex-1 min-h-0 overflow-auto flex justify-center">
      <div className="w-full max-w-[1000px] grid grid-cols-[340px_minmax(0,1fr)] gap-12 px-10 pt-14 pb-8 content-start">
        <section>
          <img src="/logo.svg" width={44} height={44} alt="" />
          <h1 className="mt-4 mb-1.5 text-[22px] font-bold">Design Center specs, on your desktop</h1>
          <p className="text-content-muted leading-relaxed">A desktop designer for Anypoint Design Center specs, RAML and OAS. Big specs open in seconds, and every edit is checked as you type.</p>
          <div className="relative mt-6">
            <button disabled={!isTauri || !!opening} onClick={() => setCreateMenu(!createMenu)}
              className="w-full flex items-center gap-3 p-3 rounded-lg border border-accent-border bg-accent-dim text-left hover:border-accent disabled:opacity-50 disabled:cursor-not-allowed">
              <span className="w-9 h-9 rounded-lg flex items-center justify-center text-accent-ink bg-accent"><Icons.Plus size={17} /></span>
              <span className="flex-1"><span className="block font-semibold">Create</span><span className="block text-[11.5px] text-content-faint">A new API specification or fragment</span></span>
              <Icons.ChevronDown size={13} />
            </button>
            {createMenu && <>
              <div className="fixed inset-0 z-30" onClick={() => setCreateMenu(false)} />
              <div className="absolute left-0 right-0 top-full mt-1 z-40 p-1 rounded-lg bg-surface-2 border border-line shadow-[var(--shadow)]">
                {([['api', 'New API Specification', 'How the API behaves and what it exchanges: RAML or OAS'], ['fragment', 'New Fragment', 'Pieces to reuse across APIs: a library, data type, trait…']] as const).map(([id, t, d]) => (
                  <button key={id} onClick={() => { setCreateMenu(false); onCreate(id); }} className="w-full px-2.5 py-2 rounded-md text-left hover:bg-surface-3">
                    <span className="block font-semibold text-[12.5px]">{t}</span><span className="block text-[11.5px] text-content-faint">{d}</span>
                  </button>
                ))}
              </div>
            </>}
          </div>
          <button
            disabled={!isTauri || !!opening}
            onClick={() => onOpen()}
            className="mt-2 w-full flex items-center gap-3 p-3 rounded-lg border border-line bg-surface text-left hover:border-accent-border disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <span className="w-9 h-9 rounded-lg flex items-center justify-center text-accent bg-accent-dim"><Icons.Folder size={17} /></span>
            <span className="flex-1"><span className="block font-semibold">Open folder</span><span className="block text-[11.5px] text-content-faint">A spec project on this computer</span></span>
            <span className="font-mono text-[10.5px] px-1.5 py-0.5 rounded bg-surface-3 text-content-muted">Ctrl O</span>
          </button>
          <button disabled={!isTauri || !!opening} onClick={onOpenZip}
            className="mt-2 w-full flex items-center gap-3 p-3 rounded-lg border border-line bg-surface text-left hover:border-accent-border disabled:opacity-50 disabled:cursor-not-allowed">
            <span className="w-9 h-9 rounded-lg flex items-center justify-center text-accent bg-accent-dim"><Icons.Package size={17} /></span>
            <span className="flex-1"><span className="block font-semibold">Open Design Center zip</span><span className="block text-[11.5px] text-content-faint">The zip from Download Project or Exchange</span></span>
          </button>
          <button disabled={!isTauri || !!opening} onClick={onPull}
            className="mt-2 w-full flex items-center gap-3 p-3 rounded-lg border border-line bg-surface text-left hover:border-accent-border disabled:opacity-50 disabled:cursor-not-allowed">
            <span className="w-9 h-9 rounded-lg flex items-center justify-center text-accent bg-accent-dim"><Icons.Download size={17} /></span>
            <span className="flex-1"><span className="block font-semibold">Pull from Design Center</span><span className="block text-[11.5px] text-content-faint">Sign in, open one project or pull them all</span></span>
          </button>
          {!isTauri && <p className="mt-3 text-[12px] text-warn">Running in a plain browser. Start the app with npm run tauri dev to open folders.</p>}
          {opening && <p className="mt-3 text-[12px] text-content-faint">Opening {opening}…</p>}
          {error && <p className="mt-3 text-[12px] text-err select-text">{error}</p>}
          <p className="mt-5 flex gap-2 text-[12px] text-content-faint"><span className="text-accent"><Icons.Dot size={12} /></span>Works offline. You only sign in to pull, push and publish.</p>
        </section>
        <section>
          <h2 className="text-[13px] font-semibold h-8 flex items-center">Recent projects</h2>
          {recent.length === 0 ? (
            <div className="mt-2 rounded-lg border border-line bg-surface p-10 text-center text-content-faint">
              <div className="font-semibold text-content">No recent projects yet</div>
              <div className="mt-1 text-[12.5px]">Projects you open show up here.</div>
            </div>
          ) : (
            <div className="mt-2 rounded-lg border border-line bg-surface overflow-hidden">
              {recent.map((r) => (
                <div key={r.root} onClick={() => isTauri && onOpen(r.root)}
                  className="group flex items-center gap-3 px-3 py-2.5 border-b border-line-secondary last:border-b-0 cursor-pointer hover:bg-surface-2">
                  <span className="w-[30px] h-[30px] rounded-md flex items-center justify-center bg-surface-2 border border-line-secondary text-content-muted"><Icons.Folder size={15} /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold">{r.name}</span>
                    <span className="block font-mono text-[11px] text-content-faint truncate">{r.root}</span>
                  </span>
                  <span className="text-[11.5px] text-content-faint">{ago(r.opened)}</span>
                  <button title="Remove from this list. The files stay where they are." onClick={(e) => { e.stopPropagation(); onRemove(r.root); }}
                    className="opacity-0 group-hover:opacity-100 w-6 h-6 rounded flex items-center justify-center text-content-faint hover:bg-surface-3 hover:text-content">
                    <Icons.X size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

// One open file: its editor state and the text on disk (with LF line endings, as the editor holds it).
type OpenFile = { state: EditorState; disk: string };

function ProjectView({ project, initialNotice, onDirtyCount, onRefresh, openFileRef, syncRef, settingsButton }: {
  project: Project; initialNotice: string | null; onDirtyCount: (n: number) => void; onRefresh: () => Promise<void>; openFileRef: MutableRefObject<(path: string) => void>;
  syncRef: MutableRefObject<SyncHooks | null>; settingsButton: ReactNode;
}) {
  const [filter, setFilter] = useState('');
  const [openDirs, setOpenDirs] = useState<Set<string>>(new Set());
  const [tabs, setTabs] = useState<string[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [crumb, setCrumb] = useState<{ key: string; from: number }[]>([]);
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const [notice, setNotice] = useState<{ text: string; err: boolean; actions?: [string, () => void][] } | null>(null);
  const fail = (e: unknown) => setNotice({ text: String(e), err: true });
  useEffect(() => { if (initialNotice) setNotice({ text: initialNotice, err: false }); }, [initialNotice]);
  const [rail, setRail] = useState<'files' | 'api' | 'deps' | 'exchange' | 'map'>('api');
  // The Publish dialog, open with a suggested version (or '' for Design Center's own rule).
  const [publishing, setPublishing] = useState<string | null>(null);
  const [published, setPublished] = useState(0); // remounts the Exchange panel after a publish
  // The root file's text for the API map (its !include lines place example files): open, or from disk.
  const [mapRoot, setMapRoot] = useState('');
  const [outline, setOutline] = useState<Outline | null>(null);
  const [shelf, setShelf] = useState<ShelfCtx | null>(null);
  const [shelfOpen, setShelfOpen] = useState(true);
  const [inspOpen, setInspOpen] = useState(() => { try { return localStorage.getItem('ads.inspector') !== '0'; } catch { return true; } });
  const [rpanel, setRpanel] = useState<'insp' | 'docs'>('insp');
  useEffect(() => { try { localStorage.setItem('ads.inspector', inspOpen ? '1' : '0'); } catch { /* ignore */ } }, [inspOpen]);
  // What the Inspector shows: the active file's text and the cursor's line.
  const [doc, setDoc] = useState<{ path: string; text: string; line: number } | null>(null);
  const [selId, setSelId] = useState<string | null>(null);
  const [closedSecs, setClosedSecs] = useState<Set<string>>(new Set(['Resource types', 'Security schemes']));
  const libTexts = useRef(new Map<string, string>());
  const [problems, setProblems] = useState<Problem[]>([]);
  // The API as AMF reads it (types, their uses, positions), refreshed by each full check.
  const [amfModel, setAmfModel] = useState<AmfModel | null>(null);
  const [problemsOpen, setProblemsOpen] = useState(false);
  const [engine, setEngine] = useState<{ state: string; detail: string; ms?: string }>({ state: 'starting', detail: '' });
  const gen = useRef(0), applied = useRef(0), sentOverlay = useRef(new Set<string>());
  const checkTimers = useRef<number[]>([]);
  const scheduleRef = useRef<() => void>(() => {});
  const outlineTimer = useRef<number>(0);
  const files = useRef(new Map<string, OpenFile>());
  const activeRef = useRef<string | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);

  useEffect(() => { onDirtyCount(dirty.size); }, [dirty, onDirtyCount]);

  // Keeps React in step with the editor: dirty dots, breadcrumb, Ln/Col.
  const listener = useMemo(() => EditorView.updateListener.of((u) => {
    const path = activeRef.current; if (!path) return;
    if (u.docChanged) {
      const f = files.current.get(path);
      const isDirty = !!f && u.state.doc.toString() !== f.disk;
      setDirty((d) => { if (d.has(path) === isDirty) return d; const n = new Set(d); isDirty ? n.add(path) : n.delete(path); return n; });
    }
    if (u.docChanged || u.selectionSet) {
      const pos = u.state.selection.main.head, line = u.state.doc.lineAt(pos);
      setCursor({ line: line.number, col: pos - line.from + 1 });
      setCrumb(/\.(raml|ya?ml)$/i.test(path) ? yamlPathAt(u.state, pos) : []);
      updateCursorViews(path, u.state);
      setDoc({ path, text: u.state.doc.toString(), line: line.number - 1 });
    }
    if (u.docChanged) scheduleRef.current();
    if (u.docChanged && (path === project.main || libraryFiles.current.has(path))) {
      clearTimeout(outlineTimer.current);
      outlineTimer.current = window.setTimeout(rebuildOutline, 120);
    }
  }), []); // eslint-disable-line react-hooks/exhaustive-deps
  const libraryFiles = useRef(new Set<string>());

  // The text of a file as the user sees it: the editor's when it's open, else what we read from disk.
  const textOf = (path: string): string | undefined => {
    if (path === activeRef.current && view.current) return view.current.state.doc.toString();
    return files.current.get(path)?.state.doc.toString() ?? libTexts.current.get(path);
  };

  async function rebuildOutline() {
    const main = project.main; if (!main) { setOutline(null); return; }
    const rootText = textOf(main); if (rootText == null) return;
    if (isOasYaml(main, rootText)) { setOutline(buildOasOutline(main, rootText)); return; }
    if (isOasJson(main, rootText)) { const o = buildOasJsonOutline(main, rootText); if (o) setOutline(o); return; } // unreadable JSON keeps the last tree
    if (!/\.raml$/i.test(main)) { setOutline(null); return; }
    const libs = libraryPaths(main, rootText);
    libraryFiles.current = new Set(libs.map((l) => l.path));
    for (const l of libs) {
      if (textOf(l.path) == null && project.files.some((f) => f.path === l.path)) {
        try { libTexts.current.set(l.path, (await invoke<string>('read_text_file', { root: project.root, path: l.path })).replace(/\r\n/g, '\n')); } catch { /* a missing library shows as a problem later */ }
      }
    }
    const texts = new Map<string, string>();
    libs.forEach((l) => { const t = textOf(l.path); if (t != null) texts.set(l.path, t); });
    setOutline(buildOutline(main, rootText, texts));
  }

  // Shelf context and tree selection follow the cursor in the root file.
  function updateCursorViews(path: string, state: EditorState) {
    const pos = state.selection.main.head, line = state.doc.lineAt(pos), text = state.doc.toString();
    // OAS: the tree selection follows paths, operations and schemas; there's no shelf for OAS.
    if (path === project.main && isOasJson(path, text)) { setShelf(null); setSelId(oasJsonSelection(text, line.from + line.text.search(/\S|$/))); return; }
    if (path === project.main && isOasYaml(path, text)) {
      setShelf(null);
      const k = keyPathAt(text, line.number - 1).map((e) => e.key);
      setSelId(k[0] === 'paths' && k[1] ? (METHODS.includes(k[2]) ? `m:${k[2]}:${k[1]}` : 'res:' + k[1]) : k[0] === 'components' && k[1] === 'schemas' && k[2] ? 'type:' + k[2] : null);
      return;
    }
    if (path !== project.main || !/\.raml$/i.test(path)) { setShelf(null); return; }
    setShelf(shelfContext(text, line.number - 1, pos - line.from));
    const kp = keyPathAt(text, line.number - 1);
    const mi = kp.findIndex((e) => METHODS.includes(e.key));
    const resPath = kp.filter((e, i) => e.key.startsWith('/') && (mi < 0 || i < mi)).map((e) => e.key).join('');
    setSelId(mi >= 0 ? `m:${kp[mi].key}:${resPath}` : resPath ? 'res:' + resPath : null);
  }

  function shelfInsert(item: string) {
    const v = view.current, path = activeRef.current; if (!v || !path || !shelf) return;
    const pos = v.state.selection.main.head, line = v.state.doc.lineAt(pos).number - 1;
    const edit = shelfEdit(v.state.doc.toString(), line, shelf, item); if (!edit) return;
    v.dispatch({ changes: { from: edit.from, to: edit.to, insert: edit.insert }, selection: { anchor: edit.cursor }, scrollIntoView: true });
    v.focus();
  }

  // A form edit from the Inspector: the smallest change to the active file, one undo step, editor focus left alone.
  function applyForm(fn: (t: string) => string) {
    const v = view.current; if (!v || !activeRef.current || isReadOnly(activeRef.current)) return;
    const t = v.state.doc.toString(), nt = fn(t); if (nt === t) return;
    v.dispatch({ changes: diff(t, nt), userEvent: 'input.form' });
  }
  function goOffset(pos: number) {
    const v = view.current; if (!v) return;
    pos = Math.min(pos, v.state.doc.length);
    v.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'nearest', yMargin: 60 }) });
  }
  // Selecting something in the Inspector selects it in the code.
  function goLine(n: number) {
    const v = view.current; if (!v) return;
    const l = v.state.doc.line(Math.min(n + 1, v.state.doc.lines)), pos = l.from + (l.text.match(/^\s*(- )?/)?.[0].length ?? 0);
    v.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'nearest', yMargin: 60 }) });
  }

  useEffect(() => {
    view.current = new EditorView({ parent: host.current! });
    if (import.meta.env.DEV) (window as unknown as { __view: EditorView }).__view = view.current; // for UI checks over CDP
    return () => view.current?.destroy();
  }, []);

  function show(path: string) {
    const v = view.current!, f = files.current.get(path)!;
    if (activeRef.current && files.current.has(activeRef.current)) files.current.get(activeRef.current)!.state = v.state;
    activeRef.current = path;
    v.setState(f.state);
    setActive(path);
    const pos = f.state.selection.main.head, line = f.state.doc.lineAt(pos);
    setCursor({ line: line.number, col: pos - line.from + 1 });
    setCrumb(/\.(raml|ya?ml)$/i.test(path) ? yamlPathAt(f.state, pos) : []);
    setDoc({ path, text: f.state.doc.toString(), line: line.number - 1 });
    updateCursorViews(path, f.state);
    v.focus();
  }

  async function openFile(path: string) {
    if (!files.current.has(path)) {
      let text: string;
      try { text = (await invoke<string>('read_text_file', { root: project.root, path })).replace(/\r\n/g, '\n'); }
      catch (e) { fail(e); return; }
      const ro = isReadOnly(path);
      files.current.set(path, {
        disk: text,
        state: EditorState.create({ doc: text, extensions: [...baseExtensions(), languageFor(path), ...assist(path), listener, EditorState.readOnly.of(ro), EditorView.editable.of(!ro)] }),
      });
    }
    setTabs((t) => (t.includes(path) ? t : [...t, path]));
    show(path);
  }
  openFileRef.current = openFile;
  // The title bar's sync controls: save every unsaved file first, show what happened, reload after a pull.
  syncRef.current = {
    saveAll: async () => { for (const p of [...dirty]) await save(p); },
    notice: (text, err) => setNotice({ text, err }),
    // The title bar's sync state recounts too: files can change on disk without an edit (dependencies, publish).
    reload: async () => { await onRefresh(); rebuildOutline(); scheduleRef.current(); window.dispatchEvent(new Event('ads-files-changed')); },
    publish: () => setPublishing(''),
  };
  const listPaths = async () => (await invoke<Project>('open_project', { root: project.root })).files.map((f) => f.path);
  useEffect(() => {
    if (rail !== 'map' || !project.main) return;
    const t = textOf(project.main);
    if (t != null) setMapRoot(t); else invoke<string>('read_text_file', { root: project.root, path: project.main }).then((x) => setMapRoot(x.replace(/\r\n/g, '\n')), () => {});
  }, [rail, amfModel]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- Autocomplete, hover and go to definition (M1 step 5). All local, from the outline. ----------
  const outlineRef = useRef<Outline | null>(null);
  outlineRef.current = outline;

  // Names a file can use: its own declarations bare, library ones as alias.Name through the root's uses:.
  function namesFor(path: string, kind: 'types' | 'traits' | 'resourceTypes') {
    const o = outlineRef.current; if (!o) return [];
    const own = o.libraries.find((l) => l.path === path)?.alias ?? null;
    return o[kind].map((d) => ({ d, label: d.alias && d.alias !== own ? `${d.alias}.${d.name}` : d.name }))
      .filter(({ d }) => path === project.main || d.alias === own || d.alias !== null);
  }

  function findDecl(path: string, word: string) {
    const o = outlineRef.current; if (!o) return null;
    const own = o.libraries.find((l) => l.path === path)?.alias ?? null;
    const [a, n] = word.includes('.') ? word.split('.') : [own, word];
    return [...o.types, ...o.traits, ...o.resourceTypes, ...o.securitySchemes].find((d) => d.name === n && (d.alias ?? null) === (a ?? null)) ?? null;
  }

  function relInclude(from: string, target: string) {
    const fromDir = from.includes('/') ? from.slice(0, from.lastIndexOf('/')).split('/') : [];
    const t = target.split('/');
    let i = 0; while (i < fromDir.length && i < t.length - 1 && fromDir[i] === t[i]) i++;
    return [...fromDir.slice(i).map(() => '..'), ...t.slice(i)].join('/');
  }

  const completions = (path: string) => (ctx: CompletionContext): CompletionResult | null => {
    const line = ctx.state.doc.lineAt(ctx.pos), before = line.text.slice(0, ctx.pos - line.from);
    const inc = before.match(/!include\s+(\S*)$/);
    if (inc) {
      const opts = project.files.map((f) => f.path).filter((p) => p !== path && /\.(raml|json|ya?ml|xsd|xml|md)$/i.test(p))
        .map((p) => ({ label: relInclude(path, p), detail: p.startsWith('exchange_modules/') ? 'Exchange' : undefined, type: 'text' }));
      return { from: ctx.pos - inc[1].length, options: opts, validFor: /^[\w./-]*$/ };
    }
    const tv = before.match(/(?:^|\s)(?:type|items):\s*([\w.]*)$/) || before.match(/\|\s*([\w.]*)$/);
    if (tv) {
      const crumb = yamlPathAt(ctx.state, ctx.pos);
      const underResource = crumb.length >= 2 && crumb[crumb.length - 2].key.startsWith('/');
      const opts = underResource
        ? namesFor(path, 'resourceTypes').map(({ label }) => ({ label, type: 'class', detail: 'resource type' }))
        : [...namesFor(path, 'types').map(({ d, label }) => ({ label, type: 'class', detail: d.alias ?? 'type' })), ...BUILTIN_TYPES.map((t) => ({ label: t, type: 'keyword', detail: 'built-in' }))];
      return { from: ctx.pos - tv[1].length, options: opts, validFor: /^[\w.]*$/ };
    }
    const is = before.match(/is:\s*\[[^\]]*?([\w.-]*)$/);
    if (is) return { from: ctx.pos - is[1].length, options: namesFor(path, 'traits').map(({ d, label }) => ({ label, type: 'interface', detail: d.alias ?? 'trait' })), validFor: /^[\w.-]*$/ };
    // A key being typed: what the shelf would offer here, plus media types and status codes.
    const key = before.match(/^(\s*)([\w/{}.-]*)$/);
    if (key && (ctx.explicit || key[2].length > 0) && path === project.main) {
      const sc = shelfContext(ctx.state.doc.toString(), line.number - 1, key[1].length);
      if (sc.kind !== 'keys') return null;
      const opts = sc.cols.flatMap((c) => c.items.map((i) => ({ label: i, type: METHODS.includes(i) ? 'method' : /^\d{3}$/.test(i) ? 'constant' : 'property', detail: c.title.toLowerCase(), apply: i + ':' + (SCALAR_KEYS.includes(i) ? ' ' : '') })));
      return { from: ctx.pos - key[2].length, options: opts, validFor: /^[\w/{}.-]*$/ };
    }
    return null;
  };

  // The word under a position that could name a declaration: alias.Name or Name.
  const wordAt = (state: EditorState, pos: number) => {
    const line = state.doc.lineAt(pos), t = line.text, i = pos - line.from;
    let s = i, e = i;
    while (s > 0 && /[\w.-]/.test(t[s - 1])) s--;
    while (e < t.length && /[\w.-]/.test(t[e])) e++;
    return { text: t.slice(s, e).replace(/\[\]$/, ''), from: line.from + s, to: line.from + e, line: t };
  };
  async function goToDefinition(path: string, state: EditorState, pos: number) {
    const w = wordAt(state, pos);
    const inc = w.line.match(/!include\s+(\S+)/) || w.line.match(/^\s*(?:- )?[\w-]+\s*:\s*(\S+\.(?:raml|json|ya?ml|xsd|xml|md))\s*$/);
    if (inc && w.line.indexOf(inc[1]) <= pos - state.doc.lineAt(pos).from) {
      const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
      const target = inc[1].startsWith('/') ? inc[1].slice(1) : normalizePath(dir + inc[1]);
      if (project.files.some((f) => f.path === target)) { await openFile(target); return true; }
      fail(`${target} doesn't exist.`); return true;
    }
    const d = findDecl(path, w.text); if (!d) return false;
    await reveal(d.file, d.from); setSelId(d.id); return true;
  }
  const hover = (path: string) => hoverTooltip((view, pos) => {
    const w = wordAt(view.state, pos); const d = w.text && findDecl(path, w.text); if (!d) return null;
    const text = textOf(d.file); if (text == null) return null;
    const startLine = text.slice(0, d.from).split('\n').length - 1, L = text.split('\n');
    const ind = L[startLine].match(/^\s*/)![0].length;
    let end = startLine + 1; while (end < L.length && (L[end].trim() === '' || L[end].match(/^\s*/)![0].length > ind)) end++;
    const body = L.slice(startLine, Math.min(end, startLine + 14)).map((l) => l.slice(ind)).join('\n').trimEnd();
    return { pos: w.from, end: w.to, above: true, create: () => {
      const dom = document.createElement('div');
      dom.style.cssText = 'padding:8px 10px;max-width:460px;font-family:var(--font-mono);font-size:12px;white-space:pre;color:var(--content-secondary)';
      dom.textContent = body + (end - startLine > 14 ? '\n…' : '') + `\n\n${d.file}  (F12 to open)`;
      return { dom };
    } };
  });

  // Rename Symbol (F2), as Design Center's: the declaration and every use, never plain mentions in descriptions.
  async function renameSymbol(path: string, state: EditorState, pos: number) {
    const w = wordAt(state, pos); const d = w.text ? findDecl(path, w.text) : null;
    if (!d) { fail('Put the cursor on a type, trait, resource type or security scheme name to rename it.'); return; }
    setDialog(<TextDialog title={`Rename ${d.alias ? d.alias + '.' : ''}${d.name}`} label="New name" value={d.name} okLabel="Rename"
      hint="Changes the declaration and every place it's used, in every file." onCancel={() => setDialog(null)}
      onOk={async (nu) => {
        setDialog(null);
        if (!/^[A-Za-z_][\w-]*$/.test(nu)) { fail(`${nu} isn't a valid name.`); return; }
        const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        let uses = 0;
        for (const f of project.files.map((x) => x.path).filter((p) => /\.(raml|ya?ml)$/i.test(p))) {
          let text = await readAny(f);
          const before = text;
          // Qualified uses through this file's own aliases for the declaring library.
          const dir = f.includes('/') ? f.slice(0, f.lastIndexOf('/') + 1) : '';
          const E = entries(text), u = E.findIndex((e) => e.ind === 0 && e.key === 'uses');
          const aliases = u < 0 ? [] : kids(E, u).filter((j) => (E[j].val.startsWith('/') ? E[j].val.slice(1) : normalizePath(dir + E[j].val)) === d.file).map((j) => E[j].key);
          for (const a of aliases) text = text.replace(new RegExp(`\\b${esc(a)}\\.${esc(d.name)}\\b`, 'g'), () => { uses++; return `${a}.${nu}`; });
          if (f === d.file) {
            // Bare uses inside the declaring file, in value positions only (type: X, X[], X | Y, [X, Y]).
            text = text.split('\n').map((line) => {
              // A "- Name" item of a block list (is:, a union written as a list) is a use too.
              const item = line.match(/^(\s*-\s+)([^\s#:]+)(\s*(#.*)?)$/);
              if (item) return item[2].replace(/\[\]$/, '') === d.name ? (uses++, item[1] + item[2].replace(d.name, nu) + item[3]) : line;
              const m = line.match(/^(\s*(?:- )?[^:#]+?\s*:\s*)(.+)$/);
              if (!m || /^\s*(description|displayName|usage|title|example)\s*:/.test(line)) return line;
              const v = m[2].replace(new RegExp(`(^|[\\s|(\\[,])${esc(d.name)}(?=(\\[\\])?($|[\\s|),\\]]))`, 'g'), (_x, pre) => { uses++; return pre + nu; });
              return m[1] + v;
            }).join('\n');
            // The declaration itself.
            const L = text.split('\n'), at = before.slice(0, d.from).split('\n').length - 1;
            L[at] = L[at].replace(new RegExp(`^(\\s*)${esc(d.name)}(\\s*:)`), `$1${nu}$2`);
            text = L.join('\n');
          }
          if (text !== before) await writeAny(f, text);
        }
        setNotice({ text: `Renamed ${d.name} to ${nu} and ${uses} ${uses === 1 ? 'use' : 'uses'}.`, err: false });
        rebuildOutline(); runCheck('validate');
      }} />);
  }

  // Delete (Cascade), from ALS's list: the declaration and every use of it, in every file that can see it.
  async function deleteDecl(d: Decl) {
    const kind = d.kind === 'type' ? 'type' : d.kind === 'trait' ? 'trait' : 'rt';
    const sect = { type: 'types', trait: 'traits', rt: 'resourceTypes' }[kind];
    const files = [...new Set([project.main!, ...(outlineRef.current?.libraries ?? []).map((l) => l.path), d.file])].filter((f) => !isReadOnly(f));
    const plan: { f: string; after: string; uses: number }[] = [];
    for (const f of files) {
      let before: string; try { before = await readAny(f); } catch { continue; }
      // The name as this file writes it: bare in its own file, alias.Name through this file's uses:.
      const refs = [...(f === d.file ? [d.name] : []), ...libraryPaths(f, before).filter((l) => l.path === d.file).map((l) => `${l.alias}.${d.name}`)];
      let after = f === d.file ? removeNode(before, [sect, d.name]) : before;
      let uses = 0;
      for (const r of refs) { const res = dropRefs(after, r, kind); after = res.text; uses += res.uses; }
      if (after !== before) plan.push({ f, after, uses });
    }
    const uses = plan.reduce((a, p) => a + p.uses, 0);
    const what = { type: 'type', trait: 'trait', rt: 'resource type' }[kind];
    setDialog(<ConfirmDialog title={`Delete ${d.alias ? d.alias + '.' : ''}${d.name}?`} danger okLabel="Delete"
      body={<>Deletes the {what} {uses ? <>and removes it from the {uses === 1 ? 'one place that uses' : `${uses} places that use`} it, in {plan.map((p) => base(p.f)).join(', ')}.</> : 'Nothing uses it.'}
        {kind === 'type' && uses ? <> Where a property was only that type, it becomes <span className="font-mono">any</span>.</> : null} Ctrl Z undoes it in each open file.</>}
      onCancel={() => setDialog(null)}
      onOk={async () => {
        setDialog(null);
        for (const p of plan) await writeAny(p.f, p.after);
        setNotice({ text: `Deleted ${d.name}${uses ? ` and ${uses} ${uses === 1 ? 'use' : 'uses'}` : ''}.`, err: false });
        rebuildOutline(); runCheck('validate');
      }} />);
  }

  // Move a type from the root file into a library (an existing one, or a new file), as alias.Name from then on.
  async function moveToLibrary(d: Decl, lib: { path: string; alias: string; isNew: boolean }) {
    const root = project.main!;
    let rt = await readAny(root);
    const lines = declLines(rt, ['types', d.name]);
    // A library can't see the root file's types, so the type can't take along a use of one.
    const local = (outlineRef.current?.types ?? []).filter((t) => t.file === root && t.name !== d.name).map((t) => t.name);
    const stuck = local.filter((n) => usesName(lines.slice(1), n));
    if (stuck.length) { fail(`${d.name} uses ${stuck.join(', ')}, which ${stuck.length === 1 ? 'is' : 'are'} declared in ${base(root)}. Move ${stuck.length === 1 ? 'that' : 'those'} first.`); return; }
    let lt = lib.isNew ? '#%RAML 1.0 Library\n' : await readAny(lib.path);
    if (find(entries(lt), ['types', d.name]) >= 0) { fail(`${base(lib.path)} already has a type called ${d.name}.`); return; }
    lt = addChild(lt, ['types'], lines);
    // Library types it uses come along as uses: in the target library, with paths from there.
    const have = libraryPaths(lib.path, lt).map((l) => l.alias);
    for (const l of libraryPaths(root, rt)) {
      if (l.path !== lib.path && !have.includes(l.alias) && lines.some((x) => x.includes(l.alias + '.'))) lt = addChild(lt, ['uses'], [`${l.alias}: ${relInclude(lib.path, l.path)}`]);
    }
    rt = qualify(removeNode(rt, ['types', d.name]), d.name, `${lib.alias}.${d.name}`);
    if (!libraryPaths(root, rt).some((l) => l.alias === lib.alias)) rt = addChild(rt, ['uses'], [`${lib.alias}: ${relInclude(root, lib.path)}`]);
    if (lib.isNew) await invoke('save_text_file', { root: project.root, path: lib.path, text: lt }); else await writeAny(lib.path, lt);
    await writeAny(root, rt);
    if (lib.isNew) await onRefresh();
    setNotice({ text: `Moved ${d.name} to ${lib.path}. Uses in ${base(root)} now say ${lib.alias}.${d.name}.`, err: false });
    rebuildOutline(); runCheck('validate');
  }
  function openMove(d: Decl) {
    const libs = (outlineRef.current?.libraries ?? []).filter((l) => !isReadOnly(l.path));
    setDialog(<MoveDialog name={d.name} libs={libs} exists={(p) => project.files.some((f) => f.path === p)} onCancel={() => setDialog(null)}
      onOk={async (lib) => { setDialog(null); try { await moveToLibrary(d, lib); } catch (e) { fail(e); } }} />);
  }

  const assist = (path: string): Extension[] => [
    autocompletion({ override: [completions(path)], icons: false }),
    hover(path),
    keymap.of([{ key: 'F12', run: (v) => { goToDefinition(path, v.state, v.state.selection.main.head); return true; } },
      { key: 'F2', run: (v) => { renameSymbol(path, v.state, v.state.selection.main.head); return true; } }]),
    EditorView.domEventHandlers({ mousedown: (e, v) => {
      if (!(e.ctrlKey || e.metaKey)) return false;
      const pos = v.posAtCoords({ x: e.clientX, y: e.clientY }); if (pos == null) return false;
      e.preventDefault(); goToDefinition(path, v.state, pos); return true;
    } }),
  ];

  // ---------- Design Center's file actions (M1 step 6) ----------
  const [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(null);
  const [dialog, setDialog] = useState<ReactNode>(null);
  const isSpecFile = (p: string) => /\.(raml|ya?ml|json)$/i.test(p) && !p.startsWith('exchange_modules/') && p !== 'exchange.json' && !p.startsWith('examples/');

  // Text of any project file: the editor's when open, else the disk.
  async function readAny(path: string) {
    const t = textOf(path); if (t != null) return t;
    return (await invoke<string>('read_text_file', { root: project.root, path })).replace(/\r\n/g, '\n');
  }
  // Apply a whole-file edit: in the editor when the file is open (it becomes unsaved), else straight to disk.
  async function writeAny(path: string, text: string) {
    const f = files.current.get(path);
    if (f) {
      const state = path === activeRef.current ? view.current!.state : f.state;
      const tr = state.update({ changes: diff(state.doc.toString(), text) });
      const hadEdits = state.doc.toString() !== f.disk;
      if (path === activeRef.current) view.current!.dispatch(tr); else { f.state = tr.state; setDirty((d) => new Set(d).add(path)); }
      if (!hadEdits) await save(path); // a file operation saves what it changes, unless you had unsaved work there
    } else await invoke('save_text_file', { root: project.root, path, text });
  }

  async function setRootFile(path: string) {
    let ex = project.files.some((f) => f.path === 'exchange.json') ? await readAny('exchange.json') : '';
    ex = /"main"\s*:\s*"[^"]*"/.test(ex) ? ex.replace(/"main"\s*:\s*"[^"]*"/, `"main": "${path}"`) : `{\n  "main": "${path}"\n}\n`;
    await invoke('save_text_file', { root: project.root, path: 'exchange.json', text: ex });
    const f = files.current.get('exchange.json'); if (f) { f.disk = ex; f.state = f.state.update({ changes: { from: 0, to: f.state.doc.length, insert: ex } }).state; }
    await onRefresh();
  }

  // Every !include and uses: path that points at `from`, rewritten to point at `to`, in its own style.
  async function retargetReferences(from: string, to: string) {
    let count = 0;
    for (const f of project.files.map((x) => x.path).filter((p) => /\.(raml|ya?ml)$/i.test(p) && p !== from)) {
      const text = await readAny(f);
      const dir = f.includes('/') ? f.slice(0, f.lastIndexOf('/') + 1) : '';
      const resolve = (ref: string) => (ref.startsWith('/') ? ref.slice(1) : normalizePath(dir + ref));
      const restyle = (ref: string) => (ref.startsWith('/') ? '/' + to : relInclude(f, to));
      let changed = false;
      const next = text.replace(/(!include\s+)(\S+)/g, (m, a, ref) => { if (resolve(ref) !== from) return m; changed = true; count++; return a + restyle(ref); })
        .replace(/^(\s+[\w-]+\s*:\s*)(\S+\.raml)\s*$/gm, (m, a, ref) => { if (resolve(ref) !== from) return m; changed = true; count++; return a + restyle(ref); });
      if (changed) await writeAny(f, next);
    }
    return count;
  }

  async function renameFile(from: string, toName: string) {
    const dir = from.includes('/') ? from.slice(0, from.lastIndexOf('/') + 1) : '';
    const to = dir + toName;
    if (to === from) return;
    await invoke('rename_file', { root: project.root, from, to });
    const n = await retargetReferences(from, to);
    // Carry an open editor over to the new name.
    const f = files.current.get(from);
    if (f) { files.current.delete(from); files.current.set(to, f); setTabs((t) => t.map((x) => (x === from ? to : x))); if (activeRef.current === from) { activeRef.current = to; setActive(to); } }
    if (project.main === from) await setRootFile(to); else await onRefresh();
    setNotice({ text: `Renamed to ${to}${n ? `. Updated ${n} ${n === 1 ? 'reference' : 'references'}.` : '.'}`, err: false });
  }

  async function deleteFile(path: string) {
    const refs = [];
    for (const f of project.files.map((x) => x.path).filter((p) => /\.(raml|ya?ml)$/i.test(p) && p !== path)) {
      if ((await readAny(f)).includes(base(path))) refs.push(f);
    }
    setDialog(<ConfirmDialog title={`Delete ${base(path)}?`} danger okLabel="Move to Recycle Bin"
      body={<>It goes to the Recycle Bin, so you can get it back.{refs.length ? <> These files mention it and may break: <span className="font-mono text-[11.5px]">{refs.join(', ')}</span></> : null}</>}
      onCancel={() => setDialog(null)}
      onOk={async () => {
        setDialog(null);
        try { await invoke('delete_file', { root: project.root, path }); } catch (e) { fail(e); return; }
        if (files.current.has(path)) { setDirty((d) => { const n = new Set(d); n.delete(path); return n; }); closeTabQuiet(path); }
        await onRefresh();
      }} />);
  }

  function closeTabQuiet(path: string) {
    const rest = tabs.filter((t) => t !== path), i = tabs.indexOf(path);
    files.current.delete(path); setTabs(rest);
    if (activeRef.current === path) { activeRef.current = null; const next = rest[Math.min(i, rest.length - 1)]; if (next) show(next); else { setActive(null); view.current!.setState(EditorState.create({ doc: '' })); } }
  }

  function openDuplicate(path: string) {
    const canConvert = path === project.main && /\.raml$/i.test(path);
    setDialog(<DuplicateDialog path={path} canConvert={canConvert} exists={(p) => project.files.some((f) => f.path === p)}
      onCancel={() => setDialog(null)}
      onOk={async (target, fmt) => {
        let text: string;
        if (fmt === 'copy') text = await readAny(path);
        else {
          await syncOverlays();
          const r = await amf('convert', { path, to: fmt.startsWith('oas2') ? 'oas20' : 'oas30', syntax: fmt.endsWith('j') ? 'json' : 'yaml' });
          text = r.text;
        }
        await invoke('save_text_file', { root: project.root, path: target, text });
        setDialog(null);
        await onRefresh();
        openFile(target);
      }} />);
  }

  async function revealInFolder(path: string) {
    try { await revealItemInDir(project.root.replace(/[\\/]+$/, '') + '/' + path); } catch (e) { fail(e); }
  }

  function fileMenuItems(path: string): [string, (() => void) | null][] {
    // '' is the project's top (the + button), 'folder/' a folder: what can be made there.
    if (path === '' || path.endsWith('/')) {
      const folder = path.replace(/\/$/, '');
      return [
        ['New file…', () => setDialog(<NewFileDialog folder={folder} hasRoot={!!project.main} onClose={() => setDialog(null)} onMake={async (p, text) => {
          if (project.files.some((f) => f.path.toLowerCase() === p.toLowerCase())) throw new Error(`${p} already exists.`);
          await invoke('write_file_exact', { root: project.root, path: p, text });
          setDialog(null); await onRefresh();
          setOpenDirs((o) => { const n = new Set(o); const parts = p.split('/'); for (let i = 1; i < parts.length; i++) n.add(parts.slice(0, i).join('/')); return n; });
          openFile(p);
        }} />)],
        ['New folder…', () => setDialog(<TextDialog title="New folder" label="Name" value="" okLabel="Create" slashes hint={folder ? `Inside ${folder}. A / makes folders inside it.` : 'A / makes folders inside it.'}
          onCancel={() => setDialog(null)} onOk={async (v) => {
            setDialog(null);
            const parts = v.trim().replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
            try {
              for (let i = 1; i <= parts.length; i++) { const d = [folder, ...parts.slice(0, i)].filter(Boolean).join('/'); if (!(project.dirs ?? []).includes(d)) await invoke('create_dir', { root: project.root, path: d }).catch((e) => { if (i === parts.length) throw e; }); }
              await onRefresh();
              setOpenDirs((o) => { const n = new Set(o); for (let i = 1; i <= parts.length; i++) n.add([folder, ...parts.slice(0, i)].filter(Boolean).join('/')); if (folder) n.add(folder); return n; });
            } catch (e) { fail(e); }
          }} />)],
        ...(folder ? [['Show in folder', () => revealInFolder(folder)] as [string, () => void]] : []),
      ];
    }
    if (isReadOnly(path)) return [['Show in folder', () => revealInFolder(path)]];
    return [
      ...(isSpecFile(path) && path !== project.main ? [['Set as root file', () => setRootFile(path)] as [string, () => void]] : []),
      ['Rename…', () => setDialog(<TextDialog title={`Rename ${base(path)}`} label="New name" value={base(path)} okLabel="Rename"
        hint="Every !include and uses: that points at it is updated." onCancel={() => setDialog(null)}
        onOk={async (v) => { setDialog(null); try { await renameFile(path, v); } catch (e) { fail(e); } }} />)],
      ['Duplicate…', () => openDuplicate(path)],
      ['Show in folder', () => revealInFolder(path)],
      ['Delete…', path === project.main ? null : () => deleteFile(path)],
    ];
  }

  // ---------- Changes on disk, and the recovery journal (M1 step 7) ----------
  const fsTimer = useRef(0), fsPending = useRef(new Set<string>()), journaled = useRef(new Set<string>());

  async function onDiskChange(paths: string[]) {
    let listChanged = false, outlineChanged = false;
    for (const path of paths) {
      if (!project.files.some((f) => f.path === path)) { listChanged = true; continue; }
      let disk: string;
      try { disk = (await invoke<string>('read_text_file', { root: project.root, path })).replace(/\r\n/g, '\n'); }
      catch { listChanged = true; continue; } // gone: deleted or renamed outside the app
      const f = files.current.get(path);
      if (!f || disk === f.disk) continue; // not open, or our own save
      if (path === project.main || libraryFiles.current.has(path)) outlineChanged = true;
      const current = textOf(path) ?? f.disk;
      const load = () => {
        f.disk = disk;
        const state = path === activeRef.current ? view.current!.state : f.state;
        const tr = state.update({ changes: { from: 0, to: state.doc.length, insert: disk } });
        if (path === activeRef.current) view.current!.dispatch(tr); else f.state = tr.state;
        setDirty((d) => { const n = new Set(d); n.delete(path); return n; });
      };
      if (current === f.disk) load(); // no edits of yours: take the new version quietly
      else setNotice({ text: `${base(path)} changed on disk, and you have unsaved edits in it.`, err: true, actions: [
        ['Keep mine', () => { f.disk = disk; setNotice(null); }],
        ['Load from disk', () => { load(); setNotice(null); }],
      ] });
    }
    if (listChanged) await onRefresh();
    if (outlineChanged) rebuildOutline();
    if (listChanged || outlineChanged) scheduleRef.current();
  }

  useEffect(() => {
    if (!isTauri) return;
    invoke('watch_project', { root: project.root }).catch(() => {});
    const un = listen<{ paths: string[] }>('fs-change', (e) => {
      e.payload.paths.forEach((p) => fsPending.current.add(p));
      clearTimeout(fsTimer.current);
      fsTimer.current = window.setTimeout(() => { const ps = [...fsPending.current]; fsPending.current.clear(); onDiskChange(ps); }, 250);
    });
    // Unsaved text found from last time: offer it back.
    invoke<{ path: string; text: string }[]>('list_recovery', { root: project.root }).then(async (list) => {
      const real: { path: string; text: string }[] = [];
      for (const r of list) {
        try { const disk = (await invoke<string>('read_text_file', { root: project.root, path: r.path })).replace(/\r\n/g, '\n'); if (disk !== r.text) real.push(r); else invoke('clear_recovery', { root: project.root, path: r.path }); }
        catch { real.push(r); }
      }
      if (!real.length) return;
      setNotice({ text: `Unsaved changes from last time were kept for ${real.length === 1 ? base(real[0].path) : real.length + ' files'}.`, err: false, actions: [
        ['Restore', async () => {
          for (const r of real) {
            await openFile(r.path);
            const v = view.current!; v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: r.text } });
          }
          setNotice(null);
        }],
        ['Discard', () => { real.forEach((r) => invoke('clear_recovery', { root: project.root, path: r.path })); setNotice(null); }],
      ] });
    });
    // Journal unsaved text every few seconds; clear it once a file is saved or reverted.
    const t = window.setInterval(() => {
      for (const [path, f] of files.current) {
        const text = textOf(path) ?? f.disk;
        if (text !== f.disk) { invoke('write_recovery', { root: project.root, path, text }); journaled.current.add(path); }
        else if (journaled.current.has(path)) { invoke('clear_recovery', { root: project.root, path }); journaled.current.delete(path); }
      }
    }, 4000);
    return () => { un.then((f) => f()); clearInterval(t); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- Live errors from amf-server: a quick parse after edits, a full check when idle or on save ----------
  const amf = (op: string, args: Record<string, unknown>) => invoke<any>('amf', { op, args }); // eslint-disable-line @typescript-eslint/no-explicit-any
  const checkable = !!project.main && /\.(raml|ya?ml|json)$/i.test(project.main);

  async function syncOverlays() {
    const changed: Record<string, string | null> = {};
    for (const [path, f] of files.current) {
      const text = textOf(path) ?? f.disk;
      if (text !== f.disk) { changed[path] = text; sentOverlay.current.add(path); }
      else if (sentOverlay.current.has(path)) { changed[path] = null; sentOverlay.current.delete(path); }
    }
    if (Object.keys(changed).length) await amf('overlay', { files: changed });
  }
  async function runCheck(mode: 'parse' | 'validate') {
    if (!checkable) return;
    const g = ++gen.current;
    setEngine((e) => (e.state === 'failed' ? e : { ...e, state: 'checking' }));
    try {
      await syncOverlays();
      const r = await amf('check', { mode, model: mode === 'validate' });
      if (r.stale || g < applied.current) return;
      applied.current = g;
      setProblems((prev) => (mode === 'validate' ? r.problems : [...r.problems, ...prev.filter((x) => x.phase === 'validate')]));
      if (r.model) setAmfModel(r.model);
      setEngine({ state: 'ready', detail: '', ms: mode === 'validate' ? `Checked in ${((r.parseMs + r.validateMs) / 1000).toFixed(1)} s` : `Read in ${(r.parseMs / 1000).toFixed(2)} s` });
    } catch (e) {
      // The checker answered but couldn't read the spec: that's a problem with the spec, not a dead
      // checker. (A dead or blocked checker is reported through the amf-status event instead.)
      const msg = String(e).replace(/^amf\.[\w.]+:\s*/, '');
      if (/didn't answer|isn't running|Couldn't start Java|didn't start/.test(msg)) { setEngine({ state: 'failed', detail: msg }); return; }
      setProblems([{ severity: 'error', message: `Couldn't check the spec: ${msg}`, file: project.main ?? '', line: 1, col: 0, endLine: 1, endCol: 0, phase: 'parse', code: '' }]);
      setEngine({ state: 'ready', detail: '' });
    }
  }
  scheduleRef.current = () => {
    checkTimers.current.forEach(clearTimeout);
    checkTimers.current = [window.setTimeout(() => runCheck('parse'), 300), window.setTimeout(() => runCheck('validate'), 1500)];
  };

  useEffect(() => {
    const un = listen<{ state: string; detail: string }>('amf-status', (e) => {
      if (e.payload.state === 'ready') { setEngine({ state: 'ready', detail: '' }); if (checkable) amf('open', { root: project.root, main: project.main }).then(() => runCheck('validate')).catch(() => {}); }
      else if (e.payload.state !== 'starting') setEngine({ state: e.payload.state, detail: e.payload.detail });
    });
    return () => { un.then((f) => f()); checkTimers.current.forEach(clearTimeout); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (project.main) openFile(project.main).then(rebuildOutline);
    if (checkable) amf('open', { root: project.root, main: project.main }).then(() => runCheck('validate')).catch((e) => setEngine({ state: 'failed', detail: String(e) }));
  }, [project.main]); // eslint-disable-line react-hooks/exhaustive-deps

  // Wavy underlines in the editor for the open file's problems.
  useEffect(() => {
    const v = view.current; if (!v || !active) return;
    const doc = v.state.doc;
    const diags: Diagnostic[] = problems.filter((p) => p.file === active).map((p) => {
      const l = doc.line(Math.min(Math.max(p.line, 1), doc.lines));
      const from = Math.min(l.from + p.col, l.to);
      const el = doc.line(Math.min(Math.max(p.endLine, p.line, 1), doc.lines)); // AMF reports some problems at line 0
      const to = Math.max(from, Math.min(el.from + p.endCol, el.to));
      return { from, to: to > from ? to : Math.min(from + 1, doc.length), severity: p.severity, message: p.message };
    });
    // AMF reports a bad example (or any included file) at its own location, where the fix goes. The
    // !include line that pulls it in gets marked too, so the problem shows where you wrote it.
    const dir = active.includes('/') ? active.slice(0, active.lastIndexOf('/') + 1) : '';
    for (let n = 1; n <= doc.lines; n++) {
      const l = doc.line(n), m = l.text.match(/!include\s+(\S+)/); if (!m) continue;
      const target = m[1].startsWith('/') ? m[1].slice(1) : normalizePath(dir + m[1]);
      const here = problems.filter((p) => p.file === target && p.file !== active);
      if (!here.length) continue;
      const from = l.from + l.text.indexOf(m[1]);
      const worst = here.some((p) => p.severity === 'error') ? 'error' : here.some((p) => p.severity === 'warning') ? 'warning' : 'info';
      // For an example, name the type it has to match: the type: next to it, at the same indent.
      let type = '';
      if (/^\s*(- )?examples?\s*:/.test(l.text)) {
        const ind = l.text.match(/^\s*/)![0].length;
        for (const dn of [-1, 1]) for (let k = n + dn; k >= 1 && k <= doc.lines && !type; k += dn) {
          const t = doc.line(k).text, ki = t.match(/^\s*/)![0].length;
          if (t.trim() && ki < ind) break;
          const tm = ki === ind && t.match(/^\s*type\s*:\s*(\S+)/); if (tm) type = tm[1];
        }
      }
      const head = type ? `This example doesn't match ${type}.` : `Problems in ${base(target)}.`;
      diags.push({ from, to: from + m[1].length, severity: worst, message: head + '\n' + here.map((p) => `${base(target)}, line ${p.line}: ${p.message}`).join('\n') });
    }
    v.dispatch(setDiagnostics(v.state, diags));
  }, [problems, active]);

  async function goToProblem(p: Problem) {
    await openFile(p.file);
    const v = view.current!, doc = v.state.doc, l = doc.line(Math.min(Math.max(p.line, 1), doc.lines));
    const pos = Math.min(l.from + p.col, l.to);
    v.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) }); v.focus();
  }

  async function save(path: string) {
    const f = files.current.get(path); if (!f) return;
    const state = path === activeRef.current ? view.current!.state : f.state;
    const text = state.doc.toString();
    try {
      await invoke('save_text_file', { root: project.root, path, text });
      f.disk = text;
      setDirty((d) => { const n = new Set(d); n.delete(path); return n; });
      runCheck('validate');
      invoke('clear_recovery', { root: project.root, path }).catch(() => {});
    } catch (e) { fail(e); }
  }

  function closeTab(path: string) {
    if (dirty.has(path) && !window.confirm(`${base(path)} has unsaved changes. Close it anyway?`)) return;
    const i = tabs.indexOf(path), rest = tabs.filter((t) => t !== path);
    files.current.delete(path);
    setDirty((d) => { const n = new Set(d); n.delete(path); return n; });
    setTabs(rest);
    if (activeRef.current === path) {
      activeRef.current = null;
      const next = rest[Math.min(i, rest.length - 1)];
      if (next) show(next); else { setActive(null); view.current!.setState(EditorState.create({ doc: '' })); }
    }
  }

  // Ctrl S saves this file, Ctrl Shift S saves them all. Ctrl W closes the tab.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
      if (mod && k === 's') { e.preventDefault(); if (e.shiftKey) [...dirty].forEach(save); else if (activeRef.current) save(activeRef.current); }
      else if (mod && k === 'w' && activeRef.current) { e.preventDefault(); closeTab(activeRef.current); }
      else if (mod && k === 'j') { e.preventDefault(); setProblemsOpen((o) => !o); }
      else if (mod && e.altKey && k === 'b') { e.preventDefault(); setInspOpen((o) => !o); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  async function reveal(path: string, from: number) {
    await openFile(path);
    const v = view.current!; v.dispatch({ selection: { anchor: Math.min(from, v.state.doc.length) }, effects: EditorView.scrollIntoView(Math.min(from, v.state.doc.length), { y: 'center' }) }); v.focus();
  }
  // A place AMF reported (line from 1, column from 0), in whichever file it is.
  async function revealAt(at: At) {
    await openFile(at.file);
    const v = view.current!, d = v.state.doc, l = d.line(Math.min(Math.max(at.r[0], 1), d.lines));
    const pos = Math.min(l.from + at.r[1], l.to);
    v.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) }); v.focus();
  }
  // AMF's JSON Schema for a declared type, onto the clipboard.
  async function copyJsonSchema(name: string, file: string) {
    try {
      await syncOverlays();
      const r = await amf('jsonSchema', { name, file });
      await navigator.clipboard.writeText(r.text);
      setNotice({ text: `Copied ${name} as JSON Schema.`, err: false });
    } catch (e) { fail(e); }
  }
  function jumpTo(from: number) {
    const v = view.current!; v.dispatch({ selection: { anchor: from }, scrollIntoView: true }); v.focus();
  }

  // A stable handler, so the API tree (hundreds of rows) isn't redrawn on every keystroke.
  const pickRef = useRef((_f: string, _from: number, _id: string) => {});
  pickRef.current = (file, from, id) => { setSelId(id); reveal(file, from); };
  const treePick = useMemo(() => (file: string, from: number, id: string) => pickRef.current(file, from, id), []);

  // Folders first, then files; a filter shows matching files with their folders open.
  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = project.files.filter((f) => !q || f.path.toLowerCase().includes(q));
    const dirs = new Set<string>();
    list.forEach((f) => { const parts = f.path.split('/'); for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/')); });
    if (!q) for (const d of project.dirs ?? []) if (!/^(exchange_modules|\.)/.test(d)) dirs.add(d); // empty folders too
    const out: { kind: 'dir' | 'file'; path: string; depth: number }[] = [];
    const walk = (prefix: string, depth: number) => {
      const here = (p: string) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/');
      [...dirs].filter(here).sort().forEach((d) => { out.push({ kind: 'dir', path: d, depth }); if (q || openDirs.has(d)) walk(d + '/', depth + 1); });
      list.map((f) => f.path).filter(here).sort().forEach((p) => out.push({ kind: 'file', path: p, depth }));
    };
    walk('', 0);
    return out;
  }, [project, filter, openDirs]);

  return (
    <>
      <div className="flex-1 min-h-0 flex">
        <nav className="w-12 shrink-0 bg-rail border-r border-line flex flex-col py-2.5">
          {([['files', 'Files', <Icons.File size={18} />], ['api', 'API', <Icons.ApiSpec size={18} />], ['deps', 'Dependencies', <Icons.Deps size={18} />], ['exchange', 'Exchange', <Icons.Exchange size={18} />], ['map', 'API map', <Icons.Map size={18} />]] as const).map(([id, title, icon]) => (
            <button key={id} title={title} onClick={() => setRail(id)}
              className={`relative h-9 mx-2 my-0.5 rounded-md flex items-center justify-center ${rail === id ? 'bg-surface-2 text-content' : 'text-content-faint hover:text-content-secondary'}`}>
              {rail === id && <span className="absolute -left-2 top-2 bottom-2 w-0.5 bg-accent rounded-sm" />}
              {icon}
            </button>
          ))}
          <div className="flex-1" />
          {settingsButton}
        </nav>

        {rail !== 'map' && <aside className="w-[272px] shrink-0 bg-surface border-r border-line flex flex-col min-h-0">
          <div className="h-9 shrink-0 flex items-center px-3 border-b border-line-subtle text-[12.5px] font-semibold"><span className="flex-1">{{ files: 'Files', api: 'API', deps: 'Dependencies', exchange: 'Exchange' }[rail]}</span>
            {rail === 'files' && <button title="New file or folder" onClick={(e) => { const b = e.currentTarget.getBoundingClientRect(); setMenu({ path: '', x: b.left, y: b.bottom + 2 }); }}
              className="w-6 h-6 rounded flex items-center justify-center text-content-faint hover:bg-surface-3 hover:text-content"><Icons.Plus size={14} /></button>}</div>
          {rail === 'deps' ? (
            <DepsPanel root={project.root} paths={listPaths} onChanged={async () => { await syncRef.current?.reload(); }}
              onNotice={(text, err) => setNotice({ text, err })} onOpenFile={(p) => openFile(p)} />
          ) : rail === 'exchange' ? (
            <ExchangePanel key={published} root={project.root} model={amfModel} onPublish={(v) => setPublishing(v)}
              modelOf={async (dir, main) => (await amf('modelOf', { dir, main })).model} />
          ) : <>
          <label className="m-2 mb-1 flex items-center gap-1.5 h-[26px] px-2 rounded-md bg-surface-2 border border-line text-content-faint focus-within:border-accent-border">
            <Icons.Search size={12} />
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={rail === 'files' ? 'Filter' : 'Filter resources and types'} spellCheck={false} className="flex-1 min-w-0 bg-transparent outline-none text-[12px] text-content" />
          </label>
          {rail === 'api' ? (
            <ApiTree outline={outline} rootFile={project.main ?? ''} filter={filter} selId={selId} closed={closedSecs} setClosed={setClosedSecs} noRoot={!project.main}
              onPick={treePick} />
          ) : (
          <div className="flex-1 overflow-auto pb-3">
            {rows.map((r) => r.kind === 'dir' ? (
              <div key={'d' + r.path} style={{ paddingLeft: 8 + r.depth * 14 }}
                onClick={() => { const n = new Set(openDirs); n.has(r.path) ? n.delete(r.path) : n.add(r.path); setOpenDirs(n); }}
                onContextMenu={(e) => { e.preventDefault(); setMenu({ path: r.path + '/', x: e.clientX, y: e.clientY }); }}
                className="flex items-center gap-1.5 h-6 pr-2 text-[12.5px] text-content-secondary cursor-pointer hover:bg-[var(--hover-overlay)]">
                <span className="w-3.5 flex justify-center text-content-ghost">{filter || openDirs.has(r.path) ? <Icons.ChevronDown size={11} /> : <Icons.ChevronRight size={11} />}</span>
                <span className="text-content-faint flex"><Icons.Folder size={13} /></span>
                <span className="truncate">{base(r.path)}</span>
              </div>
            ) : (
              <div key={'f' + r.path} onClick={() => openFile(r.path)} title={r.path} style={{ paddingLeft: 8 + r.depth * 14 + 20 }}
                onContextMenu={(e) => { e.preventDefault(); setMenu({ path: r.path, x: e.clientX, y: e.clientY }); }}
                className={`group/row relative flex items-center gap-1.5 h-6 pr-2 text-[12.5px] cursor-pointer ${active === r.path ? 'bg-accent-dim text-content' : 'text-content-secondary hover:bg-[var(--hover-overlay)]'}`}>
                {active === r.path && <span className="absolute left-0 top-0 bottom-0 w-0.5 bg-accent" />}
                <span className="truncate min-w-0" style={r.path === project.main ? { fontWeight: 600, color: 'var(--content)' } : undefined}>{dirty.has(r.path) ? '* ' : ''}{base(r.path)}</span>
                <span className="ml-auto shrink-0 flex items-center gap-1.5">
                  {r.path === project.main && <span className="text-[9.5px] font-semibold px-1.5 rounded border border-accent-border text-accent whitespace-nowrap">Root file</span>}
                  {isReadOnly(r.path) && <span className="text-content-faint flex" title="Read-only"><Icons.Lock size={12} /></span>}
                  <button title="More actions" onClick={(e) => { e.stopPropagation(); const b = e.currentTarget.getBoundingClientRect(); setMenu({ path: r.path, x: b.left, y: b.bottom + 2 }); }}
                    className="w-[18px] h-[18px] rounded flex items-center justify-center text-content-faint opacity-0 group-hover/row:opacity-100 hover:bg-surface-3 hover:text-content"><Icons.More size={13} /></button>
                </span>
              </div>
            ))}
            {rows.length === 0 && <div className="p-3 text-[12px] text-content-faint">No files match.</div>}
          </div>
          )}
          </>}
        </aside>}

        <main className="relative flex-1 min-w-0 flex flex-col bg-surface">
          {/* The map covers the editor, which stays as it was underneath. */}
          {rail === 'map' && <div className="absolute inset-0 z-20 flex flex-col bg-surface">
            <Boundary resetKey={project.root} fallback={(e) => <div className="p-4 text-[12.5px] text-err select-text">The map hit a problem: {e}.</div>}>
              <ApiMap model={amfModel} outline={outline} rootFile={project.main ?? ''} rootText={mapRoot}
                onOpenAt={(at) => { setRail('api'); revealAt(at); }} onReveal={(f, from) => { setRail('api'); reveal(f, from); }} />
            </Boundary>
          </div>}
          <div className="h-9 shrink-0 flex items-stretch bg-bg border-b border-line overflow-x-auto">
            {tabs.map((p) => (
              <div key={p} onClick={() => show(p)} onAuxClick={(e) => { if (e.button === 1) closeTab(p); }} title={p}
                className={`group relative flex items-center gap-2 pl-3 pr-2 text-[12.5px] border-r border-line-secondary cursor-pointer shrink-0 ${p === active ? 'bg-surface text-content' : 'text-content-faint hover:text-content-secondary'}`}>
                {p === active && <span className="absolute left-0 right-0 top-0 h-0.5 bg-accent" />}
                <span>{base(p)}</span>
                <button onClick={(e) => { e.stopPropagation(); closeTab(p); }} title={dirty.has(p) ? 'Unsaved changes. Close' : 'Close (Ctrl W)'}
                  className="w-4 h-4 rounded flex items-center justify-center text-content-faint hover:bg-surface-3 hover:text-content">
                  {dirty.has(p) ? <span className="w-[7px] h-[7px] rounded-full bg-content-muted group-hover:hidden" /> : null}
                  <span className={dirty.has(p) ? 'hidden group-hover:flex' : 'flex'}><Icons.X size={12} /></span>
                </button>
              </div>
            ))}
          </div>
          <div className="h-7 shrink-0 flex items-center gap-1 px-3 border-b border-line-subtle text-[12px] text-content-faint whitespace-nowrap overflow-hidden">
            {active && <span>{active}</span>}
            {crumb.map((c, i) => (
              <span key={i} className="flex items-center gap-1">
                <Icons.ChevronRight size={11} />
                <button onClick={() => jumpTo(c.from)} className={`px-1 rounded hover:bg-surface-2 hover:text-content ${c.key.startsWith('/') ? 'font-mono text-[11.5px]' : ''} ${i === crumb.length - 1 ? 'text-content-secondary' : ''}`}>
                  {METHODS.includes(c.key) ? <span className="font-mono text-[10px] font-bold uppercase">{c.key}</span> : c.key}
                </button>
              </span>
            ))}
            {active && isReadOnly(active) && <span className="ml-auto flex items-center gap-1"><Icons.Lock size={11} />Read-only: managed by Exchange</span>}
          </div>
          <div ref={host} className="flex-1 min-h-0 select-text" style={{ display: active ? 'block' : 'none' }} />
          {active === project.main && shelf && (
            <Shelf ctx={shelf} open={shelfOpen} setOpen={setShelfOpen} onPick={shelfInsert}
              types={(outline?.types ?? []).map((t) => (t.alias ? `${t.alias}.${t.name}` : t.name))} traits={(outline?.traits ?? []).map((t) => (t.alias ? `${t.alias}.${t.name}` : t.name))} />
          )}
          {checkable && <ProblemsPanel problems={problems} open={problemsOpen} setOpen={setProblemsOpen} engine={engine} onGo={goToProblem} />}
          {publishing != null && <PublishDialog root={project.root} main={project.main} paths={listPaths} model={amfModel} version={publishing || undefined}
            errors={problems.filter((x) => x.severity === 'error').length}
            onClose={() => setPublishing(null)} onShowErrors={() => { setPublishing(null); setProblemsOpen(true); }}
            onDone={async (text) => { setPublishing(null); await syncRef.current?.reload(); setPublished((n) => n + 1); setNotice({ text, err: false }); }} />}
          {!active && <div className="flex-1 flex items-center justify-center text-content-faint text-[12.5px]">{project.main ? 'Opening…' : 'No root file found. Pick a file on the left.'}</div>}
          {notice && (
            <div className={`shrink-0 flex items-center gap-2 px-3 py-2 border-t border-line bg-surface-2 text-[12px] ${notice.err ? 'text-err' : 'text-content-secondary'}`}>
              {!notice.err && <span className="text-accent flex"><Icons.Dot size={12} /></span>}
              <span className="flex-1 select-text">{notice.text}</span>
              {notice.actions?.map(([label, run]) => (
                <button key={label} onClick={run} className="h-6 px-2.5 rounded-md text-[12px] font-medium border border-line bg-surface text-content-secondary hover:text-content hover:border-content-ghost">{label}</button>
              ))}
              <button onClick={() => setNotice(null)} className="text-content-faint hover:text-content"><Icons.X size={12} /></button>
            </div>
          )}
        </main>
        {inspOpen && rpanel === 'docs' && (
          <aside className="w-[380px] shrink-0 bg-surface border-l border-line flex flex-col min-h-0">
            <div className="h-9 shrink-0 flex items-center px-3.5 border-b border-line-subtle text-[12.5px] font-semibold">Documentation</div>
            <Boundary resetKey={project.root} fallback={(e) => <div className="p-4 text-[12.5px] text-err select-text">The documentation hit a problem: {e}.</div>}>
              <DocsPanel model={amfModel} resolve={async () => (await amf('resolvedModel', {})).model} onOpenAt={revealAt} startMock={async () => ({ port: (await amf('mock', { on: true })).port })} />
            </Boundary>
          </aside>
        )}
        {inspOpen && rpanel === 'insp' && (
          <aside className="w-[330px] shrink-0 bg-surface border-l border-line flex flex-col min-h-0">
            <div className="h-9 shrink-0 flex items-center px-3.5 border-b border-line-subtle text-[12.5px] font-semibold">Inspector</div>
            <Boundary resetKey={doc ? doc.path + ":" + doc.line : ""} fallback={(e) => <div className="p-4 text-[12.5px] text-err select-text">The form hit a problem: {e}. The code editor still works; move the cursor to try again.</div>}>
            {doc && active === doc.path && /\.raml$/i.test(doc.path) ? (
              <Inspector file={doc.path} text={doc.text} line={doc.line} isMain={doc.path === project.main} readOnly={isReadOnly(doc.path)} outline={outline} model={amfModel}
                onEdit={applyForm} onGoLine={goLine} onOpen={(f, from) => reveal(f, from)} onOpenAt={revealAt} onJsonSchema={copyJsonSchema}
                onRename={(from) => { const v = view.current; if (v) renameSymbol(doc.path, v.state, from); }}
                onMove={openMove} onDelete={deleteDecl} />
            ) : doc && active === doc.path && isOasYaml(doc.path, doc.text) ? (
              <OasInspector file={doc.path} text={doc.text} line={doc.line} readOnly={isReadOnly(doc.path)} model={amfModel} onEdit={applyForm} onGoLine={goLine} onOpenAt={revealAt} onJsonSchema={copyJsonSchema} />
            ) : doc && active === doc.path && isOasJson(doc.path, doc.text) ? (
              <OasJsonInspector file={doc.path} text={doc.text} line={doc.line} readOnly={isReadOnly(doc.path)} model={amfModel} onEdit={applyForm} onGoOffset={goOffset} onOpenAt={revealAt} onJsonSchema={copyJsonSchema} />
            ) : (
              <div className="p-4 text-[12.5px] text-content-faint">{!active ? 'Open a file to see it here.' : 'Forms are for RAML 1.0 and OAS 3.0 specs.'}</div>
            )}
            </Boundary>
          </aside>
        )}
        <nav className="w-10 shrink-0 bg-rail border-l border-line flex flex-col items-center py-2.5">
          {([['insp', 'Inspector (Ctrl Alt B)', <Icons.Target size={17} />], ['docs', 'Documentation', <Icons.Book size={17} />]] as const).map(([id, title, icon]) => {
            const on = inspOpen && rpanel === id;
            return (
              <button key={id} title={title} onClick={() => { if (on) setInspOpen(false); else { setRpanel(id); setInspOpen(true); } }}
                className={`relative w-8 h-9 my-0.5 rounded-md flex items-center justify-center ${on ? 'bg-surface-2 text-content' : 'text-content-faint hover:text-content-secondary'}`}>
                {on && <span className="absolute -right-1 top-2 bottom-2 w-0.5 bg-accent rounded-sm" />}
                {icon}
              </button>
            );
          })}
        </nav>
      </div>
      {menu && (
        <div className="fixed inset-0 z-40" onMouseDown={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }}>
          <div className="fixed min-w-[190px] p-1 rounded-lg bg-surface-2 border border-line shadow-[var(--shadow)]" style={{ left: Math.min(menu.x, window.innerWidth - 210), top: Math.min(menu.y, window.innerHeight - 200) }} onMouseDown={(e) => e.stopPropagation()}>
            {fileMenuItems(menu.path).map(([label, run]) => (
              <button key={label} disabled={!run} onClick={() => { setMenu(null); run?.(); }}
                className="w-full h-7 px-2 rounded text-left text-[12.5px] text-content-secondary hover:bg-surface-3 hover:text-content disabled:text-content-ghost disabled:hover:bg-transparent">{label}</button>
            ))}
          </div>
        </div>
      )}
      {dialog}
      <footer className="h-[26px] shrink-0 flex items-center gap-3.5 px-3 bg-rail border-t border-line font-mono text-[11px] text-content-faint">
        <span className="text-content-secondary">{active ? base(active) : project.name}</span>
        {active && <span>{cursor.line}:{cursor.col}</span>}
        {active && active === project.main && <span>Root file</span>}
        <span className="flex-1" />
        <span>{project.files.length} files</span>
      </footer>
    </>
  );
}

// A bug in a form shows up in the Inspector, not as a blank window; moving the cursor tries again.
// Used twice: around the Inspector (a form bug leaves the editor working) and around the whole project
// view (a bug anywhere shows a message and a way back, never a blank window; unsaved text is in the
// recovery journal).
class Boundary extends Component<{ children: ReactNode; resetKey: string; fallback: (error: string) => ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(e: unknown) { return { error: e instanceof Error ? e.message : String(e) }; }
  componentDidUpdate(prev: { resetKey: string }) { if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null }); }
  render() { return this.state.error ? this.props.fallback(this.state.error) : this.props.children; }
}

const METHOD_STYLE: Record<string, string> = {
  get: 'text-cyan bg-cyan-tint', post: 'text-[var(--ok)] bg-[color-mix(in_oklch,var(--ok)_14%,transparent)]', put: 'text-warn bg-warn-tint',
  patch: 'text-violet bg-violet-tint', delete: 'text-err bg-err-tint', head: 'text-content-muted bg-surface-3', options: 'text-content-muted bg-surface-3',
};
function MethodBadge({ m }: { m: string }) {
  return <span className={`font-mono text-[9.5px] font-bold w-[38px] h-4 rounded-[3px] shrink-0 inline-flex items-center justify-center ${METHOD_STYLE[m] ?? ''}`}>{m.toUpperCase()}</span>;
}

const ApiTree = memo(function ApiTree({ outline, rootFile, filter, selId, closed, setClosed, noRoot, onPick }: {
  outline: Outline | null; rootFile: string; filter: string; selId: string | null; closed: Set<string>; setClosed: (s: Set<string>) => void; noRoot: boolean;
  onPick: (file: string, from: number, id: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  if (!outline) return <div className="p-3 text-[12px] text-content-faint">{noRoot ? 'No root file found, so there is no API to show. Open a file from Files.' : 'Reading the API…'}</div>;
  const q = filter.trim().toLowerCase();
  const match = (s: string) => !q || s.toLowerCase().includes(q);
  const resMatch = (r: Resource): boolean => match(r.path) || r.methods.some((m) => match(m.m + ' ' + m.name)) || r.children.some(resMatch);
  const row = (id: string, depth: number, inner: ReactNode, onClick: () => void, tail?: ReactNode) => (
    <div key={id} onClick={onClick} style={{ paddingLeft: 8 + depth * 14 }}
      className={`relative flex items-center gap-1.5 h-6 pr-2 text-[12.5px] whitespace-nowrap cursor-pointer ${selId === id ? 'bg-accent-dim text-content' : 'text-content-secondary hover:bg-[var(--hover-overlay)]'}`}>
      {selId === id && <span className="absolute left-0 top-0 bottom-0 w-0.5 bg-accent" />}
      {inner}
      {tail && <span className="ml-auto flex items-center gap-1">{tail}</span>}
    </div>
  );
  const sec = (name: string, count: ReactNode, body: ReactNode[]) => {
    const isClosed = closed.has(name) && !q;
    return (
      <div key={name}>
        <div onClick={() => { const n = new Set(closed); n.has(name) ? n.delete(name) : n.add(name); setClosed(n); }}
          className="flex items-center gap-1 h-[26px] mt-1.5 pl-1.5 pr-2.5 text-[10px] font-semibold uppercase tracking-[0.5px] text-content-faint cursor-pointer hover:text-content-secondary">
          {isClosed ? <Icons.ChevronRight size={11} /> : <Icons.ChevronDown size={11} />}{name}
          <span className="ml-auto normal-case tracking-normal font-medium text-[11px] text-content-ghost">{count}</span>
        </div>
        {!isClosed && body}
      </div>
    );
  };
  const resRows: ReactNode[] = [];
  const walk = (r: Resource, depth: number) => {
    if (!resMatch(r)) return;
    const open = !collapsed.has(r.id) || !!q;
    resRows.push(row(r.id, depth, <>
      <span className="w-3.5 flex justify-center text-content-ghost" onClick={(e) => { e.stopPropagation(); const n = new Set(collapsed); n.has(r.id) ? n.delete(r.id) : n.add(r.id); setCollapsed(n); }}>
        {open ? <Icons.ChevronDown size={11} /> : <Icons.ChevronRight size={11} />}
      </span>
      <span className="font-mono text-[12px] text-content truncate">{r.key}</span>
    </>, () => onPick(rootFile, r.from, r.id)));
    if (!open) return;
    r.methods.forEach((m) => { if (match(r.path) || match(m.m + ' ' + m.name)) resRows.push(row(m.id, depth + 1, <><span className="w-3.5" /><MethodBadge m={m.m} /><span className="text-[11.5px] text-content-faint truncate">{m.name}</span></>, () => onPick(rootFile, m.from, m.id))); });
    r.children.forEach((c) => walk(c, depth + 1));
  };
  outline.resources.forEach((r) => walk(r, 0));
  const all: Resource[] = []; const flat = (r: Resource) => { all.push(r); r.children.forEach(flat); }; outline.resources.forEach(flat);
  const nMethods = all.reduce((a, r) => a + r.methods.length, 0);
  const declRows = (list: Decl[], letter: string, color: string) => list.filter((d) => match((d.alias ? d.alias + '.' : '') + d.name)).map((d) =>
    row(d.id, 0, <><span className="w-3.5" /><span className={`font-mono text-[9.5px] font-bold w-4 h-4 rounded-[3px] inline-flex items-center justify-center ${color}`}>{letter}</span><span className="truncate">{d.name}</span></>,
      () => onPick(d.file, d.from, d.id), d.alias ? <span className="text-[11px] text-content-ghost">{d.alias}</span> : null));
  const oas = !/\.raml$/i.test(rootFile);
  return (
    <div className="flex-1 overflow-auto pb-3">
      {/* OAS uses its own words: paths and schemas, and has no traits, resource types or libraries. */}
      {sec(oas ? 'Paths' : 'Resources', `${all.length} · ${nMethods} ${oas ? 'operations' : 'methods'}`, resRows)}
      {sec(oas ? 'Schemas' : 'Types', outline.types.length, declRows(outline.types, oas ? 'S' : 'T', 'text-[var(--syn-number)] bg-[color-mix(in_oklch,var(--syn-number)_16%,transparent)]'))}
      {!oas && sec('Traits', outline.traits.length, declRows(outline.traits, 'Tr', 'text-violet bg-violet-tint'))}
      {!oas && sec('Resource types', outline.resourceTypes.length, declRows(outline.resourceTypes, 'RT', 'text-cyan bg-cyan-tint'))}
      {sec('Security schemes', outline.securitySchemes.length, declRows(outline.securitySchemes, 'S', 'text-warn bg-warn-tint'))}
      {!oas && sec('Libraries', outline.libraries.length, outline.libraries.filter((l) => match(l.alias)).map((l) =>
        row('lib:' + l.alias, 0, <><span className="w-3.5" /><span className="font-mono text-[9.5px] font-bold w-4 h-4 rounded-[3px] inline-flex items-center justify-center text-accent bg-accent-dim">L</span><span className="truncate">{l.alias}</span></>,
          () => onPick(l.path, 0, 'lib:' + l.alias), l.path.startsWith('exchange_modules/') ? <span className="text-[9.5px] font-semibold px-1 rounded border border-cyan-border text-cyan">Exchange</span> : null)))}
    </div>
  );
});

const SHELF_BAR: Record<string, string> = {
  Methods: 'var(--content-muted)', Docs: 'var(--cyan)', 'Types and Traits': 'var(--violet)', Security: 'var(--err)', Parameters: 'var(--cyan)', Body: 'var(--ok)',
  Responses: 'var(--warn)', Success: 'var(--ok)', 'Client errors': 'var(--warn)', 'Server errors': 'var(--err)', 'Media types': 'var(--cyan)',
  'Types and Examples': 'var(--violet)', Root: 'var(--warn)', Declarations: 'var(--violet)', Template: 'var(--content-muted)', Others: 'var(--content-faint)', Protocols: 'var(--content-muted)', Headers: 'var(--cyan)', Traits: 'var(--violet)',
};
// Design Center's shelf: what can go at the cursor, one click to insert.
function Shelf({ ctx, open, setOpen, onPick, types, traits }: {
  ctx: ShelfCtx; open: boolean; setOpen: (b: boolean) => void; onPick: (item: string) => void; types: string[]; traits: string[];
}) {
  let cols: { title: string; items: string[] }[] = [];
  if (ctx.kind === 'keys') cols = ctx.cols;
  else if (ctx.kind === 'type') {
    const groups = new Map<string, string[]>();
    types.forEach((t) => { const g = t.includes('.') ? t.split('.')[0] : 'This file'; groups.set(g, [...(groups.get(g) ?? []), t]); });
    cols = [...[...groups].map(([title, items]) => ({ title, items })), { title: 'Built-in', items: BUILTIN_TYPES.slice(0, 10) }];
  } else if (ctx.kind === 'is') cols = [{ title: 'Traits', items: traits }];
  // What's already there is highlighted: the current type, or the traits already applied.
  const current = ctx.kind === 'type' ? [ctx.value.replace(/\[\]$/, '')] : ctx.kind === 'is' ? ctx.value.replace(/[[\]]/g, '').split(',').map((s) => s.trim()) : [];
  return (
    <section className="shrink-0 flex flex-col bg-bg border-t border-line-subtle" style={{ height: open ? 136 : 26 }}>
      <div className="h-[26px] shrink-0 flex items-center gap-2 pl-3.5 pr-2 text-[11px] text-content-faint">
        <span>Shelf</span><span className="font-mono text-content-muted truncate">{ctx.label}</span>
        <span className="flex-1" />
        <button onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen(!open)} title={open ? 'Hide the shelf' : 'Show the shelf'}
          className="w-[22px] h-[22px] rounded flex items-center justify-center hover:bg-surface-2 hover:text-content">
          {open ? <Icons.ChevronDown size={12} /> : <span className="rotate-180 flex"><Icons.ChevronDown size={12} /></span>}
        </button>
      </div>
      {open && (cols.length ? (
        <div className="flex-1 overflow-auto flex gap-6 px-3.5 pb-2.5 items-start">
          {cols.map((c) => (
            // Columns never shrink below their longest name, so long type names can't run into the next column.
            <div key={c.title} className="min-w-[96px] shrink-0">
              <div className="text-[11.5px] font-semibold text-content-secondary mb-1">{c.title}</div>
              {c.items.map((it) => (
                <button key={it} onMouseDown={(e) => { e.preventDefault(); onPick(it); }} title={it}
                  style={{ borderLeftColor: SHELF_BAR[c.title] ?? 'var(--syn-number)' }}
                  className={`block text-left h-[22px] px-2 mb-px font-mono text-[12px] border-l-2 rounded-r hover:bg-surface-2 hover:text-content whitespace-nowrap ${current.includes(it) ? 'bg-accent-dim text-content' : 'text-content-secondary'}`}>
                  {/* Under a library's own column the alias is already the heading: show Name, insert alias.Name. */}
                  {it.startsWith(c.title + '.') ? it.slice(c.title.length + 1) : it}
                </button>
              ))}
            </div>
          ))}
        </div>
      ) : (
        <div className="px-3.5 py-1.5 text-[12px] text-content-faint">Nothing to add here. Put the cursor in a resource, method, responses or body.</div>
      ))}
    </section>
  );
}

type Problem = { severity: 'error' | 'warning' | 'info'; message: string; file: string; line: number; col: number; endLine: number; endCol: number; phase: string; code: string };

// Design Center's Project Errors: a bar with counts that opens into the list. Click a row to go there.
function ProblemsPanel({ problems, open, setOpen, engine, onGo }: {
  problems: Problem[]; open: boolean; setOpen: (b: boolean) => void; engine: { state: string; detail: string; ms?: string }; onGo: (p: Problem) => void;
}) {
  const nE = problems.filter((p) => p.severity === 'error').length, nW = problems.length - nE;
  const files = [...new Set(problems.map((p) => p.file))];
  const counts = (
    <span className="flex items-center gap-2 text-[12px]">
      <span className={`flex items-center gap-1 ${nE ? 'text-err' : 'text-content-faint'}`}><span className="w-2 h-2 rounded-full bg-current" />{nE}</span>
      <span className={`flex items-center gap-1 ${nW ? 'text-warn' : 'text-content-faint'}`}><span className="w-2 h-2 rotate-45 bg-current" />{nW}</span>
    </span>
  );
  return (
    <section className="shrink-0 flex flex-col bg-surface border-t border-line" style={{ height: open ? 190 : 28 }}>
      <div className="h-7 shrink-0 flex items-center gap-3 px-3 border-b border-line-subtle">
        <button onClick={() => setOpen(!open)} className="flex items-center gap-2.5 text-[12px] font-semibold text-content-secondary hover:text-content">
          Project errors {counts}
        </button>
        <span className="flex-1" />
        <span className="text-[11px] text-content-faint flex items-center gap-1.5">
          {engine.state === 'checking' && <span className="w-2.5 h-2.5 rounded-full border-2 border-warn border-t-transparent animate-spin" />}
          {engine.state === 'checking' ? 'Checking' : engine.state === 'ready' ? (engine.ms ?? '') : engine.state === 'starting' ? 'Starting the checker' : ''}
        </span>
        <button onClick={() => setOpen(!open)} title={open ? 'Hide (Ctrl J)' : 'Show (Ctrl J)'} className="w-[22px] h-[22px] rounded flex items-center justify-center text-content-faint hover:bg-surface-2 hover:text-content">
          {open ? <Icons.ChevronDown size={12} /> : <span className="rotate-180 flex"><Icons.ChevronDown size={12} /></span>}
        </button>
      </div>
      {open && (
        <div className="flex-1 overflow-auto py-1 select-text">
          {(engine.state === 'failed' || engine.state === 'stopped') && (
            <div className="mx-3 my-1.5 p-2.5 rounded-md border border-err-border bg-err-tint text-[12px]">
              <div className="font-semibold text-err">The checker isn't running, so errors aren't up to date. Editing still works.</div>
              {engine.detail && <pre className="mt-1.5 text-[11px] text-content-secondary whitespace-pre-wrap max-h-24 overflow-auto">{engine.detail}</pre>}
            </div>
          )}
          {problems.length === 0 && engine.state !== 'failed' && <div className="px-3 py-3 text-[12.5px] text-content-faint">No errors to show.</div>}
          {files.map((f) => (
            <div key={f}>
              <div className="h-6 flex items-center px-3 text-[12px] font-medium text-content-secondary">{base(f)} <span className="ml-2 text-[11px] font-normal text-content-faint">{f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : ''}</span></div>
              {problems.filter((p) => p.file === f).map((p, i) => (
                <div key={i} onClick={() => onGo(p)} className="flex items-center gap-2 min-h-[26px] pl-7 pr-3 text-[12.5px] cursor-pointer hover:bg-[var(--hover-overlay)]">
                  <span className={`w-2 h-2 shrink-0 ${p.severity === 'error' ? 'rounded-full bg-err' : 'rotate-45 bg-warn'}`} />
                  <span className="text-content">{p.message}</span>
                  <span className="ml-auto font-mono text-[11px] text-content-faint whitespace-nowrap">{p.line}:{p.col + 1}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ---------- Small dialogs: one look for all of them ----------
export function Modal({ title, sub, children, footer, onCancel, width = 460 }: { title: string; sub?: ReactNode; children: ReactNode; footer: ReactNode; onCancel: () => void; width?: number }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onCancel]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/40" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="rounded-[10px] bg-surface border border-line shadow-[var(--shadow)] overflow-hidden flex flex-col" style={{ width: `min(${width}px, 100%)` }}>
        <div className="flex items-start gap-2.5 px-4 pt-3.5 pb-3 border-b border-line bg-surface-2">
          <div className="flex-1"><div className="text-[14px] font-semibold">{title}</div>{sub && <div className="mt-0.5 text-[12px] text-content-muted">{sub}</div>}</div>
          <button onClick={onCancel} className="w-[22px] h-[22px] rounded flex items-center justify-center text-content-faint hover:bg-surface-3 hover:text-content"><Icons.X size={13} /></button>
        </div>
        <div className="p-4">{children}</div>
        <div className="flex items-center justify-end gap-2 px-4 py-2.5 border-t border-line bg-surface-2">{footer}</div>
      </div>
    </div>
  );
}
export const btn = 'h-[28px] px-3 rounded-md text-[12.5px] font-medium border border-line bg-surface-2 text-content-secondary hover:text-content hover:border-content-ghost disabled:opacity-45 disabled:cursor-not-allowed';
export const btnPrimary = 'h-[28px] px-3 rounded-md text-[12.5px] font-semibold bg-accent text-accent-ink hover:bg-accent-hover disabled:opacity-45 disabled:cursor-not-allowed';
const inputCls = 'w-full h-[30px] px-2.5 rounded-md border border-line bg-surface-input text-content outline-none text-[12.5px] focus:border-accent';

export function TextDialog({ title, label, value, okLabel, hint, slashes, onOk, onCancel }: { title: string; label: string; value: string; okLabel: string; hint?: string; slashes?: boolean; onOk: (v: string) => void; onCancel: () => void }) {
  const [v, setV] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { const i = ref.current!; i.focus(); const dot = value.lastIndexOf('.'); i.setSelectionRange(0, dot > 0 ? dot : value.length); }, [value]);
  // slashes: a path is fine (New folder makes the folders in between).
  const ok = v.trim() && v.trim() !== value && !(slashes ? /[\\:*?"<>|]/ : /[\\/:*?"<>|]/).test(v);
  return (
    <Modal title={title} onCancel={onCancel} footer={<><button className={btn} onClick={onCancel}>Cancel</button><button className={btnPrimary} disabled={!ok} onClick={() => onOk(v.trim())}>{okLabel}</button></>}>
      <label className="block mb-1.5 text-[11.5px] font-semibold text-content-secondary">{label}</label>
      <input ref={ref} className={inputCls + ' font-mono'} value={v} spellCheck={false} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && ok) onOk(v.trim()); }} />
      {hint && <div className="mt-1.5 text-[11.5px] text-content-faint">{hint}</div>}
    </Modal>
  );
}

function ConfirmDialog({ title, body, okLabel, danger, onOk, onCancel }: { title: string; body: ReactNode; okLabel: string; danger?: boolean; onOk: () => void; onCancel: () => void }) {
  return (
    <Modal title={title} onCancel={onCancel} footer={<><button className={btn} onClick={onCancel}>Cancel</button>
      <button className={danger ? 'h-[28px] px-3 rounded-md text-[12.5px] font-semibold bg-err text-white hover:opacity-90' : btnPrimary} onClick={onOk} autoFocus>{okLabel}</button></>}>
      <div className="text-[12.5px] text-content-secondary leading-relaxed">{body}</div>
    </Modal>
  );
}

// Design Center's "Duplicate As": a copy, or the root spec converted between RAML and OAS.
// Move to library: pick one of the project's libraries, or name a new file and its alias.
function MoveDialog({ name, libs, exists, onOk, onCancel }: { name: string; libs: { alias: string; path: string }[]; exists: (p: string) => boolean; onOk: (lib: { path: string; alias: string; isNew: boolean }) => void; onCancel: () => void }) {
  const [pick, setPick] = useState(libs[0]?.alias ?? '');
  const stem = name.replace(/[^\w]+/g, '-').toLowerCase();
  const [path, setPath] = useState(`data-types/${stem}-lib.raml`);
  const [alias, setAlias] = useState(`${name.charAt(0).toLowerCase()}${name.slice(1)}Lib`.replace(/[^\w]/g, ''));
  const isNew = pick === '';
  const bad = isNew && (!/\.raml$/i.test(path) || exists(path) || !/^[A-Za-z_]\w*$/.test(alias) || libs.some((l) => l.alias === alias));
  const input = 'w-full h-[28px] px-2 rounded-md border border-line bg-surface-input text-[12.5px] font-mono text-content outline-none focus:border-accent';
  return (
    <Modal title={`Move ${name} to a library`} onCancel={onCancel}
      footer={<><button className={btn} onClick={onCancel}>Cancel</button>
        <button className={btnPrimary} disabled={bad} onClick={() => onOk(isNew ? { path, alias, isNew } : { ...libs.find((l) => l.alias === pick)!, isNew })}>Move</button></>}>
      <div className="flex flex-col gap-2 text-[12.5px] text-content-secondary">
        <label className="flex flex-col gap-1">Library
          <select value={pick} onChange={(e) => setPick(e.target.value)} className={input}>
            {libs.map((l) => <option key={l.alias} value={l.alias}>{l.alias}  ({l.path})</option>)}
            <option value="">New library…</option>
          </select>
        </label>
        {isNew && <>
          <label className="flex flex-col gap-1">File<input value={path} onChange={(e) => setPath(e.target.value)} spellCheck={false} className={input} /></label>
          <label className="flex flex-col gap-1">Alias in uses:<input value={alias} onChange={(e) => setAlias(e.target.value)} spellCheck={false} className={input} /></label>
          {exists(path) && <span className="text-err text-[12px]">That file already exists. Pick it from the list instead.</span>}
        </>}
        <span className="text-[12px] text-content-faint">Uses of {name} in the root file become alias.{name}.</span>
      </div>
    </Modal>
  );
}

function DuplicateDialog({ path, canConvert, exists, onOk, onCancel }: { path: string; canConvert: boolean; exists: (p: string) => boolean; onOk: (target: string, fmt: string) => Promise<void>; onCancel: () => void }) {
  const name = base(path), dir = path.slice(0, path.length - name.length), ext = (name.match(/\.[^.]+$/) || [''])[0], stem = name.slice(0, name.length - ext.length);
  const formats: [string, string, string][] = canConvert
    ? [['copy', 'RAML 1.0 (exact copy)', ext], ['oas3y', 'OAS 3.0 (YAML)', '.yaml'], ['oas3j', 'OAS 3.0 (JSON)', '.json'], ['oas2y', 'OAS 2.0 (YAML)', '.yaml'], ['oas2j', 'OAS 2.0 (JSON)', '.json']]
    : [['copy', 'Same format', ext]];
  const [fmt, setFmt] = useState('copy');
  const [n, setN] = useState(stem + '-copy');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fext = formats.find((f) => f[0] === fmt)![2];
  const target = dir + n.trim() + fext;
  const clash = !n.trim() || exists(target);
  const go = async () => { if (clash || busy) return; setBusy(true); setErr(null); try { await onOk(target, fmt); } catch (e) { setErr(String(e)); setBusy(false); } };
  return (
    <Modal title="Duplicate As" sub={<>Makes a new file from <span className="font-mono text-content">{name}</span>{canConvert ? ', in the same format or converted' : ''}.</>} onCancel={onCancel}
      footer={<><button className={btn} onClick={onCancel}>Cancel</button><button className={btnPrimary} disabled={clash || busy} onClick={go}>{busy ? 'Converting…' : 'Duplicate'}</button></>}>
      {canConvert && (
        <div className="mb-3.5">
          <div className="mb-1.5 text-[11.5px] font-semibold text-content-secondary">Format</div>
          {formats.map(([id, label]) => (
            <label key={id} className="flex items-center gap-2 h-[26px] text-[12.5px] cursor-pointer">
              <input type="radio" name="fmt" checked={fmt === id} style={{ accentColor: 'var(--accent)' }}
                onChange={() => { setFmt(id); if (!touched) setN(id === 'copy' ? stem + '-copy' : stem + (id.startsWith('oas2') ? '-oas2' : '')); }} />{label}
            </label>
          ))}
        </div>
      )}
      <label className="block mb-1.5 text-[11.5px] font-semibold text-content-secondary">File name</label>
      <div className="flex items-center gap-1.5">
        <input autoFocus className={inputCls + ' font-mono ' + (clash ? '!border-err' : '')} value={n} spellCheck={false}
          onChange={(e) => { setN(e.target.value); setTouched(true); }} onKeyDown={(e) => { if (e.key === 'Enter') go(); }} />
        <span className="font-mono text-content-faint">{fext}</span>
      </div>
      <div className={`mt-1.5 text-[11.5px] ${clash ? 'text-err' : 'text-content-faint'}`}>{clash ? (n.trim() ? `${base(target)} already exists.` : 'Give it a name.') : `Saved as ${target}`}</div>
      {fmt !== 'copy' && <div className="mt-3 text-[11.5px] text-content-faint">Converted by AMF, the same engine Design Center uses. Check the result: a converted spec isn't always valid.</div>}
      {err && <div className="mt-3 text-[12px] text-err select-text">{err}</div>}
    </Modal>
  );
}


function ZipDialog({ zip, dest, onOk, onCancel }: { zip: string; dest: string; onOk: (zip: string, dest: string) => Promise<void>; onCancel: () => void }) {
  const [d, setD] = useState(dest);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => { setBusy(true); setErr(null); try { await onOk(zip, d.trim()); } catch (e) { setErr(String(e)); setBusy(false); } };
  return (
    <Modal title={`Open ${base(zip.replace(/\\/g, '/'))}`} sub="The zip is unpacked into a folder, and you work on the folder from then on." onCancel={onCancel} width={560}
      footer={<><button className={btn} onClick={onCancel}>Cancel</button><button className={btnPrimary} disabled={busy || !d.trim()} onClick={go}>{busy ? 'Unpacking…' : 'Unpack and open'}</button></>}>
      <label className="block mb-1.5 text-[11.5px] font-semibold text-content-secondary">Unpack into</label>
      <div className="flex gap-2">
        <input className={inputCls + ' font-mono'} value={d} spellCheck={false} onChange={(e) => setD(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') go(); }} />
        <button className={btn} onClick={async () => { const p = await openDialog({ directory: true, title: 'Pick where the project folder goes' }); if (typeof p === 'string') setD(p.replace(/\\/g, '/') + d.slice(d.lastIndexOf('/'))); }}>Browse…</button>
      </div>
      <div className="mt-1.5 text-[11.5px] text-content-faint">A new folder. Nothing is overwritten.</div>
      {err && <div className="mt-3 text-[12px] text-err select-text">{err}</div>}
    </Modal>
  );
}
function SettingsPopover({ at, pref, accent, onChange, onClose, onConnect }: {
  at: DOMRect; pref: ThemePref; accent: string; onChange: (p: ThemePref, a: string) => void; onClose: () => void; onConnect: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    window.addEventListener('mousedown', down);
    return () => window.removeEventListener('mousedown', down);
  }, [onClose]);
  // Opens beside the button that opened it and stays there while the theme changes.
  const below = at.top < window.innerHeight / 2;
  const style: CSSProperties = below
    ? { top: at.bottom + 4, right: Math.max(8, window.innerWidth - at.right) }
    : { bottom: window.innerHeight - at.top + 4, left: at.right + 6 };
  const dark = isDarkPref(pref);
  return (
    <div ref={ref} style={style} className="fixed z-50 w-[270px] p-3 rounded-lg bg-surface-2 border border-line shadow-[var(--shadow)]">
      <div className="text-[10px] font-semibold uppercase tracking-[0.5px] text-content-faint mb-2">Theme</div>
      <div className="flex gap-0.5 p-0.5 rounded-md bg-surface border border-line">
        {([['dark', 'Dusk'], ['light', 'Paper'], ['system', 'System']] as const).map(([id, name]) => (
          <button key={id} onClick={() => onChange(id, accent)}
            className={`flex-1 h-6 rounded text-[11.5px] ${pref === id ? 'bg-surface-3 text-content font-semibold' : 'text-content-faint'}`}>{name}</button>
        ))}
      </div>
      <div className="text-[10px] font-semibold uppercase tracking-[0.5px] text-content-faint mt-3.5 mb-2">Accent</div>
      <div className="flex gap-2">
        {ACCENTS.map((a) => (
          <button key={a.id} title={a.name} onClick={() => onChange(pref, a.id)}
            className="w-[26px] h-[26px] rounded-full"
            style={{ background: `oklch(${dark ? 72 : 55}% ${a.chroma} ${a.hue})`, outline: accent === a.id ? '2px solid var(--content)' : 'none', outlineOffset: 2 }} />
        ))}
      </div>
      {isTauri && <AnypointSettings onConnect={onConnect} />}
    </div>
  );
}

function Palette({ project, recent, onClose, onOpenFile, onOpenFolder, onTheme }: {
  project: Project | null; recent: Recent[]; onClose: () => void;
  onOpenFile: (p: string) => void; onOpenFolder: (root?: string) => void; onTheme: (p: ThemePref) => void;
}) {
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const items = useMemo(() => {
    const all: { group: string; label: string; detail?: string; run: () => void }[] = [
      ...(project ? project.files.map((f) => ({ group: 'Files', label: f.path, run: () => onOpenFile(f.path) })) : []),
      ...recent.map((r) => ({ group: 'Recent projects', label: r.name, detail: r.root, run: () => onOpenFolder(r.root) })),
      ...(isTauri ? [{ group: 'Commands', label: 'Open folder…', detail: 'Ctrl O', run: () => onOpenFolder() }] : []),
      { group: 'Commands', label: 'Switch to Dusk', detail: 'theme', run: () => onTheme('dark') },
      { group: 'Commands', label: 'Switch to Paper', detail: 'theme', run: () => onTheme('light') },
    ];
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    return all.filter((it) => words.every((w) => (it.label + ' ' + (it.detail || '') + ' ' + it.group).toLowerCase().includes(w))).slice(0, 40);
  }, [q, project, recent, onOpenFile, onOpenFolder, onTheme]);
  const go = (i: number) => { const it = items[i]; onClose(); if (it) it.run(); };
  let lastGroup = '';
  return (
    <div className="fixed inset-0 z-50 flex justify-center items-start pt-[90px] bg-black/35" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-[600px] max-w-[calc(100vw-32px)] rounded-[10px] bg-surface border border-line shadow-[var(--shadow)] overflow-hidden">
        <div className="flex items-center gap-2.5 h-11 px-3.5 border-b border-line text-content-faint">
          <Icons.Search size={16} />
          <input autoFocus value={q} placeholder="Type a file, a project or a command" spellCheck={false}
            onChange={(e) => { setQ(e.target.value); setIdx(0); }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setIdx((i) => Math.min(i + 1, items.length - 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setIdx((i) => Math.max(i - 1, 0)); }
              else if (e.key === 'Enter') go(idx);
            }}
            className="flex-1 bg-transparent outline-none text-[14px] text-content" />
        </div>
        <div className="max-h-[420px] overflow-auto px-1.5 pt-1 pb-2">
          {items.map((it, i) => {
            const head = it.group !== lastGroup ? (lastGroup = it.group) : null;
            return (
              <div key={it.group + it.label}>
                {head && <div className="px-2 pt-2 pb-0.5 text-[10px] font-semibold uppercase tracking-[0.5px] text-content-faint">{head}</div>}
                <div onMouseEnter={() => setIdx(i)} onClick={() => go(i)}
                  className={`flex items-center gap-2 h-[30px] px-2 rounded-md cursor-pointer text-[13px] ${i === idx ? 'bg-accent-dim text-content' : 'text-content-secondary'}`}>
                  <span className={it.group === 'Files' ? 'font-mono text-[12.5px]' : ''}>{it.label}</span>
                  {it.detail && <span className="ml-auto font-mono text-[11.5px] text-content-faint truncate max-w-[300px]">{it.detail}</span>}
                </div>
              </div>
            );
          })}
          {items.length === 0 && <div className="p-4 text-content-faint text-[12.5px]">No matches.</div>}
        </div>
      </div>
    </div>
  );
}
