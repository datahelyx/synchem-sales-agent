import { AlertTriangle, CalendarCheck, Info, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { api, type AssignmentRow, type SlotDay } from '../lib/api';
import { contactLabel } from '../lib/format';
import { ChoiceGroup, Field, Loading, Modal, Spinner, useApi, useToast } from '../ui';

/**
 * Records a meeting whose time the salesman and the contact agreed between
 * themselves. Two ways in, because both happen: pick a standard slot, or type
 * whatever time they actually settled on. A slot the salesman has already
 * filled is marked but still selectable — the agreed time wins over the app's
 * opinion of the diary.
 *
 * Saving sends calendar invites (.ics), which is what puts the meeting on
 * everyone's real calendar with their own reminders.
 *
 * The provider (manual today, Calendly or Odoo later) is chosen server-side,
 * so this component does not change when that swaps.
 */
export function ScheduleMeeting({
  open, onClose, onDone, company, salesmanId,
}: {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
  company: Pick<AssignmentRow, 'company_id' | 'company_name' | 'area' | 'contact_name' | 'contact_title' | 'phone_e164' | 'email'> & { assignment_id?: number | null };
  salesmanId: number;
}) {
  const toast = useToast();
  const { data, loading } = useApi<{
    provider: string; timezone: string; durationMin: number; days: SlotDay[];
    outboundMode: 'off' | 'redirect' | 'allowlist' | 'live';
    redirectTo: string | null;
  }>(open ? `/meetings/slots?salesmanId=${salesmanId}` : null);

  // The salesman and the contact agree a time between themselves, so this is a
  // free date + time entry. The suggestions below are only a shortcut for the
  // common case — they never constrain what can be entered.
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [mode, setMode] = useState<'onsite' | 'call' | 'video'>('onsite');
  const [location, setLocation] = useState('');
  const [duration, setDuration] = useState(30);
  const [notifyContact, setNotifyContact] = useState(true);
  const [agreed, setAgreed] = useState(false);
  const [saving, setSaving] = useState(false);

  const slot = date && time ? `${date}T${time}:00+05:00` : null;
  const activeDay = data?.days.find((d) => d.date === date);

  // The slot feed still knows what the salesman already has booked, so a free
  // time entry can warn about a clash without forbidding it.
  const clash = Boolean(
    slot &&
      data?.days
        .flatMap((d) => d.slots)
        .some((s) => !s.free && Math.abs(new Date(s.iso).getTime() - new Date(slot).getTime()) < 45 * 60_000),
  );
  const canReachContact = Boolean(company.phone_e164 || company.email);
  const live = data?.outboundMode === 'live';
  const redirected = data?.outboundMode === 'redirect' && Boolean(data.redirectTo);

  async function submit() {
    if (!slot) return;
    setSaving(true);
    try {
      await api.post('/meetings', {
        assignmentId: company.assignment_id ?? null,
        companyId: company.company_id,
        salesmanId,
        scheduledAt: slot,
        durationMin: duration,
        mode,
        location: location || company.area || null,
        notifyContact: notifyContact && canReachContact,
        agreedWithContact: agreed,
      });
      toast(`Visit booked with ${company.company_name}`);
      onDone();
      onClose();
      setDate(''); setTime(''); setAgreed(false); setMode('onsite');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not book the meeting', 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title={`Book a visit — ${company.company_name}`}
      subtitle={contactLabel(company.contact_title, company.contact_name)}
      footer={
        <div className="flex items-center justify-between gap-3">
          <p className="hidden text-xs text-slate-500 sm:block">
            {slot
              ? new Date(slot).toLocaleString('en-PK', { weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' })
              : 'Enter the date and time you agreed'}
          </p>
          <div className="flex w-full gap-2 sm:w-auto">
            <button className="btn-ghost flex-1 sm:flex-none" onClick={onClose}>Cancel</button>
            <button className="btn-primary flex-1 sm:flex-none" disabled={!slot || saving} onClick={submit}>
              {saving ? <Spinner /> : <CalendarCheck size={16} />}
              Save visit
            </button>
          </div>
        </div>
      }
    >
      {loading || !data ? (
        <Loading label="Loading" />
      ) : (
        <div className="space-y-5">
          <p className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
            Agree a time with {company.contact_name ?? 'the contact'} first — on the phone or over WhatsApp — then
            record it here. Saving sends calendar invites to you and to them.
          </p>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Date">
              <input
                type="date"
                className="input"
                value={date}
                min={new Date().toISOString().slice(0, 10)}
                onChange={(e) => setDate(e.target.value)}
              />
            </Field>
            <Field label={`Time (${data.timezone})`}>
              <input type="time" className="input" value={time} onChange={(e) => setTime(e.target.value)} />
            </Field>
          </div>

          {/* Slot grid for the agreed time. Free entry above stays available for
              anything that does not land on a standard slot. */}
          <div>
            <p className="label">Or pick a slot</p>
            <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
              {(data.days ?? []).map((d) => (
                <button
                  key={d.date}
                  type="button"
                  onClick={() => setDate(d.date)}
                  className={`shrink-0 rounded-xl border px-3.5 py-2 text-sm transition ${
                    date === d.date ? 'border-brand-500 bg-brand-50 font-semibold text-brand-800' : 'border-slate-200 bg-white hover:bg-slate-50'
                  }`}
                >
                  {d.label}
                </button>
              ))}
            </div>
            {activeDay && (
              <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-6">
                {activeDay.slots.map((s) => {
                  const hhmm = new Date(s.iso).toTimeString().slice(0, 5);
                  return (
                    <button
                      key={s.iso}
                      type="button"
                      onClick={() => setTime(hhmm)}
                      className={`rounded-lg border py-2 text-sm transition ${
                        time === hhmm
                          ? 'border-brand-500 bg-brand-600 font-semibold text-white'
                          : s.free
                            ? 'border-slate-200 bg-white hover:bg-slate-50'
                            : 'border-amber-200 bg-amber-50 text-amber-700'
                      }`}
                      title={s.free ? undefined : 'You already have something booked then'}
                    >
                      {s.label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <Field label="Meeting type" hint="Most are in-person visits.">
            <ChoiceGroup
              value={mode}
              onChange={setMode}
              options={[
                { value: 'onsite', label: 'Visit', hint: 'At their premises' },
                { value: 'call', label: 'Phone call', hint: 'Quick discussion' },
                { value: 'video', label: 'Video call', hint: 'Zoom / Meet' },
              ]}
            />
          </Field>

          {clash && (
            <p className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              You already have a visit booked around this time. You can still save it if that is intended.
            </p>
          )}

          <label className="flex items-start gap-3 rounded-xl border border-slate-200 p-3">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
            />
            <span className="text-sm">
              <span className="font-medium text-slate-800">This time is agreed with the contact</span>
              <span className="mt-0.5 block text-xs text-slate-500">
                Leave unticked if you are pencilling it in — the timeline records which it was.
              </span>
            </span>
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Visit address" hint="Defaults to the company's area">
              <input className="input" value={location} onChange={(e) => setLocation(e.target.value)} placeholder={company.area ?? 'Location'} />
            </Field>
            <Field label="How long">
              <select className="input" value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
                {[15, 30, 45, 60, 90].map((m) => (
                  <option key={m} value={m}>{m} minutes</option>
                ))}
              </select>
            </Field>
          </div>

          <label
            className={`flex items-start gap-3 rounded-xl border p-3 ${
              canReachContact ? 'border-slate-200 bg-white' : 'border-amber-200 bg-amber-50'
            }`}
          >
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
              checked={notifyContact && canReachContact}
              disabled={!canReachContact}
              onChange={(e) => setNotifyContact(e.target.checked)}
            />
            <span className="text-sm">
              <span className="font-medium text-slate-800">Send the contact a confirmation</span>
              <span className="mt-0.5 block text-xs text-slate-500">
                {!canReachContact
                  ? 'This company has no phone or email on file, so nobody can be notified. Add one on the company page.'
                  : live
                    ? `Goes out on WhatsApp${company.email ? ' and email' : ''} to ${company.phone_e164 ?? company.email}.`
                    : redirected
                      ? `Addressed to ${company.phone_e164 ?? company.email}, but delivered to ${data.redirectTo} instead.`
                      : `Will be written to the outbox for ${company.phone_e164 ?? company.email} but NOT delivered.`}
              </span>
            </span>
          </label>

          {/*
            These are real companies. Say plainly whether a real person is about
            to be messaged, rather than leaving it to whoever set the env vars.
          */}
          {canReachContact && (
            live ? (
              <p className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <span>
                  <strong>Live mode.</strong> Confirming this really does message{' '}
                  {contactLabel(company.contact_title, company.contact_name)} at {company.company_name}. Switch
                  <code className="mx-1 rounded bg-amber-100 px-1">OUTBOUND_MODE</code>to <code>off</code> while testing.
                </span>
              </p>
            ) : (
              <p className="flex items-start gap-2 rounded-lg bg-slate-50 p-3 text-xs text-slate-500">
                <ShieldCheck size={14} className="mt-0.5 shrink-0 text-emerald-600" />
                <span>
                  <strong className="text-slate-700">Safe to test.</strong>{' '}
                  {redirected ? (
                    <>
                      The confirmation is really sent, but re-addressed to{' '}
                      <code className="rounded bg-slate-200 px-1">{data.redirectTo}</code> — {company.company_name} will
                      not receive anything.
                    </>
                  ) : (
                    <>
                      Outbound delivery to company contacts is{' '}
                      <code className="rounded bg-slate-200 px-1">{data.outboundMode}</code> — the message is saved to
                      the outbox so you can read it, but no real customer is contacted.
                    </>
                  )}
                </span>
              </p>
            )
          )}

          {data.provider === 'manual' && (
            <p className="flex items-start gap-2 rounded-lg bg-slate-50 p-3 text-xs text-slate-500">
              <Info size={14} className="mt-0.5 shrink-0" />
              Using the built-in scheduler. Add a Calendly link in Agent → Settings to book through Calendly instead;
              the same screen will keep working.
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}
