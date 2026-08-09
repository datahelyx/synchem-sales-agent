/** Thin fetch wrapper — every call goes through here so errors surface the same way. */

export class ApiError extends Error {
  constructor(public status: number, message: string, public detail?: unknown) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    let detail: unknown;
    try {
      const body = await res.json();
      message = body.error ?? message;
      detail = body.detail;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, message, detail);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) => request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  put: <T>(path: string, body: unknown) => request<T>(path, { method: 'PUT', body: JSON.stringify(body) }),

  /** Multipart — used only by the CSV upload. */
  upload: async <T>(path: string, file: File, fields: Record<string, string> = {}): Promise<T> => {
    const form = new FormData();
    form.append('file', file);
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    const res = await fetch(`/api${path}`, { method: 'POST', body: form });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new ApiError(res.status, body.error ?? `Upload failed (${res.status})`, body.detail);
    }
    return res.json() as Promise<T>;
  },
};

/* ------------------------------------------------------------------ types */

export interface Salesman {
  id: number;
  name: string;
  email: string | null;
  phone_e164: string | null;
  role: 'salesman' | 'manager';
  weekly_quota: number;
  areas: string | null;
  active: number;
  assigned_this_week?: number;
  companies_owned?: number;
  upcoming_meetings?: number;
  unread?: number;
  deals_won?: number;
}

export interface AssignmentRow {
  id: number;
  company_id: number;
  salesman_id: number;
  week_start: string;
  status: string;
  reason: string | null;
  notes: string | null;
  company_name: string;
  area: string | null;
  industry: string | null;
  phone: string | null;
  phone_e164: string | null;
  email: string | null;
  contact_name: string | null;
  contact_title: string | null;
  stage: string;
  data_quality: number;
  salesman_name: string;
  activity_count: number;
  open_meeting_id: number | null;
  open_meeting_at: string | null;
  last_meeting_id: number | null;
  last_outcome: 'positive' | 'approved' | 'rejected' | null;
  whatsapp_url: string | null;
}

export interface Product {
  id: number;
  sku: string;
  name: string;
  category: string | null;
  pack_size: string | null;
  uom: string;
  unit_price: number;
  stock_qty: number;
  sample_qty: number;
}

export interface ReasonCode {
  id: number;
  outcome: 'positive' | 'approved' | 'rejected';
  code: string;
  label: string;
}

export interface Feedback {
  id: number;
  meeting_id: number;
  company_id: number;
  outcome: 'positive' | 'approved' | 'rejected';
  reason_code: string | null;
  reason_note: string | null;
  sample_requested: number;
  deal_value: number | null;
  next_step_on: string | null;
  met_contact: string | null;
  updated_at: string;
  sampleLines?: Array<{ productId: number; qty: number; name: string; uom: string; sku: string }>;
  invoice?: { id: number; number: string; total: number; status: string } | null;
  revisions?: Array<{ id: number; created_at: string }>;
}

export interface NotificationRow {
  id: number;
  channel: string;
  template: string;
  recipient_type: string;
  recipient_id: number | null;
  to_addr: string | null;
  subject: string | null;
  body: string;
  status: string;
  read_at: string | null;
  sent_at: string | null;
  error: string | null;
  created_at: string;
}

export interface SlotDay {
  date: string;
  label: string;
  slots: Array<{ iso: string; label: string; free: boolean }>;
}
