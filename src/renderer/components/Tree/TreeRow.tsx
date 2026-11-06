import { memo } from 'react';
import type { TreeIndex } from '@shared/types';
import { INDENT_PX, ROW_HEIGHT } from '@shared/constants';
import { displayValue, getLabel, isContainer } from '../../lib/visible';
import { highlight } from '../../lib/highlight';
import { TypeBadge } from './TypeBadge';
import s from '../../styles/ui.module.css';

interface Props {
  idx: TreeIndex;
  id: number;
  top: number;
  expanded: boolean;
  selected: boolean;
  current: boolean;
  hl: RegExp | null;
  onToggle: (id: number, subtree: boolean) => void;
  onSelect: (id: number) => void;
  onMenu: (id: number, x: number, y: number) => void;
}

export const TreeRow = memo(function TreeRow({
  idx,
  id,
  top,
  expanded,
  selected,
  current,
  hl,
  onToggle,
  onSelect,
  onMenu,
}: Props) {
  const depth = idx.depth[id];
  const type = idx.type[id];
  const container = isContainer(idx, id);
  const isItem = id > 0 && idx.keyId[id] < 0;
  const label = getLabel(idx, id);
  const value = displayValue(idx, id);
  return (
    <div
      id={`node-${id}`}
      role="treeitem"
      aria-level={depth + 1}
      aria-selected={selected}
      aria-expanded={container ? expanded : undefined}
      data-node={id}
      className={`${s.row} ${selected ? s.rowSelected : ''} ${current ? s.rowMatch : ''}`}
      style={{ top, height: ROW_HEIGHT, paddingLeft: depth * INDENT_PX + 6 }}
      onMouseDown={(e) => {
        if (e.button === 0) onSelect(id);
      }}
      onClick={(e) => {
        if (e.altKey && container) onToggle(id, true);
      }}
      onDoubleClick={() => container && onToggle(id, false)}
      onContextMenu={(e) => {
        e.preventDefault();
        onSelect(id);
        onMenu(id, e.clientX, e.clientY);
      }}
      title={idx.flags[id] ? 'Truncated — see the property panel for the full value' : undefined}
    >
      {depth > 0 && <span className={s.guides} style={{ width: depth * INDENT_PX }} aria-hidden />}
      <span
        className={s.chevron}
        aria-hidden
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          if (container) onToggle(id, e.altKey);
          onSelect(id);
        }}
      >
        {container ? (expanded ? '▾' : '▸') : ''}
      </span>
      <TypeBadge type={type} />
      <span className={isItem ? s.index : s.key}>{isItem ? `[${label}]` : highlight(label, hl, s.mark)}</span>
      <span className={container ? s.summary : s.value} data-t={type}>
        {container ? value : highlight(value, hl, s.mark)}
      </span>
    </div>
  );
});
