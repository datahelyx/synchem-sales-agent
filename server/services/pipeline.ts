import { db } from '../db/index.js';

export const STAGES = [
  'new',
  'assigned',
  'contacted',
  'meeting_scheduled',
  'met',
  'sample_sent',
  'negotiating',
  'won',
  'lost',
  'on_hold',
] as const;

export type Stage = (typeof STAGES)[number];

export const STAGE_LABELS: Record<Stage, string> = {
  new: 'Not started',
  assigned: 'Assigned this week',
  contacted: 'Contacted',
  meeting_scheduled: 'Meeting scheduled',
  met: 'Meeting held',
  sample_sent: 'Sample sent',
  negotiating: 'Negotiating',
  won: 'Won',
  lost: 'Lost',
  on_hold: 'On hold',
};

export interface ActivityInput {
  companyId?: number | null;
  salesmanId?: number | null;
  kind: string;
  summary: string;
  detail?: unknown;
  actor?: 'agent' | 'salesman' | 'manager';
}

export function logActivity(a: ActivityInput) {
  db.prepare(
    `INSERT INTO activity (company_id, salesman_id, kind, summary, detail_json, actor)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    a.companyId ?? null,
    a.salesmanId ?? null,
    a.kind,
    a.summary,
    a.detail ? JSON.stringify(a.detail) : null,
    a.actor ?? 'agent',
  );
}

/**
 * Stages move forward on their own but a human can always set any stage — the
 * brief rules out locked states, so this is advisory ordering, not a gate.
 */
const ORDER: Record<Stage, number> = {
  new: 0,
  assigned: 1,
  contacted: 2,
  meeting_scheduled: 3,
  met: 4,
  sample_sent: 5,
  negotiating: 6,
  won: 7,
  lost: 7,
  on_hold: 1,
};

export function setStage(companyId: number, stage: Stage, opts: { force?: boolean; actor?: ActivityInput['actor']; salesmanId?: number | null } = {}) {
  const current = (db.prepare('SELECT stage FROM company WHERE id = ?').get(companyId) as any)?.stage as Stage | undefined;
  if (!current) return;
  if (current === stage) return;
  // Automated transitions never walk a company backwards; humans may.
  if (!opts.force && ORDER[stage] < ORDER[current] && current !== 'on_hold') return;

  db.prepare(`UPDATE company SET stage = ?, last_touched_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(
    stage,
    companyId,
  );
  logActivity({
    companyId,
    salesmanId: opts.salesmanId ?? null,
    kind: 'stage_change',
    summary: `${STAGE_LABELS[current]} → ${STAGE_LABELS[stage]}`,
    detail: { from: current, to: stage },
    actor: opts.actor ?? 'agent',
  });
}

export function recordRevision(entity: string, entityId: number, before: unknown, after: unknown, changedBy?: number | null) {
  db.prepare(
    `INSERT INTO revision (entity, entity_id, changed_by, before_json, after_json) VALUES (?, ?, ?, ?, ?)`,
  ).run(entity, entityId, changedBy ?? null, JSON.stringify(before), JSON.stringify(after));
}
