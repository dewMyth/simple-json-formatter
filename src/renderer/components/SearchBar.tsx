import { forwardRef, useEffect, useRef, useState } from 'react';
import type { SearchOptions } from '@shared/types';
import { SEARCH_DEBOUNCE_MS } from '@shared/constants';
import { useAppStore } from '../store/useAppStore';
import { nextResult, runSearch } from '../lib/actions';
import { fmtInt } from '../lib/visible';
import s from '../styles/ui.module.css';

const TOGGLES: Array<[keyof SearchOptions, string, string]> = [
  ['keys', 'K', 'Search keys'],
  ['values', 'V', 'Search values'],
  ['caseSensitive', 'Aa', 'Match case'],
  ['wholeWord', 'W', 'Whole word'],
  ['regex', '.*', 'Regular expression'],
];

export const SearchBar = forwardRef<HTMLInputElement, { disabled?: boolean }>(function SearchBar(
  { disabled },
  ref,
) {
  const search = useAppStore((st) => st.search);
  const hasDoc = useAppStore((st) => st.doc !== null);
  const [text, setText] = useState(search.query);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  // keep the box in sync if the query is reset elsewhere (Clear)
  useEffect(() => setText(search.query), [search.query]);

  const schedule = (q: string, opts: SearchOptions): void => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void runSearch(q, opts), SEARCH_DEBOUNCE_MS);
  };

  const count = search.ids.length;
  let status = '';
  if (search.error) status = 'Invalid pattern';
  else if (search.running) status = 'Searching…';
  else if (search.query && hasDoc) {
    status =
      count === 0
        ? 'No results'
        : `${search.current >= 0 ? fmtInt(search.current + 1) : '–'} of ${fmtInt(count)}${search.more ? '+ more' : ''}`;
  }

  return (
    <div className={s.searchBar} role="search">
      <span className={s.searchIcon} aria-hidden>
        ⌕
      </span>
      <input
        ref={ref}
        className={s.searchInput}
        type="search"
        placeholder="Search keys and values"
        aria-label="Search keys and values"
        value={text}
        disabled={disabled}
        data-testid="search-input"
        onChange={(e) => {
          setText(e.target.value);
          schedule(e.target.value, search.opts);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            clearTimeout(timer.current);
            if (text !== search.query) void runSearch(text, search.opts);
            else nextResult(e.shiftKey ? -1 : 1);
          } else if (e.key === 'Escape' && text) {
            e.stopPropagation();
            setText('');
            void runSearch('', search.opts);
          }
        }}
      />
      <span
        className={s.searchCount}
        data-testid="search-count"
        aria-live="polite"
        title={search.error ?? undefined}
      >
        {status}
      </span>
      {TOGGLES.map(([key, label, title]) => (
        <button
          key={key}
          className={`${s.searchToggle} ${search.opts[key] ? s.searchToggleOn : ''}`}
          title={title}
          aria-label={title}
          aria-pressed={search.opts[key]}
          disabled={disabled}
          onClick={() => {
            const opts = { ...search.opts, [key]: !search.opts[key] };
            void runSearch(text, opts);
          }}
        >
          {label}
        </button>
      ))}
      <button
        className={s.searchToggle}
        title="Previous result (Shift+Enter)"
        aria-label="Previous result"
        disabled={!count}
        onClick={() => nextResult(-1)}
      >
        ↑
      </button>
      <button
        className={s.searchToggle}
        title="Next result (Enter)"
        aria-label="Next result"
        disabled={!count}
        onClick={() => nextResult(1)}
      >
        ↓
      </button>
    </div>
  );
});
