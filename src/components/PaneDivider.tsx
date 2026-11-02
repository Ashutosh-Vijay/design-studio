import { useEffect, useRef } from 'react';

export function PaneDivider({ label, value, min, max, reverse = false, scale = 1, onChange }: {
  label: string; value: number; min: number; max: number; reverse?: boolean; scale?: number; onChange: (value: number) => void;
}) {
  const drag = useRef<{ x: number; value: number } | null>(null);
  useEffect(() => () => { document.documentElement.classList.remove('ads-resizing'); }, []);
  return <div role="separator" aria-label={label} aria-orientation="vertical" tabIndex={0}
    aria-valuenow={Math.round(value)} aria-valuemin={min} aria-valuemax={Math.round(max)}
    className="ads-divider shrink-0 relative z-10 touch-none"
    onPointerDown={(e) => {
      if (e.button !== 0) return;
      e.preventDefault(); e.currentTarget.focus(); e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = { x: e.clientX, value }; document.documentElement.classList.add('ads-resizing');
    }}
    onPointerMove={(e) => { if (drag.current) onChange(Math.max(min, Math.min(max, drag.current.value + (e.clientX - drag.current.x) * scale * (reverse ? -1 : 1)))); }}
    onLostPointerCapture={() => { if (drag.current) { drag.current = null; document.documentElement.classList.remove('ads-resizing'); } }}
    onPointerUp={(e) => { if (drag.current) e.currentTarget.releasePointerCapture(e.pointerId); }}
    onKeyDown={(e) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault();
      const next = e.key === 'Home' ? min : e.key === 'End' ? max : Math.max(min, Math.min(max, value + (e.key === 'ArrowRight' ? 16 : -16) * scale * (reverse ? -1 : 1)));
      onChange(next);
    }} />;
}
