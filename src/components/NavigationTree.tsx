import { useEffect, useRef, type ReactNode } from 'react';

// Both project trees share the same keyboard behaviour. Selection still opens through their own click action.
export function NavigationTree({ label, children, className = '' }: { label: string; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const tree = ref.current!;
    const rows = [...tree.querySelectorAll<HTMLElement>('[role="treeitem"]')];
    const current = tree.contains(document.activeElement) ? (document.activeElement as HTMLElement)?.closest<HTMLElement>('[role="treeitem"]') : null;
    const target = current ?? rows.find((r) => r.getAttribute('aria-selected') === 'true') ?? rows.find((r) => r.tabIndex === 0) ?? rows[0];
    rows.forEach((r) => { r.tabIndex = r === target ? 0 : -1; });
  });
  return <div ref={ref} role="tree" aria-label={label} className={className}
    onFocusCapture={(e) => {
      const row = (e.target as HTMLElement).closest('[role="treeitem"]');
      if (row) ref.current!.querySelectorAll<HTMLElement>('[role="treeitem"]').forEach((r) => { r.tabIndex = r === row ? 0 : -1; });
    }}
    onKeyDown={(e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('[role="treeitem"]');
      if (!row || e.target !== row) return;
      const rows = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="treeitem"]')];
      const at = rows.indexOf(row), level = Number(row.getAttribute('aria-level') ?? 1);
      let next: HTMLElement | undefined;
      if (e.key === 'ArrowDown') next = rows[Math.min(at + 1, rows.length - 1)];
      else if (e.key === 'ArrowUp') next = rows[Math.max(0, at - 1)];
      else if (e.key === 'Home') next = rows[0];
      else if (e.key === 'End') next = rows[rows.length - 1];
      else if (e.key === 'ArrowRight') {
        if (row.getAttribute('aria-expanded') === 'false') (row.querySelector<HTMLElement>('[data-tree-toggle]') ?? row).click();
        else if (Number(rows[at + 1]?.getAttribute('aria-level')) > level) next = rows[at + 1];
      } else if (e.key === 'ArrowLeft') {
        if (row.getAttribute('aria-expanded') === 'true') (row.querySelector<HTMLElement>('[data-tree-toggle]') ?? row).click();
        else next = rows.slice(0, at).reverse().find((r) => Number(r.getAttribute('aria-level') ?? 1) < level);
      } else if (e.key === 'Enter' || e.key === ' ') row.click();
      else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
        const r = row.getBoundingClientRect();
        row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 24, clientY: r.bottom }));
      } else return;
      e.preventDefault(); e.stopPropagation();
      next?.focus();
      next?.scrollIntoView({ block: 'nearest' });
    }}>{children}</div>;
}
