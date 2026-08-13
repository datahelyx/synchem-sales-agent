import { X } from 'lucide-react';
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from 'react';
import { api } from './lib/api';

/* --------------------------------------------------------------- toasts */

type Toast = { id: number; text: string; tone: 'ok' | 'error' | 'info' };
const ToastCtx = createContext<(text: string, tone?: Toast['tone']) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastHost({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: Toast['tone'] = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  }, []);

  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4">
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            className={`pointer-events-auto max-w-md rounded-lg px-4 py-2.5 text-sm shadow-lift ${
              t.tone === 'error'
                ? 'bg-rose-600 text-white'
                : t.tone === 'info'
                  ? 'bg-slate-800 text-white'
                  : 'bg-emerald-600 text-white'
            }`}
          >
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/* ------------------------------------------------------------ data hook */

/** Minimal fetch-on-mount hook with a manual refresh — no extra dependency. */
export function useApi<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const [nonce, setNonce] = useState(0);
  const alive = useRef(true);
  /* Every request takes a ticket. Only the newest one may write state, so a
   * slow reply for an old path can never overwrite a newer one — that is how a
   * stale filter result, or one meeting's feedback, ends up on screen under a
   * different heading. */
  const ticket = useRef(0);
  const lastPath = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    const mine = ++ticket.current;

    // A different path is a different resource. Drop the previous answer so no
    // consumer reads record A's data while record B is still loading. A manual
    // refresh() keeps the current data on screen while it reloads.
    if (lastPath.current !== path) {
      lastPath.current = path;
      setData(null);
      setError(null);
    }

    if (!path) { setLoading(false); return; }
    setLoading(true);
    api
      .get<T>(path)
      .then((d) => { if (alive.current && ticket.current === mine) { setData(d); setError(null); } })
      .catch((e) => { if (alive.current && ticket.current === mine) setError(e.message); })
      .finally(() => { if (alive.current && ticket.current === mine) setLoading(false); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, nonce, ...deps]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading, refresh, setData };
}

/* -------------------------------------------------------------- pieces */

export function Spinner({ className = '' }: { className?: string }) {
  return (
    <span
      className={`inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-r-transparent ${className}`}
      aria-hidden
    />
  );
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-sm text-slate-500">
      <Spinner /> {label}…
    </div>
  );
}

export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="card border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
      <p className="font-medium">Something went wrong</p>
      <p className="mt-1">{message}</p>
      {onRetry && (
        <button className="btn-ghost mt-3" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function EmptyState({ icon, title, body, action }: { icon?: ReactNode; title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 bg-white/60 px-6 py-14 text-center">
      {icon && <div className="mb-3 text-slate-400">{icon}</div>}
      <p className="text-sm font-semibold text-slate-700">{title}</p>
      {body && <p className="mt-1 max-w-sm text-sm text-slate-500">{body}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Badge({ children, tone = 'bg-slate-100 text-slate-600' }: { children: ReactNode; tone?: string }) {
  return <span className={`chip ${tone}`}>{children}</span>;
}

export function Stat({
  label, value, sub, tone = 'text-slate-900', icon, iconTone = 'bg-slate-100 text-slate-500',
}: {
  label: string; value: ReactNode; sub?: ReactNode; tone?: string;
  icon?: ReactNode; iconTone?: string;
}) {
  return (
    <div className="card p-4">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
        {icon && <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-lg ${iconTone}`}>{icon}</span>}
      </div>
      <p className={`mt-1.5 text-2xl font-semibold tabular-nums ${tone}`}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-slate-500">{sub}</p>}
    </div>
  );
}

export function SectionTitle({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="mb-3 flex items-end justify-between gap-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">{title}</h2>
      {action}
    </div>
  );
}

/* --------------------------------------------------------------- modal */

export function Modal({
  open, onClose, title, subtitle, children, footer, wide,
}: {
  open: boolean; onClose: () => void; title: string; subtitle?: string;
  children: ReactNode; footer?: ReactNode; wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 p-0 sm:items-center sm:p-4">
      <div
        className={`flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-2xl bg-white shadow-lift sm:rounded-2xl ${
          wide ? 'sm:max-w-3xl' : 'sm:max-w-lg'
        }`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4">
          <div>
            <h3 className="text-base font-semibold text-slate-900">{title}</h3>
            {subtitle && <p className="mt-0.5 text-sm text-slate-500">{subtitle}</p>}
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600" aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="border-t border-slate-200 bg-slate-50 px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- forms */

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <div>
      <label className="label">{label}</label>
      {children}
      {error ? <p className="mt-1 text-xs text-rose-600">{error}</p> : hint ? <p className="hint">{hint}</p> : null}
    </div>
  );
}

/**
 * Big tappable choices instead of a <select>. The brief asks for dropdowns over
 * free text and for something usable on a phone; a 3-option select is a worse
 * version of this.
 */
export function ChoiceGroup<T extends string>({
  value, onChange, options, columns = 3,
}: {
  value: T | null;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: string; hint?: string; tone?: string }>;
  columns?: number;
}) {
  return (
    <div className={`grid gap-2 ${columns === 2 ? 'grid-cols-2' : 'grid-cols-1 sm:grid-cols-3'}`}>
      {options.map((o) => {
        const selected = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            aria-pressed={selected}
            className={`rounded-xl border px-3 py-2.5 text-left transition ${
              selected ? `${o.tone ?? 'border-brand-500 bg-brand-50 text-brand-800'} ring-2 ring-brand-100` : 'border-slate-200 bg-white hover:bg-slate-50'
            }`}
          >
            <span className="block text-sm font-semibold">{o.label}</span>
            {o.hint && <span className="mt-0.5 block text-xs text-slate-500">{o.hint}</span>}
          </button>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------- helpers */

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function useQueryString(params: Record<string, string | number | null | undefined>) {
  return useMemo(() => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === null || v === undefined || v === '') continue;
      sp.set(k, String(v));
    }
    const s = sp.toString();
    return s ? `?${s}` : '';
  }, [JSON.stringify(params)]); // eslint-disable-line react-hooks/exhaustive-deps
}
