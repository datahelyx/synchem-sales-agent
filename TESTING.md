# Testing the system from the front end

A walk-through that touches every part of the pipeline. Each step says what to do
and **what you should see** — if you see something else, that is the bug.

Roughly 30–40 minutes end to end.

---

## Before you start

**Server running?**

```bash
npm run dev
```

Open **http://localhost:5310**. Switch role with the avatar, top right.

**Want a clean slate?** Optional, but it makes counts easy to check. Stop the
server first (`Ctrl+C`) or the delete silently fails:

```bash
npm run db:reset
```

```bash
npm run import:csv -- "C:\Users\laiba\Desktop\SynChem_Companies_for_Odoo_v2.csv"
```

Then `npm run dev` again.

**Where test emails land:** everything aimed at a company is redirected to
`you@example.com`. Keep that inbox open in a tab — several steps check it.

---

## Part A — Manager: data and the agent

Switch to **Sales Manager**.

### A1. The import is intact
Go to **Companies**.

- [ ] Header says **4,962 matching**
- [ ] Search `Nestle` → **Nestlé Pakistan** appears with the accent intact
  *(if it shows `Nestl?` the encoding handling broke)*
- [ ] Filters → **Cannot be contacted** → about **331** companies
- [ ] Click any company → its page opens with contact, stage and an empty timeline

### A2. Upload the CSV through the browser
Go to **Import data**, drag the same CSV onto the drop zone.

- [ ] A **preview** appears first — nothing saved yet
- [ ] Encoding reads **windows-1252**
- [ ] "Will be added" is **0**, "will be updated" is ~4,962
      *(proves re-importing does not duplicate)*
- [ ] Warnings list shows rows with unusable phones
- [ ] Press **Cancel** — nothing should change

### A3. The agent hands out work
Go to **Agent**.

- [ ] Green banner: **"Safe to test… redirect"** with your email
- [ ] "Companies available" is in the thousands
- [ ] Press **Assign this week's companies**
- [ ] The per-salesman table fills to each person's quota

### A4. The manager can change how much work each person gets
Go to **Team**.

- [ ] Use **+ / −** on Ahmed's card — the number moves
- [ ] A toast confirms the new quota
- [ ] Back on **Agent** → **Assign this week's companies** → he gets topped up to the
      new number, and no further

---

## Part B — Salesman: the daily loop

Switch to **Ahmed Raza**.

### B1. My week
- [ ] Cards appear, one per assigned company
- [ ] Each says **"Why you got this"** with a real reason
- [ ] Progress bar shows `0 of N wrapped up`
- [ ] Coloured strip down the left of each card

### B2. Reaching the company
- [ ] **WhatsApp** button opens WhatsApp with a message already written
- [ ] The stage badge changes to **Contacted**

### B3. Book a visit
Press **Book a meeting** on any card.

- [ ] Notice says the confirmation goes to **your** address, not the company's
- [ ] Pick a date and time — either type them, or use the slot grid
- [ ] A slot you already filled shows **amber** but is still clickable
- [ ] Tick **"This time is agreed with the contact"**
- [ ] **Save visit**

Then check:
- [ ] The card now shows the date and **Log the outcome**
- [ ] Stage is **Meeting booked**
- [ ] **An email arrives in your inbox** with subject `[TEST] Meeting confirmation…`
      and a banner naming the company it was really for
- [ ] That email has a calendar attachment you can add
- [ ] **Company timeline** (company page) says *"time agreed with the contact"*

### B4. Google Calendar
Go to **Calendar** → **Connect Google Calendar** (once per person).

- [ ] Google asks for permission → Allow
- [ ] Back in the app, green banner says how many meetings were pushed
- [ ] **Open Google Calendar** — the meeting is there, with the right time and place
- [ ] Book another meeting → it appears on Google within seconds
- [ ] Change that meeting's time (**Meetings** page) → the Google entry **moves**,
      it does not duplicate
- [ ] Cancel it → the Google entry **disappears**

If Google is not connected, use the **Google** button on the Calendar page instead —
one click, no setup.

---

## Part C — Outcomes, samples and money

### C1. A rejected meeting
On a booked company, press **Log the outcome**.

- [ ] Only question 1 shows until you answer it
- [ ] Choose **Rejected** → reasons appear, and they are *rejection* reasons only
- [ ] Pick **Our price is too high** → Save

Check:
- [ ] Stage is **Lost**
- [ ] Card now offers **Edit outcome**

### C2. An approved deal with a sample
On another company: book a meeting, then log the outcome.

- [ ] Choose **Approved** → a **Deal value** box appears
- [ ] Enter `500000`
- [ ] **Yes — pick products** → search the catalogue → pick one
- [ ] Save

Check:
- [ ] Stage is **Won**
- [ ] **Products & orders → Invoices**: a new invoice for **Rs 500,000**
- [ ] **Products & orders → Samples**: the request, with your product
- [ ] **Products**: that product's stock has dropped

### C3. Nothing is locked
Open the same outcome again with **Edit outcome**.

- [ ] Every answer you gave is still filled in
- [ ] Change **Approved** → **Rejected** → Save
- [ ] Invoices: it is now **cancelled**, *not deleted*, and there is still only one
- [ ] Change it back to **Approved** → same invoice number returns, no duplicate
- [ ] Product stock has **not** double-counted

*This is the most important test in the file — it is where a system like this
usually goes wrong.*

---

## Part D — Manager: oversight

Switch to **Sales Manager**.

### D1. Notifications, no reminders
- [ ] Bell icon shows unread
- [ ] Open it → **"Meeting booked — Ahmed Raza × <Company>"**
- [ ] You get told when a meeting is booked or cancelled — but **never** a reminder
      before one. Those go to the salesman only.

### D2. Calendar
Go to **Calendar**, untick **Only mine**.

- [ ] Month grid shows the whole team
- [ ] Entries read **Salesman × Company**
- [ ] Today's date is circled
- [ ] The list below is in time order, each with **Google** and **.ics** buttons

### D3. Dashboard
- [ ] Tiles: assigned this week, meetings, deals won, invoiced
- [ ] **Meeting outcomes** matches what you logged
- [ ] **Why deals are lost** shows *Our price is too high*
- [ ] **Where companies are sitting** — the pipeline
- [ ] **Team** table, one row per salesman
- [ ] Switch **30 days / 90 days / 1 year** → numbers change
- [ ] **Imported data health** at the bottom

---

## Part E — The safety checks

These matter more than the features. Run them.

### E1. No real company can be messaged
Go to **Agent → Message outbox**.

- [ ] Every row addressed to a company shows **held — not sent** or was delivered to
      **your** address — never to the company's own
- [ ] Press **Retry queued messages** → nothing held is released

Or from a terminal:

```bash
npm run test:guard
```

- [ ] **21 checks, all pass**

### E2. Nobody was actually contacted
```bash
npm run check:data
```

- [ ] Numbers match what Companies showed

---

## What "broken" looks like

| Symptom | What it means |
|---|---|
| `Nestl?` instead of `Nestlé` | Import encoding regressed |
| Import says "will be added: 4,962" on a re-upload | Dedupe key broke — you will get duplicates |
| Two invoices for one deal | Invoice sync lost its idempotency |
| Stock drops twice after editing a sample | Stock movements are not being reversed |
| An email addressed to a company's own address | **Stop.** The outbound guard has failed |
| Manager gets a meeting reminder | Reminder targeting regressed |
| Google entry duplicates after a reschedule | The event id or SEQUENCE handling broke |

---

## Known, deliberate limitations

- **No login.** You pick who you are. Anyone reaching the app can act as anyone —
  do not expose it beyond your machine as it stands.
- **Team emails are `@synchem.example`** and will bounce. Put real ones on the Team
  page before testing invites to salesmen.
- **Products are placeholders** — 20 invented chemical SKUs until the real SynChem
  catalogue arrives.
- **WhatsApp is never delivered** — no token configured, and no
  `OUTBOUND_REDIRECT_PHONE`, so those messages are held by design.
