const { escapeHtml } = require('../utils/identity');

const COLORS = { navy: '#081827', blue: '#0875d1', ink: '#142b40', muted: '#66788a', line: '#dce5ec', bg: '#f3f6f8', green: '#13865c', red: '#b43d3d' };

/**
 * Branded, mobile-friendly HTML email. Every dynamic value is escaped here,
 * so callers can pass plain text.
 *
 *   title, intro      headline and a short message
 *   amount            optional big figure (e.g. "+$250.00"), tone "credit" | "debit" | "neutral"
 *   rows              [[label, value], ...] detail table
 *   ctaLabel/ctaUrl   optional button
 *   code              optional one-time code shown in a box
 *   note              small print under the card
 */
function renderEmail({ preheader = '', title, intro = '', amount, tone = 'neutral', rows = [], ctaLabel, ctaUrl, code, note }) {
  const amountColor = tone === 'credit' ? COLORS.green : tone === 'debit' ? COLORS.red : COLORS.navy;
  const detailRows = rows.filter(row => row && row[1] !== undefined && row[1] !== '').map(([label, value]) => `
    <tr>
      <td style="padding:11px 0;border-bottom:1px solid ${COLORS.line};color:${COLORS.muted};font-size:13px;">${escapeHtml(label)}</td>
      <td style="padding:11px 0;border-bottom:1px solid ${COLORS.line};color:${COLORS.ink};font-size:13px;font-weight:600;text-align:right;">${escapeHtml(value)}</td>
    </tr>`).join('');

  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background:${COLORS.bg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<span style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader || intro)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COLORS.bg};padding:24px 12px;"><tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid ${COLORS.line};">
    <tr><td style="background:${COLORS.navy};padding:22px 28px;">
      <span style="color:#ffffff;font-size:22px;font-weight:700;letter-spacing:.3px;">harborline</span>
    </td></tr>
    <tr><td style="padding:28px;">
      <h1 style="margin:0 0 10px;font-size:20px;color:${COLORS.ink};">${escapeHtml(title)}</h1>
      <p style="margin:0 0 18px;font-size:14px;line-height:1.6;color:${COLORS.ink};">${escapeHtml(intro)}</p>
      ${amount ? `<div style="margin:0 0 18px;padding:18px;background:#eaf4ff;border-radius:10px;"><div style="font-size:11px;letter-spacing:1px;color:${COLORS.muted};text-transform:uppercase;">Amount</div><div style="font-size:30px;font-weight:700;color:${amountColor};margin-top:4px;">${escapeHtml(amount)}</div></div>` : ''}
      ${code ? `<div style="margin:0 0 18px;padding:18px;background:#eaf4ff;border-radius:10px;text-align:center;font-size:32px;font-weight:700;letter-spacing:8px;color:${COLORS.navy};">${escapeHtml(code)}</div>` : ''}
      ${detailRows ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 22px;">${detailRows}</table>` : ''}
      ${ctaUrl ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 6px;"><tr><td style="background:${COLORS.blue};border-radius:8px;"><a href="${escapeHtml(ctaUrl)}" style="display:inline-block;padding:13px 22px;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;">${escapeHtml(ctaLabel || 'Open Harborline')}</a></td></tr></table>` : ''}
    </td></tr>
    <tr><td style="padding:18px 28px;background:#f8fafb;border-top:1px solid ${COLORS.line};font-size:12px;line-height:1.6;color:${COLORS.muted};">
      ${note ? `${escapeHtml(note)}<br>` : ''}Harborline will never ask for your password, PIN, or verification code. If you do not recognize this activity, contact Harborline support.
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
}

module.exports = { renderEmail };
