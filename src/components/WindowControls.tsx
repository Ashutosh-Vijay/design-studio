import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';

// Copied from DataWeave Studio. The window has decorations: false, so these are the
// only minimize / maximize / close buttons. Outside Tauri (plain browser) there is no window.
export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export function WindowControls() {
  if (!isTauri) return null;
  return <TauriWindowControls />;
}

function TauriWindowControls() {
  const [maximized, setMaximized] = useState(false);
  const win = getCurrentWindow();

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      setMaximized(await win.isMaximized());
      unlisten = await win.onResized(async () => setMaximized(await win.isMaximized()));
    })();
    return () => { if (unlisten) unlisten(); };
  }, [win]);

  const btn = 'h-11 w-11 flex items-center justify-center text-content-muted hover:bg-surface-2 hover:text-content cursor-pointer transition-colors';
  return (
    <div className="flex items-center h-full">
      <button onClick={() => win.minimize()} aria-label="Minimize" className={btn}>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M0 5h10" stroke="currentColor" strokeWidth="1" /></svg>
      </button>
      <button onClick={() => win.toggleMaximize()} aria-label={maximized ? 'Restore' : 'Maximize'} className={btn}>
        {maximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <rect x="0.5" y="2.5" width="7" height="7" stroke="currentColor" strokeWidth="1" />
            <path d="M2.5 2.5V0.5h7v7h-2" stroke="currentColor" strokeWidth="1" fill="none" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" strokeWidth="1" /></svg>
        )}
      </button>
      <button
        onClick={() => win.close()}
        aria-label="Close"
        className="h-11 w-11 flex items-center justify-center text-content-muted cursor-pointer hover:text-white hover:bg-[#e81123] transition-colors"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" /></svg>
      </button>
    </div>
  );
}
