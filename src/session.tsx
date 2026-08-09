import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, type Salesman } from './lib/api';

/**
 * Who is using the app.
 *
 * ASSUMPTION: no authentication in this build. You pick a person from a list
 * and the app remembers it. Real auth is a wrapper around this context — and
 * once this becomes an Odoo module, `res.users` replaces it entirely, so
 * building a login now would be work thrown away.
 */

interface SessionValue {
  people: Salesman[];
  current: Salesman | null;
  isManager: boolean;
  setCurrentId: (id: number) => void;
  refreshPeople: () => void;
  loading: boolean;
}

const Ctx = createContext<SessionValue>({
  people: [], current: null, isManager: false,
  setCurrentId: () => {}, refreshPeople: () => {}, loading: true,
});

export const useSession = () => useContext(Ctx);

const KEY = 'sales-agent.currentUserId';

export function SessionProvider({ children }: { children: ReactNode }) {
  const [people, setPeople] = useState<Salesman[]>([]);
  const [currentId, setId] = useState<number | null>(() => {
    const raw = localStorage.getItem(KEY);
    return raw ? Number(raw) : null;
  });
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    api
      .get<Salesman[]>('/salesmen')
      .then((rows) => {
        setPeople(rows);
        setId((prev) => {
          if (prev && rows.some((r) => r.id === prev)) return prev;
          // Default to the first salesman — the day-to-day user, not the manager.
          const fallback = rows.find((r) => r.role === 'salesman') ?? rows[0];
          return fallback?.id ?? null;
        });
      })
      .catch(() => setPeople([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  const setCurrentId = useCallback((id: number) => {
    setId(id);
    localStorage.setItem(KEY, String(id));
  }, []);

  useEffect(() => {
    if (currentId) localStorage.setItem(KEY, String(currentId));
  }, [currentId]);

  const value = useMemo<SessionValue>(() => {
    const current = people.find((p) => p.id === currentId) ?? null;
    return {
      people,
      current,
      isManager: current?.role === 'manager',
      setCurrentId,
      refreshPeople: load,
      loading,
    };
  }, [people, currentId, setCurrentId, load, loading]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
