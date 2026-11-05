const PDFDocument = require('pdfkit');

const User = require('../models/User');
const { money, fmtMoney } = require('../utils/finance');
const { appUrl } = require('../utils/origins');
const { sendMail } = require('./emailService');
const { renderEmail } = require('./emailTemplates');

const BRAND = {
  navy: '#081827',
  blue: '#42A5FF',
  lightBlue: '#EAF4FF',
  text: '#1E293B',
  muted: '#64748B',
  border: '#D9E2EC',
  white: '#FFFFFF',
  green: '#15803D',
  red: '#B43D3D'
};

// What each kind of ledger entry looks like on a receipt.
const KINDS = {
  funding: { credit: true, header: 'ACCOUNT FUNDING RECEIPT', title: 'Funds added successfully', lead: 'This receipt confirms that funds were credited to your Harborline account.', amountLabel: 'AMOUNT CREDITED', partyLabel: 'Funding source', party: () => 'Administrator' },
  transfer_in: { credit: true, header: 'TRANSFER RECEIPT', title: 'Transfer received', lead: 'This receipt confirms an incoming transfer to your Harborline account.', amountLabel: 'AMOUNT RECEIVED', partyLabel: 'Received from', party: entry => entry.counterparty || 'Harborline customer' },
  transfer_out: { credit: false, header: 'TRANSFER RECEIPT', title: 'Transfer sent', lead: 'This receipt confirms an outgoing transfer from your Harborline account.', amountLabel: 'AMOUNT SENT', partyLabel: 'Sent to', party: entry => entry.counterparty || 'Harborline customer' },
  goal_contribution: { credit: false, header: 'SAVINGS RECEIPT', title: 'Savings goal deposit', lead: 'This receipt confirms money moved from checking into a savings goal.', amountLabel: 'AMOUNT SAVED', partyLabel: 'Destination', party: () => 'Savings goal' },
  goal_withdrawal: { credit: true, header: 'SAVINGS RECEIPT', title: 'Savings goal withdrawal', lead: 'This receipt confirms money moved from a savings goal back to checking.', amountLabel: 'AMOUNT WITHDRAWN', partyLabel: 'Source', party: () => 'Savings goal' },
  card_purchase: { credit: false, header: 'CARD RECEIPT', title: 'Card purchase', lead: 'This receipt confirms a card purchase on your Harborline account.', amountLabel: 'AMOUNT CHARGED', partyLabel: 'Merchant', party: entry => entry.description || 'Card purchase' },
  card_payment: { credit: false, header: 'PAYMENT RECEIPT', title: 'Credit card payment', lead: 'This receipt confirms a payment made toward your Harborline credit card.', amountLabel: 'AMOUNT PAID', partyLabel: 'Paid to', party: () => 'Harborline credit card' }
};

// Wording of the alert email for each kind of entry. ctx: { amount, cp, desc, acct, mask }
const ALERTS = {
  funding: { title: 'Credit alert: funds added', subject: c => `Credit alert: ${c.amount} added to your Harborline account`, message: c => `${c.amount} was credited to your ${c.acct} account (${c.mask}).` },
  transfer_in: { title: 'Credit alert: money received', subject: c => `Credit alert: ${c.amount} received from ${c.cp}`, message: c => `${c.amount} was received from ${c.cp} in your ${c.acct} account (${c.mask}).` },
  transfer_out: { title: 'Debit alert: money sent', subject: c => `Debit alert: ${c.amount} sent to ${c.cp}`, message: c => `${c.amount} was sent to ${c.cp} from your ${c.acct} account (${c.mask}).` },
  card_purchase: { title: 'Debit alert: card purchase', subject: c => `Debit alert: ${c.amount} spent at ${c.desc}`, message: c => `${c.amount} was spent at ${c.desc} from your ${c.acct} account (${c.mask}).` },
  card_payment: { title: 'Debit alert: credit card payment', subject: c => `Debit alert: ${c.amount} paid to your credit card`, message: c => `${c.amount} was paid from your ${c.acct} account (${c.mask}) toward your credit card.` },
  goal_contribution: { title: 'Debit alert: moved to savings goal', subject: c => `Debit alert: ${c.amount} moved to a savings goal`, message: c => `${c.amount} was moved from your ${c.acct} account (${c.mask}) into a savings goal.` },
  goal_withdrawal: { title: 'Credit alert: moved from savings goal', subject: c => `Credit alert: ${c.amount} moved back to checking`, message: c => `${c.amount} was moved from a savings goal into your ${c.acct} account (${c.mask}).` }
};

// The built-in PDF fonts only cover Western characters; swap anything else for "?"
// so an unusual name can never break receipt generation.
function pdfSafe(value) {
  return String(value ?? '').replace(/[^\x20-\x7E -ÿ•–—‘’“”…]/g, '?');
}

function safeText(value, fallback = '-') {
  const text = pdfSafe(String(value ?? '').trim());
  return text || fallback;
}

function maskAccountNumber(accountNumber = '') {
  const value = String(accountNumber);
  return value ? `•••• ${value.slice(-4)}` : '••••';
}

function formatDate(date) {
  const value = date ? new Date(date) : new Date();
  // dateStyle/timeStyle cannot be combined with timeZoneName, so spell the parts out.
  return value.toLocaleString('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short' });
}

function formatMoney(amountCents, currency = 'USD') {
  return currency === 'USD' ? `$${fmtMoney(amountCents)}` : `${currency} ${money(amountCents)}`;
}

function shortReference(reference) {
  return String(reference || '').replace(/[^a-z0-9]/gi, '').slice(-8).toUpperCase() || 'RECEIPT';
}

/**
 * Generates a PDF receipt for any ledger entry and resolves with a Buffer.
 *
 *   customer: { name, email }
 *   account:  { accountNumber, accountType, nickname, currency }
 *   entry:    { kind, reference, createdAt, description, category, counterparty }
 *   amount:   cents (positive integer)
 *   balance:  balance after the transaction in cents (optional, e.g. credit card purchases have none)
 *   previousBalance: balance before the transaction in cents (optional)
 */
async function generateReceipt({ customer, account, entry, amount, balance, previousBalance, logoPath }) {
  if (!customer || !entry) throw new Error('Customer and transaction are required to generate a receipt.');
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('Receipt amount must be a positive integer in cents.');
  const hasBalance = Number.isSafeInteger(balance) && balance >= 0;
  const hasPrevious = Number.isSafeInteger(previousBalance) && previousBalance >= 0;

  const kind = KINDS[entry.kind] || KINDS.funding;
  const currency = safeText(account?.currency, 'USD');
  const reference = safeText(entry.reference);
  const description = safeText(entry.description, 'Transaction');

  const details = [
    ['Transaction reference', reference],
    ['Receipt number', shortReference(entry.reference)],
    ['Date and time (UTC)', formatDate(entry.createdAt)],
    [kind.partyLabel, safeText(kind.party(entry))],
    ['Description', description]
  ];
  if (entry.category && entry.kind !== 'funding') details.push(['Category', safeText(entry.category)]);

  const accountRows = [
    ['Account holder', safeText(customer.name)],
    ['Customer email', safeText(customer.email)]
  ];
  if (account) accountRows.push(['Account', `${safeText(account.nickname || account.accountType)} (${maskAccountNumber(account.accountNumber)})`]);
  if (hasPrevious) accountRows.push(['Previous balance', `${currency} ${fmtMoney(previousBalance)}`]);
  if (hasBalance) accountRows.push(['Balance after transaction', `${currency} ${fmtMoney(balance)}`]);

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margins: { top: 48, bottom: 48, left: 48, right: 48 },
        info: { Title: `Harborline ${kind.title}`, Author: 'Harborline', Subject: kind.header }
      });

      const chunks = [];
      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const pageWidth = doc.page.width;
      const left = doc.page.margins.left;
      const contentWidth = pageWidth - left - doc.page.margins.right;
      const right = left + contentWidth;

      // Header band
      doc.save().rect(0, 0, pageWidth, 118).fill(BRAND.navy).restore();
      if (logoPath) {
        try { doc.image(logoPath, left, 38, { fit: [44, 44] }); } catch { drawBrandMark(doc, left, 38); }
      } else {
        drawBrandMark(doc, left, 38);
      }
      doc.fillColor(BRAND.white).font('Helvetica-Bold').fontSize(23).text('harborline', left + 56, 43, { lineBreak: false });
      doc.fillColor('#B9D8F5').font('Helvetica').fontSize(9).text(kind.header, left + 56, 72, { lineBreak: false });
      doc.fillColor(BRAND.white).font('Helvetica-Bold').fontSize(10).text('COMPLETED', right - 95, 48, { width: 95, align: 'right', lineBreak: false });

      // Title
      doc.fillColor(BRAND.text).font('Helvetica-Bold').fontSize(20).text(kind.title, left, 145, { lineBreak: false });
      doc.fillColor(BRAND.muted).font('Helvetica').fontSize(10).text(kind.lead, left, 174, { width: contentWidth });

      // Amount panel
      const panelY = 210;
      doc.roundedRect(left, panelY, contentWidth, 92, 8).fill(BRAND.lightBlue);
      doc.fillColor(BRAND.muted).font('Helvetica').fontSize(9).text(kind.amountLabel, left + 18, panelY + 17, { lineBreak: false });
      doc.fillColor(kind.credit ? BRAND.green : BRAND.navy).font('Helvetica-Bold').fontSize(27)
        .text(`${kind.credit ? '+' : '-'}${currency} ${fmtMoney(amount)}`, left + 18, panelY + 36, { lineBreak: false });

      // Sections
      let y = 330;
      y = section(doc, 'Transaction details', details, left, y, contentWidth);
      y = section(doc, 'Account details', accountRows, left, y + 10, contentWidth);

      // Footer (margins.bottom is zeroed so pdfkit does not start a second page for it)
      doc.page.margins.bottom = 0;
      const footerY = doc.page.height - 75;
      doc.moveTo(left, footerY).lineTo(right, footerY).strokeColor(BRAND.border).lineWidth(1).stroke();
      doc.fillColor(BRAND.muted).font('Helvetica').fontSize(8).text(
        'This receipt is for your records. Harborline will never ask you to share your password, PIN, or one-time verification code.',
        left, footerY + 12, { width: contentWidth, align: 'center' }
      );
      doc.fillColor(BRAND.muted).fontSize(8).text(`Harborline • Receipt ${shortReference(entry.reference)}`, left, footerY + 36, { width: contentWidth, align: 'center', lineBreak: false });

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

/** Original funding-receipt signature, kept so older callers keep working. */
function generateFundingReceipt({ customer, account, ledgerEntry, amount, balance, previousBalance, logoPath }) {
  if (!ledgerEntry) return Promise.reject(new Error('Customer, account, and ledger entry are required to generate a receipt.'));
  return generateReceipt({
    customer, account, amount, balance, previousBalance, logoPath,
    entry: { kind: 'funding', reference: ledgerEntry.transferGroup, createdAt: ledgerEntry.createdAt, description: ledgerEntry.description }
  });
}

function drawBrandMark(doc, x, y) {
  doc.save().circle(x + 22, y + 22, 21).lineWidth(2).strokeColor(BRAND.blue).stroke();
  doc.moveTo(x + 22, y + 9).lineTo(x + 22, y + 35).moveTo(x + 9, y + 22).lineTo(x + 35, y + 22)
    .lineWidth(2).strokeColor(BRAND.blue).stroke();
  doc.restore();
}

function section(doc, heading, rows, x, y, width) {
  doc.fillColor(BRAND.text).font('Helvetica-Bold').fontSize(12).text(heading, x, y, { lineBreak: false });
  y += 24;
  for (const [label, value] of rows) y = drawDetail(doc, label, value, x, y, width);
  return y;
}

// Draws one label/value row whose height grows with long values; returns the next y.
function drawDetail(doc, label, value, x, y, width) {
  const labelWidth = width * 0.4;
  const valueWidth = width * 0.6;
  doc.font('Helvetica-Bold').fontSize(9);
  const valueHeight = Math.max(11, doc.heightOfString(safeText(value), { width: valueWidth }));
  doc.fillColor(BRAND.muted).font('Helvetica').fontSize(9).text(label, x, y, { width: labelWidth });
  doc.fillColor(BRAND.text).font('Helvetica-Bold').fontSize(9).text(safeText(value), x + labelWidth, y, { width: valueWidth, align: 'right' });
  const lineY = y + valueHeight + 9;
  doc.moveTo(x, lineY).lineTo(x + width, lineY).strokeColor(BRAND.border).lineWidth(0.5).stroke();
  return lineY + 9;
}

/**
 * Emails the customer a credit or debit alert for one ledger entry, with a PDF receipt attached
 * and a link that opens the receipt after sign-in. Respects the customer's alert preference.
 * Resolves with { skipped: true } for an unknown/opted-out customer; throws if the email cannot be sent.
 *
 *   userId, account, kind ('funding' | 'transfer_in' | 'transfer_out' | 'card_purchase' | ...)
 *   amountCents, balanceAfterCents, description, counterparty, category
 *   transactionId (ledger entry id, used for the receipt link), reference (transfer group), transactionDate
 */
async function sendTransactionReceipt({ userId, account, kind, amountCents, balanceAfterCents, description, counterparty, category, transactionId, reference, transactionDate }) {
  const customer = await User.findOne({ _id: userId, verified: true, transactionAlerts: true }).select('name email').lean();
  if (!customer) return { skipped: true };

  const config = KINDS[kind] || KINDS.funding;
  const alert = ALERTS[kind] || ALERTS.funding;
  const currency = account.currency || 'USD';
  const createdAt = transactionDate || new Date();
  const amountText = formatMoney(amountCents, currency);
  const accountLabel = account.nickname || account.accountType || 'account';
  const accountMasked = maskAccountNumber(account.accountNumber);
  const link = appUrl() && transactionId ? `${appUrl()}/#receipt=${transactionId}` : undefined;
  const firstName = String(customer.name || '').trim().split(/\s+/)[0] || 'there';
  const ctx = { amount: amountText, cp: counterparty || 'a Harborline customer', desc: description || 'a merchant', acct: accountLabel, mask: accountMasked };
  const message = alert.message(ctx);
  const subject = alert.subject(ctx).replace(/[\r\n]+/g, ' ').slice(0, 150);

  let attachments;
  try {
    const hasBalance = Number.isSafeInteger(balanceAfterCents);
    const pdf = await generateReceipt({
      customer, account, amount: amountCents, balance: hasBalance ? balanceAfterCents : undefined,
      previousBalance: hasBalance ? balanceAfterCents + (config.credit ? -amountCents : amountCents) : undefined,
      entry: { kind, reference: reference || transactionId, createdAt, description, category, counterparty }
    });
    attachments = [{ filename: `harborline-receipt-${shortReference(reference || transactionId)}.pdf`, content: pdf, contentType: 'application/pdf' }];
  } catch (error) {
    console.error('Receipt PDF could not be generated:', error.message);
  }

  const text = [
    `Hi ${firstName},`, '', alert.title, message,
    description ? `Description: ${description}` : '',
    Number.isSafeInteger(balanceAfterCents) ? `New balance: ${formatMoney(balanceAfterCents, currency)}` : '',
    `Reference: ${reference || transactionId || ''}`,
    link ? `\nView your receipt (PDF): ${link}` : '',
    attachments ? 'A PDF copy of your receipt is attached.' : '',
    '\nIf you do not recognize this activity, contact Harborline support.'
  ].filter(line => line !== '').join('\n');

  const html = renderEmail({
    preheader: message,
    title: alert.title,
    intro: `Hi ${firstName}, ${message}`,
    amount: `${config.credit ? '+' : '-'}${amountText}`,
    tone: config.credit ? 'credit' : 'debit',
    rows: [
      ['Description', description],
      [config.partyLabel, config.party({ counterparty, description })],
      ['Account', `${accountLabel} (${accountMasked})`],
      Number.isSafeInteger(balanceAfterCents) ? ['New balance', formatMoney(balanceAfterCents, currency)] : null,
      ['Date (UTC)', formatDate(createdAt)],
      ['Reference', reference || transactionId]
    ],
    ctaLabel: link ? 'View receipt (PDF)' : undefined,
    ctaUrl: link,
    note: attachments ? 'A PDF copy of your receipt is attached to this email.' : undefined
  });

  return sendMail({ to: customer.email, subject, text, html, attachments });
}

/** Funding alert sent by the administrator funding flow. */
function sendFundingReceipt({ user, account, amountCents, balanceAfterCents, description, transactionId, reference, transactionDate }) {
  return sendTransactionReceipt({ userId: user.id, account, kind: 'funding', amountCents, balanceAfterCents, description, transactionId, reference, transactionDate });
}

/** Loads a ledger entry by id and sends its alert. */
async function sendEntryAlert(entryId) {
  const LedgerEntry = require('../models/LedgerEntry');
  const Account = require('../models/Account');
  const entry = await LedgerEntry.findById(entryId).lean();
  if (!entry) return { skipped: true };
  const account = await Account.findById(entry.accountId).lean();
  if (!account) return { skipped: true };
  return sendTransactionReceipt({
    userId: account.userId, account, kind: entry.kind, amountCents: entry.amountCents, balanceAfterCents: entry.balanceAfterCents,
    description: entry.description, counterparty: entry.counterpartyName, category: entry.category,
    transactionId: String(entry._id), reference: entry.transferGroup, transactionDate: entry.createdAt
  });
}

/** Fire-and-forget version: never delays a response and never throws. */
function queueEntryAlert(entryId) {
  if (!entryId) return;
  sendEntryAlert(entryId).catch(error => console.error('Transaction alert email failed:', error.message));
}

module.exports = { generateReceipt, generateFundingReceipt, sendFundingReceipt, sendTransactionReceipt, sendEntryAlert, queueEntryAlert, formatMoney };
