import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { INDENT_PX, ROW_HEIGHT } from '@shared/constants';
import { useAppStore, setState } from '../../store/useAppStore';
import { isContainer, rowOf } from '../../lib/visible';
import { buildHighlighter } from '../../lib/highlight';
import { select, setExpanded, toggle } from '../../lib/actions';
import { TreeRow } from './TreeRow';
import s from '../../styles/ui.module.css';

/**
 * DECISION: the tree uses a small fixed-row virtualiser instead of @tanstack/react-virtual (which the
 * property panel and CSV preview use). Fully expanded large documents have millions of rows, and
 * rows × 22 px exceeds the browser's maximum element height (~33M px). This virtualiser caps the
 * scroll height and maps the scroll position proportionally onto rows, so any row count works.
 */
const MAX_SCROLL_PX = 8_000_000;
const OVERSCAN = 8;

export function TreeView(): React.JSX.Element | null {
  const doc = useAppStore((st) => st.doc);
  const selected = useAppStore((st) => st.selected);
  const scrollTo = useAppStore((st) => st.scrollTo);
  const search = useAppStore((st) => st.search);
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(400);

  const rows = doc?.visible.length ?? 0;
  const realH = rows * ROW_HEIGHT;
  const spacerH = Math.min(realH, MAX_SCROLL_PX);
  const scaled = realH > MAX_SCROLL_PX;
  const viewRows = height / ROW_HEIGHT;

  const firstExact = scaled
    ? (scrollTop / Math.max(1, spacerH - height)) * Math.max(0, rows - viewRows)
    : scrollTop / ROW_HEIGHT;

  const scrollToRow = useCallback(
    (r: number, mode: 'center' | 'nearest') => {
      const el = ref.current;
      if (!el || r < 0) return;
      const vr = el.clientHeight / ROW_HEIGHT;
      let first: number;
      if (mode === 'nearest') {
        if (r >= firstExact && r <= firstExact + vr - 1) return;
        first = r < firstExact ? r : r - vr + 1;
      } else {
        if (r >= firstExact + 1 && r <= firstExact + vr - 2) return;
        first = r - vr / 2;
      }
      first = Math.max(0, first);
      el.scrollTop = scaled
        ? (first / Math.max(1, rows - vr)) * (spacerH - el.clientHeight)
        : first * ROW_HEIGHT;
      setScrollTop(el.scrollTop);
    },
    [firstExact, scaled, rows, spacerH],
  );

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight || 400));
    ro.observe(el);
    setHeight(el.clientHeight || 400);
    return () => ro.disconnect();
  }, [doc !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  // Scroll requests from search / reveal.
  const lastSeq = useRef(0);
  useEffect(() => {
    if (!doc || !scrollTo || scrollTo.seq === lastSeq.current) return;
    lastSeq.current = scrollTo.seq;
    scrollToRow(rowOf(doc.visible, scrollTo.id), 'center');
  }, [scrollTo, doc, scrollToRow]);

  const raf = useRef(0);
  const onScroll = (): void => {
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => setScrollTop(ref.current?.scrollTop ?? 0));
  };

  const hl = useMemo(() => buildHighlighter(search.query, search.opts), [search.query, search.opts]);
  const currentMatch = search.current >= 0 ? search.ids[search.current] : -1;

  const onToggle = useCallback((id: number, subtree: boolean) => toggle(id, subtree), []);
  const onSelect = useCallback((id: number) => {
    select(id);
    ref.current?.focus({ preventScroll: true });
  }, []);
  const onMenu = useCallback(
    (id: number, x: number, y: number) => setState({ contextMenu: { x, y, nodeId: id } }),
    [],
  );

  if (!doc) return null;
  const { index: idx, visible, expanded } = doc;

  const start = Math.max(0, Math.floor(firstExact) - OVERSCAN);
  const end = Math.min(rows, Math.ceil(firstExact + viewRows) + OVERSCAN);
  const items: React.JSX.Element[] = [];
  for (let r = start; r < end; r++) {
    const id = visible[r];
    items.push(
      <TreeRow
        key={id}
        idx={idx}
        id={id}
        top={scrollTop + (r - firstExact) * ROW_HEIGHT}
        expanded={expanded[id] === 1}
        selected={id === selected}
        current={id === currentMatch}
        hl={hl}
        onToggle={onToggle}
        onSelect={onSelect}
        onMenu={onMenu}
      />,
    );
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const row = rowOf(visible, selected);
    const move = (r: number): void => {
      const target = Math.max(0, Math.min(rows - 1, r));
      select(visible[target]);
      scrollToRow(target, 'nearest');
    };
    const page = Math.max(1, Math.floor(viewRows) - 1);
    switch (e.key) {
      case 'ArrowDown':
        move(row < 0 ? 0 : row + 1);
        break;
      case 'ArrowUp':
        move(row < 0 ? 0 : row - 1);
        break;
      case 'PageDown':
        move(row + page);
        break;
      case 'PageUp':
        move(row - page);
        break;
      case 'Home':
        move(0);
        break;
      case 'End':
        move(rows - 1);
        break;
      case 'ArrowRight':
        if (selected < 0) return move(0);
        if (isContainer(idx, selected)) {
          if (!expanded[selected]) setExpanded(selected, 1, e.altKey);
          else if (idx.childCount[selected] > 0) move(row + 1);
        }
        break;
      case 'ArrowLeft':
        if (selected < 0) return;
        if (isContainer(idx, selected) && expanded[selected]) setExpanded(selected, 0, e.altKey);
        else if (idx.parent[selected] >= 0) {
          const p = idx.parent[selected];
          select(p);
          scrollToRow(rowOf(visible, p), 'nearest');
        }
        break;
      case 'Enter':
      case ' ':
        if (selected >= 0) toggle(selected, e.altKey);
        break;
      case 'ContextMenu': {
        if (selected < 0) return;
        const el = document.getElementById(`node-${selected}`);
        const b = el?.getBoundingClientRect();
        setState({ contextMenu: { x: (b?.left ?? 0) + 40, y: (b?.bottom ?? 0) - 4, nodeId: selected } });
        break;
      }
      default:
        return;
    }
    e.preventDefault();
  };

  return (
    <div
      ref={ref}
      className={s.tree}
      role="tree"
      aria-label="JSON tree"
      aria-activedescendant={selected >= 0 ? `node-${selected}` : undefined}
      tabIndex={0}
      onScroll={onScroll}
      onKeyDown={onKeyDown}
      data-testid="tree"
      data-rows={rows}
    >
      <div className={s.treeInner} style={{ height: spacerH, minWidth: idx.maxDepth * INDENT_PX + 700 }}>
        {items}
      </div>
    </div>
  );
}
