import { dismissToast, useAppStore } from '../store/useAppStore';
import s from '../styles/ui.module.css';

export function Toasts(): React.JSX.Element {
  const toasts = useAppStore((st) => st.toasts);
  return (
    <div className={s.toasts} aria-live="polite" data-testid="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`${s.toast} ${t.kind === 'error' ? s.toastError : ''}`} role="status">
          <span>{t.text}</span>
          {t.action && (
            <button
              className={s.linkBtn}
              onClick={() => {
                t.action!.run();
                dismissToast(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          <button className={s.toastClose} onClick={() => dismissToast(t.id)} aria-label="Dismiss">
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
