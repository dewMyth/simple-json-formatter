import { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { CsvPreview as Preview } from '@shared/types';
import s from '../../styles/ui.module.css';

const ROW = 26;
const COL_W = 160;

/** Virtualised table of the first rows (rows and columns are both virtualised). */
export function CsvPreview({ preview }: { preview: Preview }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const rows = useVirtualizer({
    count: preview.rows.length,
    getScrollElement: () => ref.current,
    estimateSize: () => ROW,
    overscan: 8,
  });
  const cols = useVirtualizer({
    horizontal: true,
    count: preview.columns.length,
    getScrollElement: () => ref.current,
    estimateSize: () => COL_W,
    overscan: 3,
  });
  const width = cols.getTotalSize();
  const vcols = cols.getVirtualItems();
  return (
    <div className={s.csvTable} ref={ref} role="table" aria-label="CSV preview" data-testid="csv-preview">
      <div style={{ width, height: rows.getTotalSize() + ROW, position: 'relative' }}>
        <div className={s.csvHead} style={{ width, height: ROW }} role="row">
          {vcols.map((c) => (
            <div
              key={c.key}
              className={s.csvCell}
              role="columnheader"
              style={{ left: c.start, width: COL_W }}
              title={preview.columns[c.index]}
            >
              {preview.columns[c.index]}
            </div>
          ))}
        </div>
        {rows.getVirtualItems().map((r) => (
          <div key={r.key} className={s.csvRow} role="row" style={{ top: r.start + ROW, height: ROW, width }}>
            {vcols.map((c) => {
              const v = preview.rows[r.index][c.index];
              return (
                <div
                  key={c.key}
                  className={s.csvCell}
                  role="cell"
                  style={{ left: c.start, width: COL_W }}
                  title={v}
                >
                  {v}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
