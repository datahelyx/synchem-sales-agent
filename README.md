# AI Sales Manager Agent

An autonomous agent that runs an outbound sales pipeline end to end: it hands each
salesman companies to work every week, chases them for meetings and outcomes, turns
an approved outcome into an invoice, and reports the whole thing live.

Built standalone, structured so it can be folded into Odoo as a custom module later.

```bash
npm install
npm run dev
```

Then open **http://localhost:5310**. The API runs on 4310; the database is created
and seeded on first start. No accounts, no cloud services, no credentials required.

> ### ⚠️ These are real companies
>
> The imported list holds real businesses and real WhatsApp numbers. Booking a test
> meeting generates a genuine invite addressed to a real person.
>
> **Outbound delivery to company contacts is gated by `OUTBOUND_MODE`**, which
> ships as `off`. Blocked messages are written to the outbox marked *suppressed*
> so you can read exactly what would have gone out — and they can never be
> released later, because "Retry queued messages" skips suppressed rows by design.
> Adding WhatsApp or SMTP credentials alone does **not** turn delivery on.
>
> | mode | behaviour |
> |---|---|
> | `off` | nothing reaches a company; everything is held and readable |
> | `redirect` | **use this to test.** Messages really send, but each one is re-addressed to you with a banner naming the company it was meant for |
> | `allowlist` | only addresses in `OUTBOUND_ALLOWLIST` are reachable |
> | `live` | real customers are contacted |
>
> This checkout is configured for `redirect` → `you@example.com`. WhatsApp has a
> separate `OUTBOUND_REDIRECT_PHONE`, because an email inbox cannot receive a
> WhatsApp message; while it is unset, WhatsApp to companies is held rather than
> rerouted somewhere useless.
>
> `npm run test:guard` proves all of this (21 checks), including that a drain after
> credentials appear cannot release held messages.

To load the company list from the command line instead of the browser:

```bash
npm run import:csv -- "C:\path\to\SynChem_Companies_for_Odoo_v2.csv"
```

---

## What it does

| Step | Where it lives |
|---|---|
| Import companies from CSV | **Import data** page (upload) or `npm run import:csv` |
| Weekly assignment — 2 companies per salesman | Agent, Mondays 09:00, or **Agent → Assign this week's companies** |
| Notify the salesman | In-app inbox (bell) + WhatsApp when configured |
| Meeting scheduling, contact invited | **My week → Book a meeting** (Calendly link included in the invite) |
| Post-meeting feedback, samples, invoice | **My week → Log the outcome** |
| Dashboard | **Dashboard**, computed live on every request |

### The agent

Three scheduled jobs (Asia/Karachi), all also runnable by hand from the Agent page:

- **Mon 09:00** — assign each active salesman up to their weekly quota.
- **Every 15 minutes** — reminders, timed against each meeting rather than as a
  daily digest: one about a day ahead (salesman *and* the contact, so the visit can
  still be rearranged) and one about two hours ahead (salesman only — time to set
  off). Also chases meetings that have passed with no outcome logged. Offsets are
  `REMIND_DAY_BEFORE_HOURS` and `REMIND_HOURS_BEFORE`. Idempotent: each meeting is
  reminded once per window however often the sweep runs.
- **08:30 daily** — re-surface companies whose follow-up date has arrived.

Set `AGENT_CRON=off` to disable the schedule.

### Calendars

Three layers, strongest first — each one works without the ones below it:

1. **Google Calendar sync** (needs `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`).
   Each person connects their own account from **Calendar → Connect Google
   Calendar**. Meetings are then created on their real Google Calendar, moved when
   rescheduled and deleted when cancelled, with Google's own reminders on their
   phone. The slot picker also reads their real **free/busy**, so it knows about
   appointments this app has never heard of.
2. **`.ics` invites** — emailed automatically, understood by Google, Outlook and
   Apple Calendar. Carries its own 24h and 2h alarms.
3. **One-click "Add to Google Calendar"** on every row of the Calendar page. No
   setup whatsoever; works the moment the app runs.

The in-app nudges are a backstop for anyone using none of the above.

Tokens are stored per salesman (`google_account`), not in a session, because the
agent pushes events from cron runs when nobody is logged in. Google's `state`
parameter is HMAC-signed — otherwise anyone completing the callback could bind
their own Google account to another salesman's row. Attendees are deliberately
*not* added to Google events: Google would email them directly, which would bypass
the outbound guard and reach a real customer.

Who gets what:

| | Calendar entry | Alarms on it | In-app reminders |
|---|---|---|---|
| Salesman | yes | 24h + 2h before | yes |
| Company contact | yes | 24h + 2h before | day-before message |
| Sales manager | yes | **none** | **none** |

The manager sees every meeting — one notification when it is booked, titled
`Salesman × Company`, and the entry on their calendar — but is deliberately kept off
the reminder path. They oversee the pipeline; they are not the one who has to show up.

Rescheduling re-sends the same `UID` with a higher `SEQUENCE`, so calendars update
the existing entry rather than creating a duplicate, and the already-sent reminders
reset for the new time. Cancelling sends `METHOD:CANCEL`, which removes it.

> Seeded team emails are `@synchem.example`, which does not exist — invites to
> salesmen and managers will bounce. Put real addresses on the **Team** page before
> relying on them. Internal mail is *not* redirected by `OUTBOUND_MODE`; only
> messages to company contacts are.

### Meetings are mostly physical visits

Most meetings are in-person visits, so `onsite` is the default — a call or video
call is still selectable. The time is **agreed between the salesman and the
contact**, by phone or WhatsApp, then recorded in the app. The booking screen
therefore offers both a slot grid and a free date/time field: a slot the salesman
has already filled is marked but still selectable, because the agreed time wins over
the app's opinion of the diary. A checkbox records whether the time was actually
agreed or just pencilled in, and the company timeline says which.

### Changing how much work each person gets

**Team → the +/− stepper on each card.** That is `salesman.weekly_quota`, and it is
the number the Monday run tops each person up to. Raise it and re-run the agent from
the Agent page to hand out the extra companies immediately; lower it and the smaller
number applies from the next run, without removing work already assigned.

Assignment is ranked and **explainable** — every card shows why that company was
picked. Priority, highest first: follow-ups that are due → companies already yours
and mid-pipeline → target-industry leads with good contact data, never-assigned
first, with the salesman's preferred areas nudged up. Won, lost, do-not-contact and
already-in-play companies are excluded.

"Target industry" is editable in **Agent → Settings**. It matters: ranked on contact
data alone, the agent's first picks for a chemicals supplier were Allied Bank and
MCB Bank — tidy records, no use for solvents.

---

## What your data actually looked like

Profiled from `SynChem_Companies_for_Odoo_v2.csv` before anything was built. These
findings shaped the design, so they are worth knowing:

- **5,119 rows → 4,962 companies.** Exact-name matching finds zero duplicates, but
  154 companies appear twice under different spellings (`TECHNO FIRE (PVT.) LTD.`
  vs `Techno Fire`, `Nestlé Pakistan` vs `Nestle Pakistan Limited`). Import matches
  on a normalized key that strips punctuation, legal suffixes and accents, so
  re-uploading the file updates rather than duplicates.
- **The file is Windows-1252, not UTF-8.** Read as UTF-8 it throws, or silently
  turns `Nestlé` into `Nestl?`. The importer detects and decodes it.
- **Only 89 companies have a usable email — 1.8%.** Twenty of the "emails" in the
  file are phone numbers; those get recovered as phones. This is the single biggest
  design constraint: emailing company contacts is not a viable channel, WhatsApp is.
- **4,614 have a usable phone (93%); 331 have neither** and can never be worked —
  the agent skips them and the dashboard counts them under Imported data health.
- **179 phones are the placeholder `____-_______`**, treated as blank. A few were
  destroyed by Excel into scientific notation (`9.23018E+11`) and are flagged as
  unrecoverable.
- **93 duplicate rows carried a second phone number**, kept in the company's notes
  as `Alt phone:` rather than discarded.
- **`City` is a Lahore locality, not a city** (Gulberg 741, Multan Road 273,
  Raiwind 207), blank for ~2,400 — so it is stored as `area`.
- **`Notes` is structured**: only `Industry:` and `Primary contact:` ever appear.
  Both are parsed into real columns; 137 industry spellings normalize to ~25
  buckets. 3,153 companies have no industry at all.
- **Some industry labels are simply wrong in the source** — `Tariq Glass Industries`
  is filed under `Cotton`, along with 146 others. That is the CSV's error, faithfully
  preserved; fix them on the company page or in a corrected re-import.

---

## Decisions made, and why

You left three questions open and asked for judgment. Here is what was chosen and
where to change it.

**"Agent" is the automation, not a person.** Three roles: the **Agent** is the
system itself (assigns, notifies, chases — no login); the **Sales Manager** is a
human who oversees and can override anything; the **Salesman** works their
companies. This is the cleanest mapping onto Odoo, where the automation becomes
scheduled actions and the humans become `res.users`.

**Channels are pluggable, and nothing is configured by default.** Every outbound
message is written to an outbox table first, then a channel adapter tries to deliver
it. So the pipeline runs with zero credentials — messages sit in
**Agent → Message outbox** where you can read exactly what would have gone out.
Salesmen also always get an in-app notification, which needs nothing.

**Delivery to real companies is gated separately from credentials**
(`OUTBOUND_MODE`, see the warning at the top). Two things are deliberately true:
credentials alone never start delivery, and a message blocked at creation is stored
as *suppressed* rather than *queued*, so it is terminal — turning WhatsApp on months
later cannot flush a backlog of test invites at actual customers. `blockReason()` in
`server/services/notifier.ts` is the single choke point, re-checked on every send
attempt including retries.

### Making email actually arrive

The SMTP adapter is real (nodemailer), but stays inert until you add your own
credentials to `.env` — no password belongs in this repo, so add these yourself:

```
SMTP_HOST=smtp.office365.com
SMTP_PORT=587
SMTP_USER=you@example.com
SMTP_PASS=<an app password, not your normal login password>
SMTP_FROM=you@example.com
```

Most university and Gmail accounts require an **app password** generated in your
account's security settings; a normal password will be rejected. The app password
must belong to the account in `SMTP_USER` — one generated on a different Gmail is
rejected with `535 BadCredentials`. `SMTP_USER` and `SMTP_FROM` must be the same
mailbox; the recipient (`OUTBOUND_REDIRECT_TO`) can be any other account.

Until all three of `SMTP_HOST`/`SMTP_USER`/`SMTP_PASS` are present, invites sit in
the outbox as *queued* — already re-addressed to you, so switching SMTP on sends
them to your inbox and nowhere else. `npm run test:email` checks the login and
sends one message to `OUTBOUND_REDIRECT_TO`; it refuses to send anywhere else.

> **`.env` is read once, at startup.** After editing it, restart `npm run dev` —
> otherwise the server keeps running on the old values while the CLI scripts, which
> are fresh processes, use the new ones. The Agent page always shows the mode the
> *server* is actually using, so check there if the two seem to disagree.

**Inventory is modelled fresh** with a seeded placeholder catalogue of 20
specialty-chemical SKUs. Replace them in **Products & orders → Add product**, or
edit `server/scripts/seed-data.ts`. Stock is derived from an append-only
`stock_move` ledger, so editing a sample request cannot double-count stock.

**No authentication.** You pick who you are from the avatar menu and the app
remembers it. Real auth is a wrapper around one React context (`src/session.tsx`) —
and in Odoo `res.users` replaces it entirely, so building a login now is work that
gets deleted. **This means anyone who can reach the app can act as anyone.** Do not
expose it beyond your network as-is.

**Nothing is locked after first entry.** Re-opening a logged meeting loads the saved
answers back into the same form. Editing an approved deal updates its invoice
in place; flipping it away from Approved *cancels* the invoice rather than deleting
it. Every edit writes a `revision` row.

---

## Folding this into Odoo

The schema deliberately shadows Odoo's models, so the port is a mapping job:

| Here | Odoo |
|---|---|
| `company` | `res.partner` (`is_company = true`) |
| `salesman` | `res.users` / `hr.employee` |
| `assignment` | `crm.lead` |
| `meeting` | `calendar.event` |
| `product` | `product.product` |
| `sample_request` / `sample_line` | `stock.picking` / `stock.move` |
| `invoice` / `invoice_line` | `account.move` / `account.move.line` |
| `activity` | `mail.message` |
| `notification` | the outbound mail/message queue |
| the three cron jobs | `ir.cron` scheduled actions |

Two seams exist specifically for this. `server/services/scheduling.ts` has a
`SchedulingProvider` interface with `manual`, `calendly` and a stubbed `odoo`
implementation — swapping providers changes no UI. `server/services/notifier.ts`
does the same for channels.

---

## Layout

```
server/
  db/schema.sql        every table, commented with its Odoo counterpart
  agent/assignment.ts  the weekly run, reminder sweep, follow-up sweep
  services/            importer, notifier, scheduling, commerce, pipeline
  routes/              companies, work (assignments/meetings/feedback),
                       catalog, people, dashboard, agent
  scripts/             import-csv, reset, check, smoke
src/
  pages/MyWeek.tsx     the screen salesmen live in
  pages/Dashboard.tsx  live metrics and charts
  pages/…              companies, meetings, catalog, team, agent, import
```

### Scripts

| Command | What it does |
|---|---|
| `npm run dev` | API + web together |
| `npm run import:csv -- "<file>"` | Import companies (add `--dry-run` to preview) |
| `npm run db:reset` | Delete the database; next start rebuilds and re-seeds (stop the dev server first) |
| `npm run test:guard` | Prove no real company contact can be messaged in the current mode |
| `npm run check:data` | Data sanity report after an import |
| `npx tsx server/scripts/smoke.ts` | Exercise the whole pipeline; also handy for generating demo data to look at the dashboard |

Charts use a colour-vision-validated palette (blue / aqua / orange). Green-and-red
was rejected deliberately: won-vs-lost is exactly the comparison a red-green
colourblind reader must not lose.
