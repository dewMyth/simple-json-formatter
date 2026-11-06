import { useEffect, useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import s from '../styles/ui.module.css';

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(performance.now());
  useEffect(() => {
    const t = setInterval(() => setNow(performance.now()), 100);
    return () => clearInterval(t);
  }, []);
  return <span className={s.muted}>{((now - since) / 1000).toFixed(1)} s</span>;
}

/** Appears only when a job takes longer than LOADER_DELAY_MS. Esc or the button cancels. */
export function LoaderOverlay(): React.JSX.Element | null {
  const job = useAppStore((st) => st.job);
  if (!job?.shown) return null;
  const determinate = job.pct !== undefined;
  return (
    <div className={s.overlay} role="alertdialog" aria-busy="true" aria-label="Working" data-testid="loader">
      <div className={s.loaderBox}>
        <div className={s.ring} aria-hidden />
        <div className={s.loaderStage} aria-live="polite" data-testid="loader-stage">
          {job.stage}
        </div>
        <div
          className={s.bar}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={determinate ? job.pct : undefined}
        >
          {determinate ? (
            <div className={s.barFill} style={{ width: `${job.pct}%` }} />
          ) : (
            <div className={s.barIndeterminate} />
          )}
        </div>
        <div className={s.loaderFoot}>
          <Elapsed since={job.startedAt} />
          <button className={s.tbBtn} onClick={job.cancel} data-testid="btn-cancel">
            Cancel <kbd className={s.kbd}>Esc</kbd>
          </button>
        </div>
      </div>
    </div>
  );
}
