import { useAppStore } from '../store/useAppStore';
import { setTab } from '../lib/actions';
import s from '../styles/ui.module.css';

export function Tabs(): React.JSX.Element {
  const tab = useAppStore((st) => st.tab);
  const name = useAppStore((st) => st.doc?.name);
  return (
    <div className={s.tabs} role="tablist" aria-label="View">
      {(['text', 'viewer'] as const).map((t) => (
        <button
          key={t}
          role="tab"
          aria-selected={tab === t}
          className={`${s.tab} ${tab === t ? s.tabActive : ''}`}
          onClick={() => setTab(t)}
          data-testid={`tab-${t}`}
          title={t === 'text' ? 'Text (⌘1)' : 'Viewer (⌘2)'}
        >
          {t === 'text' ? 'Text' : 'Viewer'}
        </button>
      ))}
      {name && (
        <span className={s.docName} title={name}>
          {name}
        </span>
      )}
    </div>
  );
}
