import { memo } from 'react';
import { NODE_TYPE_NAMES } from '@shared/types';
import s from '../../styles/ui.module.css';

const LABELS = ['{}', '[]', 'str', 'num', 'bool', 'null', 'big'];

export const TypeBadge = memo(function TypeBadge({ type }: { type: number }) {
  return (
    <span className={s.badge} data-t={type} title={NODE_TYPE_NAMES[type]} aria-label={NODE_TYPE_NAMES[type]}>
      {LABELS[type]}
    </span>
  );
});
