/**
 * HTML email, in SynChem's colours.
 *
 * Written for email clients, not browsers: tables for layout, inline styles
 * only, no flexbox or grid, no external CSS or webfonts. Outlook in particular
 * ignores most of what a normal page relies on.
 *
 * Every message also carries the plain-text body, so a client that refuses
 * HTML still shows something readable.
 */

const NAVY = '#172554';
const RED = '#d51b29';
const CYAN = '#0083b8';
const INK = '#1e2a3a';
const MUTED = '#6b7789';
const LINE = '#e3e7ef';
const PAGE = '#f4f6fa';

export interface DetailRow {
  label: string;
  value: string;
  /** Renders the value in the brand navy, bolder — for the one thing that matters. */
  strong?: boolean;
}

export interface EmailBlocks {
  /** Short line under the logo, e.g. "Meeting confirmation". */
  kicker: string;
  heading: string;
  intro?: string;
  details?: DetailRow[];
  /** Paragraphs after the detail table. */
  paragraphs?: string[];
  cta?: { label: string; url: string };
  /** Amber strip at the very top — used for the test-redirect notice. */
  banner?: string;
  footnote?: string;
}

function esc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderEmail(b: EmailBlocks): string {
  const detailRows = (b.details ?? [])
    .map(
      (d, i) => `
      <tr>
        <td style="padding:${i === 0 ? '0' : '10px'} 16px 0 0;vertical-align:top;white-space:nowrap;
                   font:400 13px/1.5 Arial,Helvetica,sans-serif;color:${MUTED};">${esc(d.label)}</td>
        <td style="padding:${i === 0 ? '0' : '10px'} 0 0 0;vertical-align:top;
                   font:${d.strong ? '700' : '400'} ${d.strong ? '15px' : '14px'}/1.5 Arial,Helvetica,sans-serif;
                   color:${d.strong ? NAVY : INK};">${esc(d.value)}</td>
      </tr>`,
    )
    .join('');

  const paragraphs = (b.paragraphs ?? [])
    .map(
      (p) =>
        `<p style="margin:0 0 14px;font:400 15px/1.65 Arial,Helvetica,sans-serif;color:${INK};">${esc(p)}</p>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<title>${esc(b.heading)}</title></head>
<body style="margin:0;padding:0;background:${PAGE};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAGE};">
<tr><td align="center" style="padding:24px 12px;">

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
         style="max-width:560px;background:#ffffff;border:1px solid ${LINE};border-radius:6px;overflow:hidden;">

    ${
      b.banner
        ? `<tr><td style="background:#fff7ed;border-bottom:1px solid #fed7aa;padding:12px 24px;
             font:700 12px/1.5 Arial,Helvetica,sans-serif;color:#9a3412;">${esc(b.banner)}</td></tr>`
        : ''
    }

    <!-- brand bar: navy with the red accent from the SynChem mark -->
    <tr><td style="background:${NAVY};padding:20px 24px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        <td style="padding-right:10px;">
          <div style="width:8px;height:26px;background:${RED};border-radius:2px;font-size:0;">&nbsp;</div>
        </td>
        <td>
          <div style="font:700 17px/1.2 Arial,Helvetica,sans-serif;color:#ffffff;letter-spacing:.2px;">SynChem Global</div>
          <div style="font:400 11px/1.4 Arial,Helvetica,sans-serif;color:#8aa3d6;letter-spacing:1.2px;
                      text-transform:uppercase;padding-top:3px;">${esc(b.kicker)}</div>
        </td>
      </tr></table>
    </td></tr>

    <tr><td style="padding:28px 24px 8px;">
      <h1 style="margin:0 0 14px;font:700 21px/1.3 Arial,Helvetica,sans-serif;color:${NAVY};">${esc(b.heading)}</h1>
      ${b.intro ? `<p style="margin:0 0 18px;font:400 15px/1.65 Arial,Helvetica,sans-serif;color:${INK};">${esc(b.intro)}</p>` : ''}
    </td></tr>

    ${
      detailRows
        ? `<tr><td style="padding:0 24px;">
             <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
                    style="background:#f7f9fc;border:1px solid ${LINE};border-left:3px solid ${CYAN};
                           border-radius:4px;padding:16px 18px;">
               <tr><td>
                 <table role="presentation" cellpadding="0" cellspacing="0" border="0">${detailRows}</table>
               </td></tr>
             </table>
           </td></tr>`
        : ''
    }

    ${paragraphs ? `<tr><td style="padding:20px 24px 0;">${paragraphs}</td></tr>` : ''}

    ${
      b.cta
        ? `<tr><td style="padding:6px 24px 4px;">
             <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
               <td style="background:${NAVY};border-radius:4px;">
                 <a href="${esc(b.cta.url)}"
                    style="display:inline-block;padding:11px 22px;font:700 14px/1 Arial,Helvetica,sans-serif;
                           color:#ffffff;text-decoration:none;">${esc(b.cta.label)}</a>
               </td>
             </tr></table>
           </td></tr>`
        : ''
    }

    <tr><td style="padding:24px;">
      <div style="border-top:1px solid ${LINE};padding-top:14px;
                  font:400 12px/1.6 Arial,Helvetica,sans-serif;color:${MUTED};">
        ${b.footnote ? esc(b.footnote) + '<br>' : ''}
        Sent by the SynChem Global sales system.
      </div>
    </td></tr>

  </table>
</td></tr></table>
</body></html>`;
}
