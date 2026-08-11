-- AI Sales Manager Agent — schema
--
-- Entity names deliberately shadow their Odoo counterparts so that a later
-- custom module is a mapping exercise, not a redesign:
--
--   company        -> res.partner (is_company = true)
--   salesman       -> res.users / hr.employee
--   assignment     -> crm.lead
--   meeting        -> calendar.event
--   feedback       -> crm.lead outcome + mail.message
--   product        -> product.product
--   sample_request -> stock.picking      sample_line -> stock.move
--   invoice        -> account.move       invoice_line -> account.move.line
--   activity       -> mail.message (the per-company timeline)
--   notification   -> the outbox every channel adapter drains
--
-- Every mutable row carries updated_at. Nothing is write-once: the brief calls
-- for "no dead ends or locked states", so edits are UPDATEs plus an audit row
-- in `revision`, never a blocked write.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- companies

CREATE TABLE IF NOT EXISTS company (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT    NOT NULL,
  name_key         TEXT    NOT NULL,              -- normalized, for dedupe on re-import
  area             TEXT,                          -- CSV "City" is really a Lahore locality
  phone            TEXT,                          -- as supplied, e.g. 0321-4004998
  phone_e164       TEXT,                          -- +923000000000, for wa.me / tel:
  email            TEXT,
  industry         TEXT,                          -- normalized bucket
  industry_raw     TEXT,                          -- exactly what the CSV said
  contact_name     TEXT,
  contact_title    TEXT,                          -- MR. / MRS. / DR.
  notes            TEXT,                          -- leftover of Notes we did not parse
  stage            TEXT    NOT NULL DEFAULT 'new',
  owner_id         INTEGER REFERENCES salesman(id) ON DELETE SET NULL,
  times_assigned   INTEGER NOT NULL DEFAULT 0,
  last_assigned_on TEXT,
  last_touched_at  TEXT,
  follow_up_on     TEXT,                          -- agent re-surfaces the company on/after this date
  do_not_contact   INTEGER NOT NULL DEFAULT 0,
  data_quality     INTEGER NOT NULL DEFAULT 0,    -- 0-100, drives assignment priority
  import_batch_id  INTEGER REFERENCES import_batch(id) ON DELETE SET NULL,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  CHECK (stage IN ('new','assigned','contacted','meeting_scheduled','met',
                   'sample_sent','negotiating','won','lost','on_hold'))
);

CREATE UNIQUE INDEX IF NOT EXISTS company_name_key_idx ON company(name_key);
CREATE INDEX IF NOT EXISTS company_stage_idx     ON company(stage);
CREATE INDEX IF NOT EXISTS company_owner_idx     ON company(owner_id);
CREATE INDEX IF NOT EXISTS company_area_idx      ON company(area);
CREATE INDEX IF NOT EXISTS company_industry_idx  ON company(industry);
CREATE INDEX IF NOT EXISTS company_followup_idx  ON company(follow_up_on);

CREATE TABLE IF NOT EXISTS import_batch (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  filename      TEXT    NOT NULL,
  encoding      TEXT,
  rows_read     INTEGER NOT NULL DEFAULT 0,
  inserted      INTEGER NOT NULL DEFAULT 0,
  updated       INTEGER NOT NULL DEFAULT 0,
  skipped       INTEGER NOT NULL DEFAULT 0,
  warnings_json TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ------------------------------------------------------------------- people

CREATE TABLE IF NOT EXISTS salesman (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT    NOT NULL,
  email        TEXT,
  phone_e164   TEXT,
  role         TEXT    NOT NULL DEFAULT 'salesman',  -- salesman | manager
  weekly_quota INTEGER NOT NULL DEFAULT 2,           -- the brief's "2 companies a week"
  areas        TEXT,                                 -- comma-separated preferred areas, optional
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  CHECK (role IN ('salesman','manager'))
);

-- -------------------------------------------------------------- assignments

CREATE TABLE IF NOT EXISTS assignment (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id  INTEGER NOT NULL REFERENCES company(id)  ON DELETE CASCADE,
  salesman_id INTEGER NOT NULL REFERENCES salesman(id) ON DELETE CASCADE,
  week_start  TEXT    NOT NULL,                    -- ISO date of the Monday
  status      TEXT    NOT NULL DEFAULT 'pending',
  reason      TEXT,                                -- why the agent picked this company
  notes       TEXT,
  closed_at   TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  CHECK (status IN ('pending','in_progress','meeting_set','completed','skipped','carried_over'))
);

-- One salesman cannot be handed the same company twice in one week.
CREATE UNIQUE INDEX IF NOT EXISTS assignment_unique_idx
  ON assignment(company_id, salesman_id, week_start);
CREATE INDEX IF NOT EXISTS assignment_week_idx  ON assignment(week_start, salesman_id);
CREATE INDEX IF NOT EXISTS assignment_status_idx ON assignment(status);

-- ----------------------------------------------------------------- meetings

CREATE TABLE IF NOT EXISTS meeting (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id       INTEGER REFERENCES assignment(id) ON DELETE SET NULL,
  company_id          INTEGER NOT NULL REFERENCES company(id)  ON DELETE CASCADE,
  salesman_id         INTEGER NOT NULL REFERENCES salesman(id) ON DELETE CASCADE,
  scheduled_at        TEXT    NOT NULL,            -- ISO 8601, Asia/Karachi offset
  duration_min        INTEGER NOT NULL DEFAULT 30,
  mode                TEXT    NOT NULL DEFAULT 'onsite',   -- onsite | call | video
  location            TEXT,
  provider            TEXT    NOT NULL DEFAULT 'manual',   -- manual | calendly | odoo
  provider_event_id   TEXT,
  booking_url         TEXT,
  status              TEXT    NOT NULL DEFAULT 'scheduled',
  contact_notified_at TEXT,
  -- Every meeting is a physical visit whose time the salesman and the contact
  -- agree between themselves; these track that, and which reminders have
  -- already fired for this specific meeting time.
  agreed_with_contact      INTEGER NOT NULL DEFAULT 0,
  reminded_day_before_at   TEXT,
  reminded_hours_before_at TEXT,
  created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT    NOT NULL DEFAULT (datetime('now')),
  CHECK (status IN ('proposed','scheduled','held','no_show','cancelled','rescheduled')),
  CHECK (mode   IN ('onsite','call','video'))
);

CREATE INDEX IF NOT EXISTS meeting_when_idx    ON meeting(scheduled_at);
CREATE INDEX IF NOT EXISTS meeting_company_idx ON meeting(company_id);
CREATE INDEX IF NOT EXISTS meeting_sales_idx   ON meeting(salesman_id, status);

-- ----------------------------------------------------------------- feedback

-- Reason codes live in a table, not an enum, so the manager can add reasons
-- without a code change (and so the dashboard can group by them).
CREATE TABLE IF NOT EXISTS reason_code (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  outcome  TEXT NOT NULL,          -- positive | approved | rejected
  code     TEXT NOT NULL,
  label    TEXT NOT NULL,
  active   INTEGER NOT NULL DEFAULT 1,
  sort     INTEGER NOT NULL DEFAULT 0,
  UNIQUE (outcome, code),
  CHECK (outcome IN ('positive','approved','rejected'))
);

CREATE TABLE IF NOT EXISTS feedback (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id       INTEGER NOT NULL UNIQUE REFERENCES meeting(id) ON DELETE CASCADE,
  company_id       INTEGER NOT NULL REFERENCES company(id)  ON DELETE CASCADE,
  salesman_id      INTEGER NOT NULL REFERENCES salesman(id) ON DELETE CASCADE,
  outcome          TEXT    NOT NULL,
  reason_code      TEXT,
  reason_note      TEXT,
  sample_requested INTEGER NOT NULL DEFAULT 0,
  deal_value       REAL,                            -- filled when outcome = approved
  next_step_on     TEXT,                            -- schedules the agent's follow-up
  met_contact      TEXT,
  created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  CHECK (outcome IN ('positive','approved','rejected'))
);

CREATE INDEX IF NOT EXISTS feedback_outcome_idx ON feedback(outcome);
CREATE INDEX IF NOT EXISTS feedback_company_idx ON feedback(company_id);

-- Edits are always allowed; this is how we keep the history anyway.
CREATE TABLE IF NOT EXISTS revision (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  entity      TEXT    NOT NULL,       -- 'feedback', 'meeting', 'company', ...
  entity_id   INTEGER NOT NULL,
  changed_by  INTEGER REFERENCES salesman(id) ON DELETE SET NULL,
  before_json TEXT,
  after_json  TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS revision_entity_idx ON revision(entity, entity_id);

-- ---------------------------------------------------------------- inventory

CREATE TABLE IF NOT EXISTS product (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  sku        TEXT    NOT NULL UNIQUE,
  name       TEXT    NOT NULL,
  category   TEXT,
  pack_size  TEXT,
  uom        TEXT    NOT NULL DEFAULT 'kg',
  unit_price REAL    NOT NULL DEFAULT 0,
  stock_qty  REAL    NOT NULL DEFAULT 0,
  sample_qty REAL    NOT NULL DEFAULT 1,            -- default quantity for a sample
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sample_request (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  feedback_id  INTEGER REFERENCES feedback(id) ON DELETE SET NULL,
  company_id   INTEGER NOT NULL REFERENCES company(id)  ON DELETE CASCADE,
  salesman_id  INTEGER NOT NULL REFERENCES salesman(id) ON DELETE CASCADE,
  status       TEXT    NOT NULL DEFAULT 'draft',
  courier      TEXT,
  tracking_ref TEXT,
  dispatched_at TEXT,
  delivered_at  TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  CHECK (status IN ('draft','dispatched','delivered','cancelled'))
);

CREATE TABLE IF NOT EXISTS sample_line (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  sample_request_id INTEGER NOT NULL REFERENCES sample_request(id) ON DELETE CASCADE,
  product_id        INTEGER NOT NULL REFERENCES product(id),
  qty               REAL    NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS sample_line_req_idx ON sample_line(sample_request_id);

-- Stock is derived from movements, never edited blind — so an edited sample
-- request can be replayed without the on-hand number drifting.
CREATE TABLE IF NOT EXISTS stock_move (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES product(id) ON DELETE CASCADE,
  qty        REAL    NOT NULL,          -- negative = out
  reason     TEXT    NOT NULL,          -- 'sample_dispatch' | 'adjustment' | 'restock'
  ref_table  TEXT,
  ref_id     INTEGER,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ----------------------------------------------------------------- invoices

CREATE TABLE IF NOT EXISTS invoice (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  number      TEXT    NOT NULL UNIQUE,
  company_id  INTEGER NOT NULL REFERENCES company(id)  ON DELETE CASCADE,
  salesman_id INTEGER NOT NULL REFERENCES salesman(id) ON DELETE CASCADE,
  feedback_id INTEGER REFERENCES feedback(id) ON DELETE SET NULL,
  issue_date  TEXT    NOT NULL DEFAULT (date('now')),
  due_date    TEXT,
  currency    TEXT    NOT NULL DEFAULT 'PKR',
  subtotal    REAL    NOT NULL DEFAULT 0,
  tax_rate    REAL    NOT NULL DEFAULT 0,
  total       REAL    NOT NULL DEFAULT 0,
  status      TEXT    NOT NULL DEFAULT 'draft',
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  CHECK (status IN ('draft','sent','paid','cancelled'))
);

CREATE TABLE IF NOT EXISTS invoice_line (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id  INTEGER NOT NULL REFERENCES invoice(id) ON DELETE CASCADE,
  product_id  INTEGER REFERENCES product(id),
  description TEXT    NOT NULL,
  qty         REAL    NOT NULL DEFAULT 1,
  unit_price  REAL    NOT NULL DEFAULT 0,
  amount      REAL    NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS invoice_line_inv_idx ON invoice_line(invoice_id);
CREATE INDEX IF NOT EXISTS invoice_company_idx  ON invoice(company_id);

-- ------------------------------------------------------- agent + messaging

-- Every outbound message lands here first. Channel adapters drain it, so the
-- pipeline works with zero credentials configured and swapping WhatsApp for
-- email/Slack/Odoo-mail is one adapter, not a refactor.
CREATE TABLE IF NOT EXISTS notification (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  channel        TEXT    NOT NULL,          -- inapp | whatsapp | email | console
  template       TEXT    NOT NULL,
  recipient_type TEXT    NOT NULL,          -- salesman | contact | manager
  recipient_id   INTEGER,
  to_addr        TEXT,
  subject        TEXT,
  body           TEXT    NOT NULL,
  payload_json   TEXT,
  status         TEXT    NOT NULL DEFAULT 'queued',
  read_at        TEXT,
  sent_at        TEXT,
  error          TEXT,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  -- 'suppressed' = the outbound guard refused to deliver this to a real company
  -- contact. Terminal on purpose: the outbox drain never retries it.
  CHECK (status IN ('queued','sent','failed','read','suppressed'))
);

CREATE INDEX IF NOT EXISTS notification_inbox_idx ON notification(recipient_type, recipient_id, status);
CREATE INDEX IF NOT EXISTS notification_queue_idx ON notification(status, channel);

-- Per-company timeline. Everything the agent or a human does lands here so the
-- "historical per-company follow-up data" on the dashboard is a single query.
CREATE TABLE IF NOT EXISTS activity (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id  INTEGER REFERENCES company(id) ON DELETE CASCADE,
  salesman_id INTEGER REFERENCES salesman(id) ON DELETE SET NULL,
  kind        TEXT    NOT NULL,   -- assigned | meeting_scheduled | meeting_held | feedback |
                                  -- sample | invoice | note | stage_change | notification
  summary     TEXT    NOT NULL,
  detail_json TEXT,
  actor       TEXT    NOT NULL DEFAULT 'agent',   -- agent | salesman | manager
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS activity_company_idx ON activity(company_id, created_at);
CREATE INDEX IF NOT EXISTS activity_kind_idx    ON activity(kind, created_at);

-- Each autonomous run of the agent, so the manager can see what it did and why.
CREATE TABLE IF NOT EXISTS agent_run (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT    NOT NULL,      -- weekly_assignment | follow_up_sweep | reminder_sweep
  week_start  TEXT,
  trigger     TEXT    NOT NULL DEFAULT 'manual',   -- manual | cron
  created     INTEGER NOT NULL DEFAULT 0,
  skipped     INTEGER NOT NULL DEFAULT 0,
  notified    INTEGER NOT NULL DEFAULT 0,
  detail_json TEXT,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- One connected Google account per person. Tokens live here rather than in a
-- session because the agent pushes events from cron runs, with nobody logged in.
CREATE TABLE IF NOT EXISTS google_account (
  salesman_id   INTEGER PRIMARY KEY REFERENCES salesman(id) ON DELETE CASCADE,
  google_email  TEXT,
  calendar_id   TEXT    NOT NULL DEFAULT 'primary',
  access_token  TEXT,
  refresh_token TEXT,
  expires_at    TEXT,
  scope         TEXT,
  last_error    TEXT,
  connected_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS setting (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
