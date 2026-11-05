const InternationalTransfer = require('../models/InternationalTransfer');
const { fmtMoney } = require('../utils/finance');

const SWIFT = /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/;
const PURPOSES = ['Family support', 'Education & tuition', 'Rent & housing', 'Business payment', 'Medical expenses', 'Gift', 'Travel', 'Savings & investment', 'Other'];
const BLOCKED = new Set(String(process.env.INTL_BLOCKED_COUNTRIES || 'KP,IR,SY,CU').split(',').map(v => v.trim().toUpperCase()).filter(Boolean));
const MIN_CENTS = 1000;                       // $10
const MAX_CENTS = 10000000;                   // $100,000 per transfer
const DAILY_LIMIT_CENTS = Math.max(MIN_CENTS, Math.round((Number(process.env.INTL_DAILY_LIMIT) || 25000) * 100));

function ibanValid(value) {
  const iban = String(value).replace(/\s/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) remainder = (remainder * (/\d/.test(ch) ? 10 : 100) + (/\d/.test(ch) ? Number(ch) : ch.charCodeAt(0) - 55)) % 97;
  return remainder === 1;
}

/** Returns a cleaned account/IBAN string or throws a 400. */
function cleanDestinationAccount(raw) {
  const value = String(raw || '').replace(/[\s-]/g, '').toUpperCase();
  if (/^[A-Z]{2}\d{2}/.test(value)) {
    if (!ibanValid(value)) throw Object.assign(new Error('That IBAN does not look right. Check it and try again.'), { status: 400, expose: true });
    return value;
  }
  if (!/^[A-Z0-9]{6,34}$/.test(value)) throw Object.assign(new Error('Enter the recipient IBAN or account number (6 to 34 letters and digits).'), { status: 400, expose: true });
  return value;
}

const maskDestination = value => value ? `${'•'.repeat(4)} ${String(value).slice(-4)}` : '';

function present(item, { admin = false } = {}) {
  return {
    id: String(item._id), reference: item.reference, status: item.status,
    amount: (item.amountCents / 100).toFixed(2), fee: (item.feeCents / 100).toFixed(2), total: (item.totalCents / 100).toFixed(2),
    currency: item.currency, rate: item.rate, rateSource: item.rateSource, receiveAmount: item.receiveAmount,
    recipientName: item.recipientName, country: item.recipientCountry, bankName: item.bankName, swift: item.swift,
    account: admin ? item.accountOrIban : maskDestination(item.accountOrIban),
    purpose: item.purpose, note: item.note, reviewNote: item.reviewNote || '',
    debitEntryId: item.debitEntryId ? String(item.debitEntryId) : null,
    refundEntryId: item.refundEntryId ? String(item.refundEntryId) : null,
    createdAt: item.createdAt, reviewedAt: item.reviewedAt || null
  };
}

/** Extra rows for a receipt/alert about a ledger entry that belongs to an international transfer. */
async function extraRowsForEntry(entry) {
  if (!entry || !['international_out', 'international_refund'].includes(entry.kind)) return [];
  const item = await InternationalTransfer.findOne({ $or: [{ debitEntryId: entry._id }, { refundEntryId: entry._id }] }).lean();
  if (!item) return [];
  const received = `${item.currency} ${item.receiveAmount.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  return [
    ['Transfer reference', item.reference],
    ['Recipient bank', `${item.bankName} (${item.swift})`],
    ['Destination country', item.recipientCountry],
    ['Recipient account', maskDestination(item.accountOrIban)],
    ['Amount sent', `USD ${fmtMoney(item.amountCents)}`],
    ['Transfer fee', `USD ${fmtMoney(item.feeCents)}`],
    ['Exchange rate', `1 USD = ${item.rate} ${item.currency}`],
    ['Recipient receives', received],
    ['Status', item.status.charAt(0).toUpperCase() + item.status.slice(1)]
  ];
}

module.exports = { SWIFT, PURPOSES, BLOCKED, MIN_CENTS, MAX_CENTS, DAILY_LIMIT_CENTS, ibanValid, cleanDestinationAccount, maskDestination, present, extraRowsForEntry };
