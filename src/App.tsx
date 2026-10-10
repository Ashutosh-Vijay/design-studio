import { useEffect, useMemo, useRef, useState, type CSSProperties, type MutableRefObject, type ReactNode } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { METHODS, baseExtensions, languageFor, yamlPathAt } from './editor';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { Icons } from './components/Icons';
import { WindowControls, isTauri } from './components/WindowControls';
import { ACCENTS, ThemePref, applyTheme, isDarkPref, savedTheme } from './theme';

// What the Rust side returns for an opened folder (src-tauri/src/lib.rs, open_project).
type Project = { root: string; name: string; main: string | null; files: { path: string; size: number }[] };
type Recent = { root: string; name: string; opened: number };

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

export default function App() {
  const [project, setProject] = useState<Project | null>(null);
  const [recent, setRecent] = useState<Recent[]>(readRecent);
  const [opening, setOpening] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState(savedTheme);
  const [settingsAt, setSettingsAt] = useState<DOMRect | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [dirtyCount, setDirtyCount] = useState(0);
  const openFileRef = useRef<(path: string) => void>(() => {});

  useEffect(() => { applyTheme(theme.pref, theme.accent); }, [theme]);

  // Leaving a project (or the window) with unsaved files asks first.
  const okToLeave = () => dirtyCount === 0 || window.confirm(`${dirtyCount} ${dirtyCount === 1 ? 'file has' : 'files have'} unsaved changes. Leave without saving?`);
  useEffect(() => {
    const before = (e: BeforeUnloadEvent) => { if (dirtyCount) { e.preventDefault(); } };
    window.addEventListener('beforeunload', before);
    return () => window.removeEventListener('beforeunload', before);
  }, [dirtyCount]);

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

  // App-wide keys. The editor handles its own (Ctrl S lives in the project view).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
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
        {project && <span data-tauri-drag-region className="text-[12px] text-content-faint">{dirtyCount ? `${dirtyCount} unsaved` : 'All changes saved'}</span>}
        <div data-tauri-drag-region className="flex-1 h-full" />
        <button className="w-8 h-7 flex items-center justify-center rounded-md text-content-faint hover:bg-surface-2 hover:text-content" title="Search files and commands (Ctrl K)" onClick={() => setPaletteOpen(true)}>
          <Icons.Search size={15} />
        </button>
        {!project && settingsBtn('w-8 h-7 flex items-center justify-center rounded-md text-content-faint hover:bg-surface-2 hover:text-content')}
        <WindowControls />
      </header>

      {project ? (
        <ProjectView
          key={project.root}
          project={project}
          onDirtyCount={setDirtyCount}
          openFileRef={openFileRef}
          settingsButton={settingsBtn('relative h-9 mx-2 my-0.5 rounded-md flex items-center justify-center text-content-faint hover:text-content-secondary')}
        />
      ) : (
        <StartView recent={recent} opening={opening} error={error} onOpen={openFolder}
          onRemove={(root) => { const l = recent.filter((r) => r.root !== root); writeRecent(l); setRecent(l); }} />
      )}

      {settingsAt && (
        <SettingsPopover at={settingsAt} pref={theme.pref} accent={theme.accent} onChange={(pref, accent) => setTheme({ pref, accent })} onClose={() => setSettingsAt(null)} />
      )}
      {paletteOpen && (
        <Palette project={project} recent={recent} onClose={() => setPaletteOpen(false)}
          onOpenFile={(p) => openFileRef.current(p)} onOpenFolder={(root) => openFolder(root)} onTheme={(pref) => setTheme((t) => ({ ...t, pref }))} />
      )}
    </div>
  );
}

function StartView({ recent, opening, error, onOpen, onRemove }: {
  recent: Recent[]; opening: string | null; error: string | null;
  onOpen: (root?: string) => void; onRemove: (root: string) => void;
}) {
  return (
    <div className="flex-1 min-h-0 overflow-auto flex justify-center">
      <div className="w-full max-w-[1000px] grid grid-cols-[340px_1fr] gap-12 px-10 pt-14 pb-8 content-start">
        <section>
          <img src="/logo.svg" width={44} height={44} alt="" />
          <h1 className="mt-4 mb-1.5 text-[22px] font-bold">Design Center specs, on your desktop</h1>
          <p className="text-content-muted leading-relaxed">A desktop designer for Anypoint Design Center specs, RAML and OAS. Big specs open in seconds, and every edit is checked as you type.</p>
          <button
            disabled={!isTauri || !!opening}
            onClick={() => onOpen()}
            className="mt-6 w-full flex items-center gap-3 p-3 rounded-lg border border-line bg-surface text-left hover:border-accent-border disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <span className="w-9 h-9 rounded-lg flex items-center justify-center text-accent bg-accent-dim"><Icons.Folder size={17} /></span>
            <span className="flex-1"><span className="block font-semibold">Open folder</span><span className="block text-[11.5px] text-content-faint">A spec project on this computer</span></span>
            <span className="font-mono text-[10.5px] px-1.5 py-0.5 rounded bg-surface-3 text-content-muted">Ctrl O</span>
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

function ProjectView({ project, onDirtyCount, openFileRef, settingsButton }: {
  project: Project; onDirtyCount: (n: number) => void; openFileRef: MutableRefObject<(path: string) => void>; settingsButton: ReactNode;
}) {
  const [filter, setFilter] = useState('');
  const [openDirs, setOpenDirs] = useState<Set<string>>(new Set());
  const [tabs, setTabs] = useState<string[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [dirty, setDirty] = useState<Set<string>>(new Set());
  const [crumb, setCrumb] = useState<{ key: string; from: number }[]>([]);
  const [cursor, setCursor] = useState({ line: 1, col: 1 });
  const [notice, setNotice] = useState<string | null>(null);
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
    }
  }), []);

  useEffect(() => {
    view.current = new EditorView({ parent: host.current! });
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
    v.focus();
  }

  async function openFile(path: string) {
    if (!files.current.has(path)) {
      let text: string;
      try { text = (await invoke<string>('read_text_file', { root: project.root, path })).replace(/\r\n/g, '\n'); }
      catch (e) { setNotice(String(e)); return; }
      const ro = isReadOnly(path);
      files.current.set(path, {
        disk: text,
        state: EditorState.create({ doc: text, extensions: [...baseExtensions(), languageFor(path), listener, EditorState.readOnly.of(ro), EditorView.editable.of(!ro)] }),
      });
    }
    setTabs((t) => (t.includes(path) ? t : [...t, path]));
    show(path);
  }
  openFileRef.current = openFile;

  useEffect(() => { if (project.main) openFile(project.main); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function save(path: string) {
    const f = files.current.get(path); if (!f) return;
    const state = path === activeRef.current ? view.current!.state : f.state;
    const text = state.doc.toString();
    try {
      await invoke('save_text_file', { root: project.root, path, text });
      f.disk = text;
      setDirty((d) => { const n = new Set(d); n.delete(path); return n; });
    } catch (e) { setNotice(String(e)); }
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
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  function jumpTo(from: number) {
    const v = view.current!; v.dispatch({ selection: { anchor: from }, scrollIntoView: true }); v.focus();
  }

  // Folders first, then files; a filter shows matching files with their folders open.
  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = project.files.filter((f) => !q || f.path.toLowerCase().includes(q));
    const dirs = new Set<string>();
    list.forEach((f) => { const parts = f.path.split('/'); for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/')); });
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
          <button title="Files" className="relative h-9 mx-2 my-0.5 rounded-md flex items-center justify-center bg-surface-2 text-content">
            <span className="absolute -left-2 top-2 bottom-2 w-0.5 bg-accent rounded-sm" />
            <Icons.File size={18} />
          </button>
          <div className="flex-1" />
          {settingsButton}
        </nav>

        <aside className="w-[272px] shrink-0 bg-surface border-r border-line flex flex-col min-h-0">
          <div className="h-9 shrink-0 flex items-center px-3 border-b border-line-subtle text-[12.5px] font-semibold">Files</div>
          <label className="m-2 mb-1 flex items-center gap-1.5 h-[26px] px-2 rounded-md bg-surface-2 border border-line text-content-faint focus-within:border-accent-border">
            <Icons.Search size={12} />
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter" spellCheck={false} className="flex-1 min-w-0 bg-transparent outline-none text-[12px] text-content" />
          </label>
          <div className="flex-1 overflow-auto pb-3">
            {rows.map((r) => r.kind === 'dir' ? (
              <div key={'d' + r.path} style={{ paddingLeft: 8 + r.depth * 14 }}
                onClick={() => { const n = new Set(openDirs); n.has(r.path) ? n.delete(r.path) : n.add(r.path); setOpenDirs(n); }}
                className="flex items-center gap-1.5 h-6 pr-2 text-[12.5px] text-content-secondary cursor-pointer hover:bg-[var(--hover-overlay)]">
                <span className="w-3.5 flex justify-center text-content-ghost">{filter || openDirs.has(r.path) ? <Icons.ChevronDown size={11} /> : <Icons.ChevronRight size={11} />}</span>
                <span className="text-content-faint flex"><Icons.Folder size={13} /></span>
                <span className="truncate">{base(r.path)}</span>
              </div>
            ) : (
              <div key={'f' + r.path} onClick={() => openFile(r.path)} title={r.path} style={{ paddingLeft: 8 + r.depth * 14 + 20 }}
                className={`relative flex items-center gap-1.5 h-6 pr-2 text-[12.5px] cursor-pointer ${active === r.path ? 'bg-accent-dim text-content' : 'text-content-secondary hover:bg-[var(--hover-overlay)]'}`}>
                {active === r.path && <span className="absolute left-0 top-0 bottom-0 w-0.5 bg-accent" />}
                <span className="truncate" style={r.path === project.main ? { fontWeight: 600, color: 'var(--content)' } : undefined}>{dirty.has(r.path) ? '* ' : ''}{base(r.path)}</span>
                <span className="ml-auto flex items-center gap-1.5">
                  {r.path === project.main && <span className="text-[9.5px] font-semibold px-1.5 rounded border border-accent-border text-accent">Root file</span>}
                  {isReadOnly(r.path) && <span className="text-content-faint flex" title="Read-only"><Icons.Lock size={12} /></span>}
                </span>
              </div>
            ))}
            {rows.length === 0 && <div className="p-3 text-[12px] text-content-faint">No files match.</div>}
          </div>
        </aside>

        <main className="flex-1 min-w-0 flex flex-col bg-surface">
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
          {!active && <div className="flex-1 flex items-center justify-center text-content-faint text-[12.5px]">{project.main ? 'Opening…' : 'No root file found. Pick a file on the left.'}</div>}
          {notice && (
            <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-t border-line bg-surface-2 text-[12px] text-err">
              <span className="flex-1 select-text">{notice}</span>
              <button onClick={() => setNotice(null)} className="text-content-faint hover:text-content"><Icons.X size={12} /></button>
            </div>
          )}
        </main>
      </div>
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

function SettingsPopover({ at, pref, accent, onChange, onClose }: {
  at: DOMRect; pref: ThemePref; accent: string; onChange: (p: ThemePref, a: string) => void; onClose: () => void;
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
