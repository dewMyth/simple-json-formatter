import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { NodeType, type TreeIndex } from '@shared/types';
import { PROPERTY_VIRTUALIZE_AT } from '@shared/constants';
import { useAppStore } from '../store/useAppStore';
import {
  childrenOf,
  displayValue,
  fmtInt,
  getLabel,
  isContainer,
  isTruncated,
  pathOf,
  getPreview,
} from '../lib/visible';
import { copyNode, copyText, getValue, select } from '../lib/actions';
import { TypeBadge } from './Tree/TypeBadge';
import s from '../styles/ui.module.css';

const ROW = 24;

function ChildRow({ idx, id, style }: { idx: TreeIndex; id: number; style?: React.CSSProperties }) {
  const isItem = idx.keyId[id] < 0;
  return (
    <div
      className={s.propRow}
      style={style}
      role="row"
      onDoubleClick={() => select(id, { reveal: true })}
      onClick={() => select(id, { reveal: true })}
      title="Click to select in the tree"
    >
      <span className={`${s.propName} mono`} role="cell">
        {isItem ? `[${getLabel(idx, id)}]` : getLabel(idx, id)}
      </span>
      <span role="cell">
        <TypeBadge type={idx.type[id]} />
      </span>
      <span className={`${s.propValue} mono`} data-t={idx.type[id]} role="cell">
        {displayValue(idx, id)}
      </span>
    </div>
  );
}

function ChildrenGrid({ idx, children }: { idx: TreeIndex; children: Int32Array }) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtual = children.length > PROPERTY_VIRTUALIZE_AT;
  const v = useVirtualizer({
    count: virtual ? children.length : 0,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW,
    overscan: 10,
  });
  return (
    <div className={s.propGrid} ref={parentRef} role="table" aria-label="Properties">
      <div className={`${s.propRow} ${s.propHead}`} role="row">
        <span role="columnheader">Name</span>
        <span role="columnheader">Type</span>
        <span role="columnheader">Value</span>
      </div>
      {virtual ? (
        <div style={{ height: v.getTotalSize(), position: 'relative' }}>
          {v.getVirtualItems().map((item) => (
            <ChildRow
              key={item.key}
              idx={idx}
              id={children[item.index]}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                height: ROW,
                transform: `translateY(${item.start}px)`,
              }}
            />
          ))}
        </div>
      ) : (
        Array.from(children, (id) => <ChildRow key={id} idx={idx} id={id} />)
      )}
    </div>
  );
}

function FullValue({ idx, id }: { idx: TreeIndex; id: number }) {
  const truncated = isTruncated(idx, id);
  const [full, setFull] = useState<string | null>(null);
  useEffect(() => {
    setFull(null);
    if (!truncated) return;
    let live = true;
    getValue(id, true).then(
      (v) => live && setFull(v),
      () => live && setFull('(could not load value)'),
    );
    return () => {
      live = false;
    };
  }, [id, truncated, idx]);
  const text = truncated ? full : getPreview(idx, id);
  return (
    <div className={s.fullValue}>
      <div className={s.fullValueHead}>
        <span>
          Value
          {idx.type[id] === NodeType.String && text !== null ? ` · ${fmtInt(text.length)} chars` : ''}
          {idx.type[id] === NodeType.BigNumber ? ' · big number (exact)' : ''}
        </span>
        <button className={s.smallBtn} onClick={() => void copyNode(id, 'value')} disabled={text === null}>
          Copy
        </button>
      </div>
      <pre className={`${s.fullValueText} mono`} data-t={idx.type[id]} data-testid="full-value">
        {text === null ? 'Loading…' : text}
      </pre>
    </div>
  );
}

export function PropertyPanel(): React.JSX.Element {
  const doc = useAppStore((st) => st.doc);
  const selected = useAppStore((st) => st.selected);
  const idx = doc?.index;
  const valid = idx && selected >= 0 && selected < idx.n;
  const children = useMemo(
    () => (valid && isContainer(idx, selected) ? childrenOf(idx, selected) : null),
    [idx, selected, valid],
  );
  if (!valid) return <div className={s.propEmpty}>Select a node to see its properties.</div>;
  const path = pathOf(idx, selected);
  return (
    <div className={s.prop} data-testid="property-panel">
      <div className={s.propTitle}>
        <TypeBadge type={idx.type[selected]} />
        <span className="mono">{getLabel(idx, selected)}</span>
        {children && (
          <span className={s.muted}>
            {fmtInt(children.length)}{' '}
            {idx.type[selected] === NodeType.Array
              ? children.length === 1
                ? 'item'
                : 'items'
              : children.length === 1
                ? 'property'
                : 'properties'}
          </span>
        )}
      </div>
      {children ? (
        children.length ? (
          <ChildrenGrid idx={idx} children={children} />
        ) : (
          <div className={s.propEmpty}>
            Empty {idx.type[selected] === NodeType.Array ? 'array' : 'object'}
          </div>
        )
      ) : (
        <>
          <div className={s.propGrid} role="table" aria-label="Properties">
            <div className={`${s.propRow} ${s.propHead}`} role="row">
              <span role="columnheader">Name</span>
              <span role="columnheader">Type</span>
              <span role="columnheader">Value</span>
            </div>
            <ChildRow idx={idx} id={selected} />
          </div>
          <FullValue idx={idx} id={selected} />
        </>
      )}
      <div className={s.propFooter}>
        <span className={s.muted}>Path:</span>
        <code className={`${s.path} mono`} data-testid="node-path" title={path}>
          {path}
        </code>
        <button className={s.smallBtn} onClick={() => void copyText(path, 'path')}>
          Copy path
        </button>
      </div>
    </div>
  );
}
