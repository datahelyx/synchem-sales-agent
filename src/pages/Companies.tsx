import { Building2, ChevronLeft, ChevronRight, Search, SlidersHorizontal } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { phoneLabel, qualityLabel, STAGE_META } from '../lib/format';
import { Badge, EmptyState, ErrorNote, Loading, useApi, useDebounced, useQueryString } from '../ui';

interface CompanyRow {
  id: number; name: string; area: string | null; phone: string | null; phone_e164: string | null;
  email: string | null; industry: string | null; contact_name: string | null; contact_title: string | null;
  stage: string; owner_name: string | null; data_quality: number; times_assigned: number;
}

interface Facets {
  areas: Array<{ value: string; n: number }>;
  industries: Array<{ value: string; n: number }>;
  stages: Array<{ value: string; n: number }>;
  owners: Array<{ value: number; label: string; n: number }>;
}

export function Companies() {
  const [q, setQ] = useState('');
  const [stage, setStage] = useState('');
  const [area, setArea] = useState('');
  const [industry, setIndustry] = useState('');
  const [owner, setOwner] = useState('');
  const [quality, setQuality] = useState('');
  const [sort, setSort] = useState('name');
  const [page, setPage] = useState(1);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const debouncedQ = useDebounced(q, 300);
  const qs = useQueryString({ q: debouncedQ, stage, area, industry, owner, quality, sort, page, pageSize: 25 });

  const { data: facets } = useApi<Facets>('/companies/facets');
  const { data, loading, error, refresh } = useApi<{ total: number; rows: CompanyRow[]; pageSize: number }>(
    `/companies${qs}`,
  );

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const activeFilters = [stage, area, industry, owner, quality].filter(Boolean).length;

  function reset() {
    setStage(''); setArea(''); setIndustry(''); setOwner(''); setQuality(''); setPage(1);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">Companies</h1>
          <p className="mt-0.5 text-sm text-slate-500">
            {data ? `${data.total.toLocaleString()} matching` : 'Loading'} · imported from your CSV
          </p>
        </div>
      </div>

      <div className="card p-3">
        <div className="flex flex-wrap gap-2">
          <div className="relative min-w-[14rem] flex-1">
            <Search size={15} className="absolute left-3 top-2.5 text-slate-400" />
            <input
              className="input pl-9"
              placeholder="Search name, contact, phone or email…"
              value={q}
              onChange={(e) => { setQ(e.target.value); setPage(1); }}
            />
          </div>
          <button className="btn-ghost" onClick={() => setFiltersOpen((v) => !v)}>
            <SlidersHorizontal size={15} />
            Filters{activeFilters > 0 && <span className="rounded-full bg-brand-600 px-1.5 text-[11px] text-white">{activeFilters}</span>}
          </button>
          <select className="input w-auto" value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="name">Sort: name</option>
            <option value="quality">Sort: best details first</option>
            <option value="recent">Sort: recently touched</option>
            <option value="stage">Sort: stage</option>
          </select>
        </div>

        {filtersOpen && (
          <div className="mt-3 grid gap-2 border-t border-slate-100 pt-3 sm:grid-cols-2 lg:grid-cols-5">
            <select className="input" value={stage} onChange={(e) => { setStage(e.target.value); setPage(1); }}>
              <option value="">Any stage</option>
              {facets?.stages.map((s) => (
                <option key={s.value} value={s.value}>{STAGE_META[s.value]?.label ?? s.value} ({s.n})</option>
              ))}
            </select>
            <select className="input" value={area} onChange={(e) => { setArea(e.target.value); setPage(1); }}>
              <option value="">Any area</option>
              {facets?.areas.slice(0, 60).map((a) => <option key={a.value} value={a.value}>{a.value} ({a.n})</option>)}
            </select>
            <select className="input" value={industry} onChange={(e) => { setIndustry(e.target.value); setPage(1); }}>
              <option value="">Any industry</option>
              {facets?.industries.map((i) => <option key={i.value} value={i.value}>{i.value} ({i.n})</option>)}
            </select>
            <select className="input" value={owner} onChange={(e) => { setOwner(e.target.value); setPage(1); }}>
              <option value="">Anyone</option>
              <option value="none">Unassigned</option>
              {facets?.owners.map((o) => <option key={o.value} value={o.value}>{o.label} ({o.n})</option>)}
            </select>
            <select className="input" value={quality} onChange={(e) => { setQuality(e.target.value); setPage(1); }}>
              <option value="">Any data quality</option>
              <option value="contactable">Has a phone number</option>
              <option value="missing">Cannot be contacted</option>
            </select>
            {activeFilters > 0 && (
              <button className="btn-subtle sm:col-span-2 lg:col-span-1" onClick={reset}>Clear filters</button>
            )}
          </div>
        )}
      </div>

      {loading ? (
        <Loading />
      ) : error ? (
        <ErrorNote message={error} onRetry={refresh} />
      ) : !data?.rows.length ? (
        <EmptyState icon={<Building2 size={26} />} title="No companies match" body="Try clearing a filter or searching for something else." />
      ) : (
        <>
          <div className="card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[46rem] text-left text-sm">
                <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-4 py-2.5 font-medium">Company</th>
                    <th className="px-4 py-2.5 font-medium">Contact</th>
                    <th className="px-4 py-2.5 font-medium">Area</th>
                    <th className="px-4 py-2.5 font-medium">Stage</th>
                    <th className="px-4 py-2.5 font-medium">Owner</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.rows.map((c) => {
                    const stageMeta = STAGE_META[c.stage] ?? STAGE_META.new;
                    const quality = qualityLabel(c.data_quality);
                    return (
                      <tr key={c.id} className="row-hover">
                        <td className="px-4 py-2.5">
                          <Link to={`/companies/${c.id}`} className="font-medium text-slate-800 transition-colors hover:text-accent-600">
                            {c.name}
                          </Link>
                          <div className="mt-0.5 flex flex-wrap gap-1">
                            {c.industry && <Badge>{c.industry}</Badge>}
                            <Badge tone={quality.tone}>{quality.text}</Badge>
                          </div>
                        </td>
                        <td className="px-4 py-2.5 text-slate-600">
                          <span className="block">{[c.contact_title, c.contact_name].filter(Boolean).join(' ') || '—'}</span>
                          <span className="block text-xs text-slate-400">{phoneLabel(c.phone_e164, c.phone) || 'no phone'}</span>
                        </td>
                        <td className="px-4 py-2.5 text-slate-600">{c.area ?? '—'}</td>
                        <td className="px-4 py-2.5"><Badge tone={stageMeta.tone}>{stageMeta.label}</Badge></td>
                        <td className="px-4 py-2.5 text-slate-600">{c.owner_name ?? <span className="text-slate-400">Unassigned</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-slate-500">Page {page} of {totalPages.toLocaleString()}</p>
            <div className="flex gap-2">
              <button className="btn-ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                <ChevronLeft size={15} /> Previous
              </button>
              <button className="btn-ghost" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
                Next <ChevronRight size={15} />
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
