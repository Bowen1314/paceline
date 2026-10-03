import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';

/* Icons: a small hand-picked set, inline so nothing is fetched. 16px grid, 1.6 stroke. */
const PATHS: Record<string, ReactNode> = {
  logo: <><path d="M3 4.5h6M3 8h9M3 11.5h4" /><circle cx="11.5" cy="11.5" r="1.4" fill="currentColor" stroke="none" /></>,
  sun: <><circle cx="8" cy="8" r="2.8" /><path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1" /></>,
  moon: <path d="M13.2 9.6A5.6 5.6 0 0 1 6.4 2.8a5.6 5.6 0 1 0 6.8 6.8Z" />,
  plus: <path d="M8 3v10M3 8h10" />,
  minus: <path d="M3 8h10" />,
  check: <path d="m3.2 8.4 3 3 6.6-6.8" />,
  x: <path d="m4 4 8 8M12 4l-8 8" />,
  spark: <path d="M8 1.8 9.5 6l4.2 1.5L9.5 9 8 13.2 6.5 9 2.3 7.5 6.5 6 8 1.8Z" />,
  invoice: <><path d="M4 1.8h8v12.4l-2-1.2-2 1.2-2-1.2-2 1.2V1.8Z" /><path d="M6.2 5.4h3.6M6.2 8h3.6" /></>,
  bell: <><path d="M4 11V7.4a4 4 0 0 1 8 0V11l1.2 1.4H2.8L4 11Z" /><path d="M6.6 14h2.8" /></>,
  ban: <><circle cx="8" cy="8" r="5.8" /><path d="m4 4 8 8" /></>,
  clock: <><circle cx="8" cy="8" r="5.8" /><path d="M8 4.8V8l2.2 1.4" /></>,
  reset: <><path d="M2.6 8a5.4 5.4 0 1 0 1.7-3.9" /><path d="M2.4 2.6v2.8h2.8" /></>,
  columns: <><rect x="2" y="2.5" width="12" height="11" rx="1.5" /><path d="M6 2.5v11M10 2.5v11" /></>,
  pencil: <path d="m10.8 2.6 2.6 2.6-7.6 7.6-3.2.6.6-3.2 7.6-7.6Z" />,
  arrow: <path d="M3 8h10M9.2 4.2 13 8l-3.800 3.8" />,
  lock: <><rect x="3.4" y="7" width="9.2" height="6.6" rx="1.4" /><path d="M5.4 7V5.2a2.600 2.600 0 0 1 5.2 0V7" /></>,
  unlock: <><rect x="3.4" y="7" width="9.2" height="6.6" rx="1.4" /><path d="M5.4 7V5.2a2.600 2.600 0 0 1 5-1" /></>,
  flag: <><path d="M3.6 14V2.4" /><path d="M3.6 3h8.2l-1.600 2.600 1.600 2.600H3.600" /></>,
  play: <path d="M5 3.2v9.600l7.600-4.800L5 3.200Z" />,
};

export function Icon({ name, size = 16 }: { name: keyof typeof PATHS | string; size?: number }): ReactNode {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'ghost' | 'danger';
  size?: 'md' | 'sm';
  icon?: string;
  busy?: boolean;
}

export function Button({ variant = 'default', size = 'md', icon, busy, children, className, disabled, ...rest }: ButtonProps): ReactNode {
  const cls = ['btn', variant !== 'default' && `btn--${variant === 'danger' ? 'ghost btn--danger' : variant}`, size === 'sm' && 'btn--sm', !children && 'btn--icon', className].filter(Boolean).join(' ');
  return (
    <button type="button" className={cls} disabled={disabled || busy} {...rest}>
      {busy ? <span className="spinner" /> : icon ? <Icon name={icon} size={size === 'sm' ? 13 : 15} /> : null}
      {children}
    </button>
  );
}

/** Run an async action with a busy flag; errors go to the toast handler. */
export function useAction(onError: (message: string) => void): [boolean, (fn: () => Promise<unknown>) => void] {
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  // Set on mount as well as cleared on unmount: StrictMode mounts, unmounts and mounts again.
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  return [
    busy,
    (fn) => {
      setBusy(true);
      fn()
        .catch((e: unknown) => onError(e instanceof Error ? e.message : 'Something went wrong.'))
        .finally(() => { if (alive.current) setBusy(false); });
    },
  ];
}

export function Modal({ title, onClose, children, footer, narrow }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; narrow?: boolean }): ReactNode {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLElement>('textarea, input, select, button')?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal${narrow ? ' modal--narrow' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div className="modal-head">
          <h2>{title}</h2>
          <Button variant="ghost" icon="x" aria-label="Close" onClick={onClose} />
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

export interface Toast { id: number; text: string; tone: 'info' | 'error' }

export function Toasts({ items }: { items: Toast[] }): ReactNode {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((t) => <div key={t.id} className="toast" data-tone={t.tone}>{t.text}</div>)}
    </div>
  );
}

export function Skeleton({ rows = 6 }: { rows?: number }): ReactNode {
  return (
    <div className="skeleton" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => <i key={i} style={{ width: `${88 - ((i * 13) % 40)}%` }} />)}
    </div>
  );
}
