import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useAppStore, setState } from '../store/useAppStore';
import { copyNode, openCsvDialog, setExpanded } from '../lib/actions';
import { isContainer } from '../lib/visible';
import s from '../styles/ui.module.css';

export function ContextMenu(): React.JSX.Element | null {
  const menu = useAppStore((st) => st.contextMenu);
  const doc = useAppStore((st) => st.doc);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });

  useLayoutEffect(() => {
    if (!menu || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    setPos({
      x: Math.min(menu.x, window.innerWidth - r.width - 8),
      y: Math.min(menu.y, window.innerHeight - r.height - 8),
    });
    ref.current.querySelector<HTMLButtonElement>('button')?.focus();
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const close = (e: Event): void => {
      if (e instanceof MouseEvent && ref.current?.contains(e.target as Node)) return;
      setState({ contextMenu: null });
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setState({ contextMenu: null });
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('blur', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  if (!menu || !doc) return null;
  const id = menu.nodeId;
  const container = isContainer(doc.index, id);
  const item = (label: string, run: () => void, enabled = true) => (
    <button
      role="menuitem"
      className={s.menuItem}
      disabled={!enabled}
      onClick={() => {
        setState({ contextMenu: null });
        run();
      }}
    >
      {label}
    </button>
  );
  return (
    <div
      ref={ref}
      className={s.menu}
      role="menu"
      aria-label="Node actions"
      style={{ left: pos.x || menu.x, top: pos.y || menu.y }}
      data-testid="context-menu"
      onKeyDown={(e) => {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        e.preventDefault();
        const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
        const i = items.indexOf(document.activeElement as HTMLButtonElement);
        items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
      }}
    >
      {item('Copy key', () => void copyNode(id, 'key'), id > 0)}
      {item('Copy value', () => void copyNode(id, 'value'))}
      {item('Copy path', () => void copyNode(id, 'path'))}
      {item('Copy subtree as formatted JSON', () => void copyNode(id, 'subtree'))}
      <div className={s.menuSep} />
      {item('Expand all below', () => setExpanded(id, 1, true), container)}
      {item('Collapse all below', () => setExpanded(id, 0, true), container)}
      <div className={s.menuSep} />
      {item('Export this node as CSV…', () => openCsvDialog(id))}
    </div>
  );
}
