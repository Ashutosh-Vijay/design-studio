// App-styled dropdowns. The native <select> and <datalist> popups are drawn by the system, ignore the theme,
// and in WebView2 show as a dark box even in Paper, so every dropdown and suggestion list uses these.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icons } from './Icons';

export type Opt = { value: string; label?: ReactNode; hint?: string; group?: string };

// The list itself: under its anchor (above when there's no room), in <body> so no panel clips it.
// The owner keeps the highlighted row, so arrow keys work from the button or text box that opened it.
export function PopupList({ anchor, opts, active, setActive, onPick, onClose, mono }: {
  anchor: HTMLElement; opts: Opt[]; active: number; setActive: (i: number) => void; onPick: (o: Opt) => void; onClose: () => void; mono?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top?: number; bottom?: number; width: number; max: number } | null>(null);
  useLayoutEffect(() => {
    const place = () => {
      const r = anchor.getBoundingClientRect();
      const below = window.innerHeight - r.bottom - 8, above = r.top - 8;
      const up = below < 180 && above > below;
      setPos({ left: Math.min(r.left, window.innerWidth - Math.max(r.width, 160) - 8), width: Math.max(r.width, 160), max: Math.min(280, up ? above : below),
        ...(up ? { bottom: window.innerHeight - r.top + 3 } : { top: r.bottom + 3 }) });
    };
    place();
    // A panel scrolling under it moves the anchor away: close rather than float in the wrong place. (A text box
    // scrolls itself as you type, so only something around the anchor counts.)
    const scroll = (e: Event) => { const t = e.target as Node; if (t !== anchor && (t === document || t.contains?.(anchor))) onClose(); };
    const down = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node) && !anchor.contains(e.target as Node)) onClose(); };
    // Escape closes the list first, before a dialog behind it hears it and closes too.
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); onClose(); } };
    window.addEventListener('scroll', scroll, true); window.addEventListener('resize', onClose); window.addEventListener('mousedown', down); window.addEventListener('keydown', esc, true);
    return () => { window.removeEventListener('scroll', scroll, true); window.removeEventListener('resize', onClose); window.removeEventListener('mousedown', down); window.removeEventListener('keydown', esc, true); };
  }, [anchor]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { ref.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' }); }, [active]);
  if (!pos || !opts.length) return null;
  let group: string | undefined;
  return createPortal(
    <div ref={ref} style={{ left: pos.left, top: pos.top, bottom: pos.bottom, minWidth: pos.width, maxHeight: pos.max }}
      className="fixed z-[100] overflow-auto p-1 rounded-lg bg-surface-2 border border-line shadow-[var(--shadow)] text-[12.5px]"
      onMouseDown={(e) => e.preventDefault()}>
      {opts.map((o, i) => {
        const head = o.group && o.group !== group ? (group = o.group) : null;
        return (
          <div key={o.value + i}>
            {head && <div className="px-2 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.5px] text-content-faint">{head}</div>}
            <div data-i={i} onMouseEnter={() => setActive(i)} onClick={() => onPick(o)}
              className={`h-7 px-2 flex items-center gap-3 rounded cursor-pointer whitespace-nowrap ${i === active ? 'bg-surface-3 text-content' : 'text-content-secondary'}`}>
              <span className={`flex-1 ${mono ? 'font-mono text-[11.5px]' : ''}`}>{o.label ?? o.value}</span>
              {o.hint && <span className="text-[11px] text-content-faint">{o.hint}</span>}
            </div>
          </div>
        );
      })}
    </div>,
    document.body,
  );
}

// A dropdown: a button showing the current choice, and the list under it.
export function Select({ value, options, onChange, className = '', title, disabled, mono }: {
  value: string; options: Opt[]; onChange: (v: string) => void; className?: string; title?: string; disabled?: boolean; mono?: boolean;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const cur = options.find((o) => o.value === value);
  const show = () => { setActive(Math.max(0, options.findIndex((o) => o.value === value))); setOpen(true); };
  const pick = (o: Opt) => { setOpen(false); if (o.value !== value) onChange(o.value); ref.current?.focus(); };
  return (
    <>
      <button ref={ref} type="button" title={title} disabled={disabled}
        onClick={(e) => { e.stopPropagation(); if (open) setOpen(false); else show(); }}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false); }
          else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (!open) show(); else setActive((active + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length); }
          else if ((e.key === 'Enter' || e.key === ' ') && open) { e.preventDefault(); if (options[active]) pick(options[active]); }
        }}
        className={`h-[26px] px-2 flex items-center gap-1.5 rounded-md border border-line bg-surface-input text-content text-left outline-none focus:border-accent disabled:opacity-60 ${mono ? 'font-mono' : ''} ${className}`}>
        <span className="flex-1 min-w-0 truncate">{cur?.label ?? cur?.value ?? value}</span>
        <Icons.ChevronDown size={11} className="shrink-0 text-content-faint" />
      </button>
      {open && ref.current && <PopupList anchor={ref.current} opts={options} active={active} setActive={setActive} onPick={pick} onClose={() => setOpen(false)} mono={mono} />}
    </>
  );
}
