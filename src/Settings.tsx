// Settings, as a screen of its own like DataWeave Studio's: sections on the left, a search that narrows them,
// and each section's settings on the right. Every change applies at once.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { Icons } from './components/Icons';
import { APP_NAME, ask, autoUpdates } from './Brand';
import { btn, editorPrefs, applyEditorPrefs, ZOOMS, savedZoom, setZoom } from './App';
import { ACCENTS, isDarkPref, type ThemePref } from './theme';
import { projectsDir } from './sync';
import { lockWhileEditing, type Me } from './SyncUI';
import { isTauri, isVsCode, multiWindow, WINDOW } from './components/WindowControls';
import { useMcpStatus, savedPort } from './mcp';
import { remoteOk } from './mcpTools';
import { readSettings as readGov, writeSettings as writeGov } from './governance';

type Section = 'appearance' | 'editor' | 'shortcuts' | 'project' | 'anypoint' | 'projects' | 'ai' | 'about';
const SECTIONS: { id: Section; label: string; icon: keyof typeof Icons; keywords: string[]; desktop?: boolean }[] = [
  { id: 'appearance', label: 'Appearance', icon: 'Panel', keywords: ['theme', 'dark', 'light', 'dusk', 'paper', 'system', 'accent', 'colour', 'color', 'interface size', 'zoom'] },
  { id: 'editor', label: 'Editor', icon: 'Braces', keywords: ['text size', 'font', 'code colours', 'colors', 'design center', 'wrap', 'long lines', 'raml', 'oas'] },
  { id: 'shortcuts', label: 'Shortcuts', icon: 'Command', keywords: ['keyboard', 'keys', 'hotkey', 'save', 'find', 'replace', 'rename', 'fold', 'comment', 'palette'] },
  { id: 'project', label: 'This project', icon: 'ApiSpec', keywords: ['governance', 'rulesets', 'rules', 'validate', 'auto', 'conformance'] },
  { id: 'anypoint', label: 'Anypoint', icon: 'DesignCenter', desktop: true, keywords: ['sign in', 'sign out', 'connect', 'account', 'organization', 'read only', 'lock', 'design center'] },
  { id: 'projects', label: 'Projects', icon: 'Folder', desktop: true, keywords: ['folder', 'location', 'where', 'pull', 'create'] },
  { id: 'ai', label: 'AI tools', icon: 'Sparkle', desktop: true, keywords: ['mcp', 'claude', 'copilot', 'cursor', 'agent', 'server', 'port', 'start', 'allow changes', 'publish', 'push'] },
  { id: 'about', label: 'About', icon: 'Help', keywords: ['version', 'updates', 'licence', 'license', "what's new"] },
];

export function SettingsScreen({ pref, accent, onTheme, onClose, onConnect, onMcp, onAbout, projectRoot }: {
  pref: ThemePref; accent: string; onTheme: (p: ThemePref, a: string) => void; onClose: () => void;
  onConnect: () => void; onMcp: () => void; onAbout: () => void; projectRoot?: string;
}) {
  // This project's settings show while one is open.
  const sections = SECTIONS.filter((x) => (!x.desktop || isTauri) && (x.id !== 'project' || projectRoot));
  const [section, setSection] = useState<Section>('appearance');
  const [search, setSearch] = useState('');
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? sections.filter((s) => s.label.toLowerCase().includes(q) || s.keywords.some((k) => k.includes(q))) : sections;
  }, [search]); // eslint-disable-line react-hooks/exhaustive-deps
  // Searching moves to the first section that matches.
  useEffect(() => { if (visible.length && !visible.some((s) => s.id === section)) setSection(visible[0].id); }, [visible, section]);

  // A modal <dialog>: the rest of the app can't be clicked or tabbed into, and focus comes back on close.
  const ref = useRef<HTMLDialogElement>(null);
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null, d = ref.current!;
    d.showModal();
    return () => { d.close(); if (previous?.isConnected) previous.focus(); };
  }, []);

  return (
    <dialog ref={ref} aria-label="Settings" className="ads-dialog m-auto p-0 bg-surface border border-line rounded-xl shadow-[var(--shadow)] overflow-hidden"
      style={{ width: 1000, height: 680 }}
      onCancel={(e) => { e.preventDefault(); close.current(); }}
      onMouseDown={(e) => { if (e.target !== e.currentTarget) return; const r = e.currentTarget.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) close.current(); }}>
      <div className="h-full flex flex-col">
        <div className="h-11 shrink-0 flex items-center gap-2.5 px-4 border-b border-line">
          <Icons.Settings size={15} />
          <h2 className="m-0 text-[14px] font-semibold">Settings</h2>
          <span className="flex-1" />
          <label className="hidden sm:flex items-center gap-2 h-7 px-2.5 bg-surface-2 border border-line rounded-md w-[240px] text-content-faint focus-within:border-accent-border">
            <Icons.Search size={13} />
            <input autoFocus value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search settings" aria-label="Search settings" spellCheck={false}
              className="flex-1 min-w-0 bg-transparent !outline-none text-[12.5px] text-content" />
            {search && <button onClick={() => setSearch('')} aria-label="Clear search" className="flex hover:text-content"><Icons.X size={11} /></button>}
          </label>
          <button onClick={onClose} aria-label="Close settings" title="Close (Esc)" className="w-7 h-7 rounded-md flex items-center justify-center text-content-faint hover:text-content hover:bg-surface-2"><Icons.X size={14} /></button>
        </div>
        <div className="flex-1 flex min-h-0">
          <nav aria-label="Settings sections" className="w-[200px] shrink-0 border-r border-line py-3.5 px-2.5 overflow-y-auto">
            {visible.map((s) => {
              const on = section === s.id, Icon = Icons[s.icon];
              return (
                <button key={s.id} onClick={() => setSection(s.id)} aria-current={on ? 'page' : undefined}
                  className={`relative w-full px-2.5 py-1.5 my-px rounded-md flex items-center gap-2.5 text-[13px] ${on ? 'bg-surface-3 text-content font-medium' : 'text-content-secondary hover:text-content'}`}>
                  {on && <span className="absolute left-0 top-2 bottom-2 w-0.5 bg-accent rounded-sm" />}
                  <span className="text-content-faint flex"><Icon size={14} /></span>{s.label}
                </button>
              );
            })}
            {!visible.length && <div className="px-2 py-3 text-[12px] text-content-faint">No settings match.</div>}
          </nav>
          <div className="flex-1 min-w-0 overflow-y-auto px-10 py-7 bg-bg">
            {visible.length > 0 && <>
              {section === 'appearance' && <Appearance pref={pref} accent={accent} onTheme={onTheme} />}
              {section === 'editor' && <Editor />}
              {section === 'shortcuts' && <Shortcuts />}
              {section === 'project' && projectRoot && <ThisProject root={projectRoot} />}
              {section === 'anypoint' && <Anypoint onConnect={onConnect} />}
              {section === 'projects' && <Projects />}
              {section === 'ai' && <AiTools onMcp={onMcp} />}
              {section === 'about' && <About onAbout={onAbout} />}
            </>}
          </div>
        </div>
      </div>
    </dialog>
  );
}

function Page({ title, desc, children }: { title: string; desc?: ReactNode; children: ReactNode }) {
  return (
    <div className="max-w-[640px]">
      <h3 className="m-0 text-[18px] font-semibold tracking-tight">{title}</h3>
      {desc && <p className="m-0 mt-1 text-[12.5px] text-content-muted leading-relaxed">{desc}</p>}
      <div className="mt-6">{children}</div>
    </div>
  );
}
function Row({ label, desc, children }: { label: string; desc?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-5 py-3.5 border-t border-line-subtle first:border-t-0">
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium">{label}</div>
        {desc && <div className="text-[12px] text-content-muted mt-0.5">{desc}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
function Toggle({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={() => onChange(!on)}
      className="relative w-[34px] h-5 rounded-full transition-colors disabled:opacity-45"
      style={{ background: on ? 'var(--accent)' : 'var(--surface-3)', border: `1px solid ${on ? 'var(--accent-border)' : 'var(--line)'}` }}>
      <span className="absolute top-px w-4 h-4 rounded-full transition-all" style={{ left: on ? 15 : 1, background: on ? 'var(--bg)' : 'var(--content)' }} />
    </button>
  );
}
function Choice<T extends string | number>({ value, options, onChange }: { value: T; options: readonly (readonly [T, ReactNode])[]; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex p-[3px] rounded-[8px] bg-surface-2 border border-line gap-0.5">
      {options.map(([id, label]) => (
        <button key={String(id)} onClick={() => onChange(id)} aria-pressed={value === id}
          className={`inline-flex items-center gap-1.5 px-3 h-[26px] rounded-md text-[12.5px] font-medium ${value === id ? 'bg-surface-3 text-content' : 'text-content-muted hover:text-content'}`}>{label}</button>
      ))}
    </div>
  );
}

function Appearance({ pref, accent, onTheme }: { pref: ThemePref; accent: string; onTheme: (p: ThemePref, a: string) => void }) {
  const [zoom, setZoomState] = useState(savedZoom);
  useEffect(() => { const f = () => setZoomState(savedZoom()); window.addEventListener('ads-zoom', f); return () => window.removeEventListener('ads-zoom', f); }, []);
  const dark = isDarkPref(pref);
  return (
    <Page title="Appearance" desc="Theme, accent colour and the size of everything.">
      <Row label="Theme" desc={pref === 'system' ? `Follows your system, now ${dark ? 'dark' : 'light'}.` : undefined}>
        <Choice value={pref} onChange={(p) => onTheme(p, accent)}
          options={[['dark', <><Icons.Moon size={12} />Dusk</>], ['light', <><Icons.Sun size={12} />Paper</>], ['system', <><Icons.Activity size={12} />System</>]]} />
      </Row>
      <Row label="Accent" desc="Buttons, the cursor, selection and highlights.">
        <div className="flex gap-2">
          {ACCENTS.map((a) => (
            <button key={a.id} title={a.name} aria-label={a.name} aria-pressed={accent === a.id} onClick={() => onTheme(pref, a.id)}
              className="w-[26px] h-[26px] rounded-full"
              style={{ background: `oklch(${dark ? 72 : 55}% ${a.chroma} ${a.hue})`, outline: accent === a.id ? '2px solid var(--content)' : 'none', outlineOffset: 2 }} />
          ))}
        </div>
      </Row>
      {/* In VS Code, its own zoom does this (View, Appearance). */}
      {!isVsCode && (
        <Row label="Interface size" desc="Everything: icons, panels and text. Ctrl Plus, Ctrl Minus and Ctrl 0 work anywhere.">
          <div className="flex items-center gap-1.5 text-[12.5px]">
            <button className={btn + ' !w-8 !px-0'} title="Smaller (Ctrl Minus)" aria-label="Smaller" disabled={zoom <= ZOOMS[0]} onClick={() => setZoom(ZOOMS[ZOOMS.indexOf(zoom) - 1])}>−</button>
            <span className="w-12 text-center tabular-nums text-content-secondary">{Math.round(zoom * 100)}%</span>
            <button className={btn + ' !w-8 !px-0'} title="Bigger (Ctrl Plus)" aria-label="Bigger" disabled={zoom >= ZOOMS[ZOOMS.length - 1]} onClick={() => setZoom(ZOOMS[ZOOMS.indexOf(zoom) + 1])}>+</button>
            <button className={`ml-1 text-[12px] text-accent hover:underline ${zoom === 1 ? 'invisible' : ''}`} title="Ctrl 0" onClick={() => setZoom(1)}>Reset</button>
          </div>
        </Row>
      )}
    </Page>
  );
}

function Editor() {
  const [ed, setEdState] = useState(editorPrefs);
  const setEd = (p: ReturnType<typeof editorPrefs>) => { setEdState(p); try { localStorage.setItem('ads.editor', JSON.stringify(p)); } catch { /* ignore */ } applyEditorPrefs(p); };
  return (
    <Page title="Editor" desc="How the code looks. Open editors change at once.">
      <Row label="Text size">
        <Choice value={ed.size} onChange={(size) => setEd({ ...ed, size })} options={[[11.5, 'Small'], [12.5, 'Medium'], [14, 'Large']]} />
      </Row>
      <Row label="Code colours" desc="Design Center colours RAML and OAS by role: resources and paths, methods, traits, types and schemas. Design Studio's own colours give each method its own colour.">
        <Choice value={ed.colors} onChange={(colors) => setEd({ ...ed, colors })} options={[['dc', 'Design Center'], ['studio', 'Design Studio']]} />
      </Row>
      <Row label="Wrap long lines" desc="Long lines wrap to the editor's width instead of scrolling sideways.">
        <Toggle label="Wrap long lines" on={ed.wrap} onChange={(wrap) => setEd({ ...ed, wrap })} />
      </Row>
    </Page>
  );
}

function Anypoint({ onConnect }: { onConnect: () => void }) {
  const [me, setMe] = useState<Me | null | 'error' | undefined>(undefined);
  const [lockOn, setLockOn] = useState(lockWhileEditing);
  useEffect(() => { invoke<Me | null>('anypoint_status').then((m) => setMe(m), () => setMe('error')); }, []);
  const signedIn = me && me !== 'error';
  return (
    <Page title="Anypoint" desc="Your connection to Design Center and Exchange.">
      {me === undefined ? <div className="text-[12.5px] text-content-faint">Checking…</div> : signedIn ? <>
        <Row label={me.username} desc={me.org_name}>
          <button className={btn} onClick={async () => { await invoke('anypoint_disconnect'); setMe(null); }}>Sign out</button>
        </Row>
        <Row label="Read only" desc="Every change to Design Center is refused before it's sent. Turn it off to push, lock and publish.">
          <Toggle label="Read only" on={me.read_only} onChange={async (on) => {
            // Turning writes on is the one that needs a second look.
            if (!on && !(await ask(`Let Design Studio push changes to Design Center in ${me.org_name || 'this organization'}? Pushing saves files, takes the lock and can delete files there.`))) return;
            await invoke('anypoint_set_read_only', { on }); setMe({ ...me, read_only: on });
          }} />
        </Row>
        <Row label="Lock while I edit" desc={me.read_only ? 'Needs read only off: locking is a change in Design Center.' : 'Your first edit locks the branch in Design Center, so others can only read it until you push or close the project.'}>
          <Toggle label="Lock while I edit" disabled={me.read_only} on={lockOn && !me.read_only} onChange={(on) => {
            try { localStorage.setItem('ads.lockWhileEditing', on ? '1' : '0'); } catch { /* ignore */ }
            setLockOn(on);
          }} />
        </Row>
      </> : (
        <Row label={me === 'error' ? 'The sign-in has expired.' : 'Not connected'} desc="Sign in with Anypoint, or use your own Connected App.">
          <button className={btn} onClick={onConnect}>{me === 'error' ? 'Sign in again' : 'Connect…'}</button>
        </Row>
      )}
    </Page>
  );
}

function ThisProject({ root }: { root: string }) {
  const [auto, setAuto] = useState<boolean | null>(null);
  useEffect(() => { readGov(root).then((s) => setAuto(s.auto), () => setAuto(true)); }, [root]);
  return (
    <Page title="This project" desc={<>Kept with the project, in <span className="font-mono text-[11.5px]">.apidesigner/governance.json</span>.</>}>
      <Row label="Governance after each check" desc="Validates the API against its rulesets (Dependencies) after each full check. Off, press Validate on the Governance tab under Project errors.">
        <Toggle label="Governance after each check" disabled={auto === null} on={!!auto} onChange={async (on) => {
          setAuto(on);
          await writeGov(root, { ...(await readGov(root)), auto: on });
          window.dispatchEvent(new CustomEvent('ads-governance-changed', { detail: 'auto' }));
        }} />
      </Row>
    </Page>
  );
}

function AiTools({ onMcp }: { onMcp: () => void }) {
  const st = useMcpStatus();
  const pref = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
  const [auto, setAuto] = useState(pref('ads.mcp.auto') === '1');
  const [remote, setRemote] = useState(remoteOk);
  const set = (k: string, on: boolean) => { try { localStorage.setItem(k, on ? '1' : '0'); } catch { /* ignore */ } };
  const [port, setPort] = useState(String(savedPort()));
  const portOk = Number(port) > 1023 && Number(port) < 65536;
  return (
    <Page title="AI tools" desc="Let AI agents like Claude, Copilot and Cursor work in Design Studio, over MCP.">
      <Row label="Local server" desc={st?.running ? <>Running at <span className="font-mono text-[11.5px]">127.0.0.1:{st.port}</span>, {st.requests} {st.requests === 1 ? 'call' : 'calls'}.</> : 'Stopped. Start it, then give your agent its address.'}>
        <button className={btn} onClick={onMcp}>{st?.running ? 'Details…' : 'Set up…'}</button>
      </Row>
      {/* VS Code's Copilot calls the tools directly; the port is for other agents, as on the desktop. */}
      <Row label="Port" desc={st?.running ? 'Stop the server to change it.' : portOk ? `Agents connect to http://127.0.0.1:${port}/mcp. Change it if another program uses ${port}.` : 'Pick a port from 1024 to 65535.'}>
        <input value={port} disabled={!!st?.running} aria-label="Port" inputMode="numeric" spellCheck={false}
          onChange={(e) => { const v = e.target.value.replace(/\D/g, '').slice(0, 5); setPort(v); if (Number(v) > 1023 && Number(v) < 65536) { try { localStorage.setItem('ads.mcp.port', v); } catch { /* ignore */ } } }}
          className={`w-[84px] h-[28px] px-2 rounded-md border bg-surface-input font-mono text-[12.5px] text-content !outline-none disabled:opacity-50 ${portOk ? 'border-line focus:border-accent' : 'border-err'}`} />
      </Row>
      <Row label="Start when Design Studio opens">
        <Toggle label="Start when Design Studio opens" on={auto} onChange={(on) => { set('ads.mcp.auto', on); setAuto(on); }} />
      </Row>
      <Row label="Allow changes in Design Center and Exchange" desc="Push, new branches, new Design Center projects and Publish. Off, an agent can still pull and read. A read only Anypoint connection blocks these either way.">
        <Toggle label="Allow changes in Design Center and Exchange" on={remote} onChange={(on) => { set('ads.mcp.remote', on); setRemote(on); }} />
      </Row>
    </Page>
  );
}

function Projects() {
  const [home, setHome] = useState('');
  useEffect(() => { projectsDir().then(setHome); }, []);
  let custom = false; try { custom = !!localStorage.getItem('ads.projectsDir'); } catch { /* ignore */ }
  return (
    <Page title="Projects" desc="Where projects you pull from Design Center or create go.">
      <Row label="Projects folder" desc={<span className="font-mono text-[11.5px] break-all">{home}</span>}>
        <div className="flex items-center gap-2">
          {custom && <button className="text-[12px] text-accent hover:underline" onClick={async () => { try { localStorage.removeItem('ads.projectsDir'); } catch { /* ignore */ } setHome(await projectsDir()); }}>Use the default</button>}
          <button className={btn} onClick={async () => {
            const d = await openDialog({ directory: true, title: 'Where should projects go?' });
            if (typeof d === 'string') { try { localStorage.setItem('ads.projectsDir', d.replace(/\\/g, '/')); } catch { /* ignore */ } setHome(d.replace(/\\/g, '/')); }
          }}>Change…</button>
        </div>
      </Row>
    </Page>
  );
}

function About({ onAbout }: { onAbout: () => void }) {
  const [version, setVersion] = useState('');
  useEffect(() => { if (isTauri) getVersion().then(setVersion, () => {}); }, []);
  const [updates, setUpdates] = useState(autoUpdates);
  return (
    <Page title="About" desc={`${APP_NAME}${version ? ` ${version}` : ''}, MIT licence.`}>
      <Row label="What's new" desc="Release notes, the licence and the open-source parts.">
        <button className={btn} onClick={onAbout}>About {APP_NAME}…</button>
      </Row>
      {isTauri && !isVsCode && import.meta.env.VITE_STORE_BUILD !== '1' && (
        <Row label="Check for updates automatically" desc="Asks GitHub for a newer version a few seconds after the app starts, and downloads it quietly.">
          <Toggle label="Check for updates automatically" on={updates} onChange={(on) => { try { localStorage.setItem('ads.updateCheck', on ? '1' : '0'); } catch { /* ignore */ } setUpdates(on); }} />
        </Row>
      )}
    </Page>
  );
}

// Every key here is one the app or its editor really binds: App.tsx (app and project keys), editor.ts and App.tsx's
// editor keymaps, and CodeMirror's default, search, fold and completion keymaps. Ctrl is Cmd on a Mac.
const MAC = typeof navigator !== 'undefined' && /Mac/.test(navigator.userAgent);
function Shortcuts() {
  const C = MAC ? 'Cmd' : 'Ctrl';
  const groups: [string, [string, string[]][]][] = [
    ['General', [
      ['Search files, projects and commands', [`${C} K`]],
      ['Go to a symbol', [`${C} Shift O`]],
      ['Commands', ['F1']],
      ['Open folder', [`${C} O`]],
      ...(multiWindow && !isVsCode ? [['New window', [`${C} Shift N`]]] as [string, string[]][] : []),
      ...(multiWindow ? [[`Open a recent project in a new ${WINDOW}`, [`${C} click`, 'Middle click']]] as [string, string[]][] : []),
      ...(isVsCode ? [] : [['Settings', [`${C} ,`]], ['Interface size', [`${C} Plus`, `${C} Minus`, `${C} 0`]]] as [string, string[]][]),
      ['Close a dialog or panel', ['Esc']],
    ]],
    ['Files and panels', [
      ['Save', [`${C} S`]], ['Save all', [`${C} Shift S`]], ['Close the tab', [`${C} W`]],
      ['Next or previous tab', ['Ctrl Tab', 'Ctrl Shift Tab']],
      ['Project errors', [`${C} J`]], ['Inspector', [`${C} Alt B`]],
    ]],
    ['Editing', [
      ['Suggestions', ['Ctrl Space']],
      ['Go to definition', ['F12']], ['Find uses', ['Shift F12']], ['Rename everywhere', ['F2']],
      ['Find', [`${C} F`]], ['Replace', [`${C} H`]], ['Next or previous match', ['F3', 'Shift F3']],
      ['Select the next match', [`${C} D`]], ['Select every match', [`${C} Shift L`]],
      ['Go to line', [`${C} Alt G`]],
      ['Comment or uncomment', [`${C} /`]],
      ['Move the line up or down', ['Alt Up', 'Alt Down']], ['Copy the line up or down', ['Shift Alt Up', 'Shift Alt Down']],
      ['Delete the line', [`${C} Shift K`]],
      ['Indent or outdent', [`${C} ]`, `${C} [`]],
      ['Grow or shrink the selection', [`${C} Shift Right`, `${C} Shift Left`]],
      ['Fold or unfold', MAC ? ['Cmd Alt [', 'Cmd Alt ]'] : ['Ctrl Shift [', 'Ctrl Shift ]']],
      ['Fold or unfold everything', ['Ctrl Alt [', 'Ctrl Alt ]']],
      ['Add a cursor above or below', [`${C} Alt Up`, `${C} Alt Down`]],
      ['Undo or redo', [`${C} Z`, MAC ? 'Cmd Shift Z' : 'Ctrl Y']],
    ]],
    ['Files and API trees', [
      ['Move', ['Up', 'Down', 'Home', 'End']], ['Open', ['Enter']], ['Expand or collapse', ['Right', 'Left']],
    ]],
  ];
  return (
    <Page title="Shortcuts" desc="Keys that work everywhere in Design Studio, in the editor, and in the trees.">
      {groups.map(([title, rows]) => (
        <div key={title} className="mb-7">
          <h4 className="m-0 mb-1 text-[13.5px] font-semibold">{title}</h4>
          {rows.map(([what, keys]) => (
            <div key={what} className="flex items-center gap-4 py-2 border-t border-line-subtle first:border-t-0 text-[12.5px]">
              <span className="flex-1 min-w-0 text-content-secondary">{what}</span>
              <span className="flex flex-wrap justify-end gap-1.5">
                {keys.map((k) => <kbd key={k} className="px-1.5 h-[22px] inline-flex items-center rounded-[5px] border border-line bg-surface-2 font-mono text-[11.5px] text-content">{k}</kbd>)}
              </span>
            </div>
          ))}
        </div>
      ))}
    </Page>
  );
}
