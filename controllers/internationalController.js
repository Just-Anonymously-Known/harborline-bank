const crypto = require('crypto');
const mongoose = require('mongoose');
const User = require('../models/User');
const Account = require('../models/Account');
const LedgerEntry = require('../models/LedgerEntry');
const InternationalTransfer = require('../models/InternationalTransfer');
const { cents, fmtMoney } = require('../utils/finance');
const { notify } = require('../services/notificationService');
const { sendTransactionAlert } = require('../services/emailAlertService');
const { queueEntryAlert } = require('../services/fundingReceiptService');
const { recordAdminAction } = require('../services/auditService');
const fx = require('../services/fxService');
const intl = require('../services/internationalService');

const fail = (message, status = 400) => Object.assign(new Error(message), { status, expose: true });
const clean = (value, max) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);

function parseAmount(raw) {
  const amount = cents(raw);
  if (!amount) throw fail('Enter a valid amount in USD.');
  if (amount < intl.MIN_CENTS) throw fail('The minimum international transfer is $10.00.');
  if (amount > intl.MAX_CENTS) throw fail('The maximum for one international transfer is $100,000.00.');
  return amount;
}

const presentQuote = (amount, q) => ({
  currency: q.currency, rate: q.rate, rateSource: q.source,
  amount: (amount / 100).toFixed(2), fee: (q.feeCents / 100).toFixed(2), total: (q.totalCents / 100).toFixed(2),
  receiveAmount: q.receiveAmount,
  note: q.source === 'live' ? 'Live market rate, locked when you submit.' : 'Indicative rate, locked when you submit.'
});

async function currencies(req, res) {
  res.json({ currencies: await fx.currencyList(), purposes: intl.PURPOSES, limits: { min: intl.MIN_CENTS / 100, max: intl.MAX_CENTS / 100, daily: intl.DAILY_LIMIT_CENTS / 100 } });
}

async function quote(req, res) {
  const amount = parseAmount(req.body.amount);
  const q = await fx.quote(amount, req.body.currency);
  if (!q) throw fail('That currency is not supported.');
  res.json({ quote: presentQuote(amount, q) });
}

async function usedToday(userId, session) {
  const startOfDay = new Date(); startOfDay.setUTCHours(0, 0, 0, 0);
  const rows = await InternationalTransfer.aggregate([
    { $match: { userId: new mongoose.Types.ObjectId(String(userId)), status: { $in: ['pending', 'completed'] }, createdAt: { $gte: startOfDay } } },
    { $group: { _id: null, total: { $sum: '$amountCents' } } }
  ]).session(session || null);
  return rows[0]?.total || 0;
}

async function create(req, res) {
  const amount = parseAmount(req.body.amount);
  const country = clean(req.body.country, 2).toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) throw fail('Choose the recipient country.');
  if (intl.BLOCKED.has(country)) throw fail('We cannot send transfers to this country.');
  const recipientName = clean(req.body.recipientName, 80);
  const bankName = clean(req.body.bankName, 80);
  if (recipientName.length < 2) throw fail('Enter the recipient full name.');
  if (bankName.length < 2) throw fail('Enter the recipient bank name.');
  const swift = clean(req.body.swift, 11).toUpperCase().replace(/\s/g, '');
  if (!intl.SWIFT.test(swift)) throw fail('Enter a valid SWIFT/BIC code (8 or 11 characters, for example GTBINGLA).');
  const destination = intl.cleanDestinationAccount(req.body.account);
  const purpose = intl.PURPOSES.includes(req.body.purpose) ? req.body.purpose : null;
  if (!purpose) throw fail('Choose the purpose of this transfer.');
  const note = clean(req.body.note, 100);
  const q = await fx.quote(amount, req.body.currency);
  if (!q) throw fail('That currency is not supported.');

  const reference = 'INT-' + crypto.randomBytes(4).toString('hex').toUpperCase();
  const dbSession = await mongoose.startSession();
  let item, entry, newBalance;
  try {
    await dbSession.withTransaction(async () => {
      const account = await Account.findOne(req.body.fromAccountId
        ? { _id: req.body.fromAccountId, userId: req.session.user.id }
        : { userId: req.session.user.id, accountType: 'checking' }).session(dbSession);
      if (!account) throw fail('Choose an account to send from.');
      if (account.status !== 'active') throw fail('This account is frozen.');
      if (account.balanceCents < q.totalCents) throw fail(`Insufficient funds. You need $${fmtMoney(q.totalCents)} including the fee.`);
      if ((await usedToday(req.session.user.id, dbSession)) + amount > intl.DAILY_LIMIT_CENTS) throw fail(`This exceeds your daily international limit of $${fmtMoney(intl.DAILY_LIMIT_CENTS)}.`);
      account.balanceCents -= q.totalCents;
      await account.save({ session: dbSession });
      newBalance = account.balanceCents;
      const created = await LedgerEntry.create([{
        transferGroup: reference, accountId: account._id, counterpartyName: recipientName, kind: 'international_out',
        amountCents: q.totalCents, balanceAfterCents: account.balanceCents,
        description: (note || `International transfer · ${purpose}`).slice(0, 100), category: 'Transfer'
      }], { session: dbSession, ordered: true });
      entry = created[0];
      const docs = await InternationalTransfer.create([{
        userId: req.session.user.id, fromAccountId: account._id, reference, amountCents: amount, feeCents: q.feeCents, totalCents: q.totalCents,
        currency: q.currency, rate: q.rate, rateSource: q.source, receiveAmount: q.receiveAmount,
        recipientName, recipientCountry: country, bankName, swift, accountOrIban: destination, purpose, note, status: 'pending', debitEntryId: entry._id
      }], { session: dbSession, ordered: true });
      item = docs[0];
      await notify(req.session.user.id, 'International transfer submitted', `$${fmtMoney(amount)} to ${recipientName} (${country}) is being processed. Reference ${reference}.`, dbSession);
    });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    throw error;
  } finally { await dbSession.endSession(); }
  queueEntryAlert(entry._id);
  res.status(201).json({ message: 'International transfer submitted.', balance: (newBalance / 100).toFixed(2), transfer: intl.present(item) });
}

async function listMine(req, res) {
  const items = await InternationalTransfer.find({ userId: req.session.user.id }).sort({ createdAt: -1 }).limit(50).lean();
  res.json({ transfers: items.map(item => intl.present(item)) });
}

/** Shared by admin rejection and customer cancellation: returns the held money and records a refund entry. */
async function settle(item, status, actorId, note) {
  const dbSession = await mongoose.startSession();
  let refundEntry, completedMessage;
  try {
    await dbSession.withTransaction(async () => {
      const current = await InternationalTransfer.findOne({ _id: item._id, status: 'pending' }).session(dbSession);
      if (!current) throw fail('This transfer has already been processed.', 409);
      if (status === 'completed') {
        current.status = 'completed';
      } else {
        const account = await Account.findById(current.fromAccountId).session(dbSession);
        account.balanceCents += current.totalCents;
        await account.save({ session: dbSession });
        const created = await LedgerEntry.create([{
          transferGroup: current.reference, accountId: account._id, counterpartyName: current.recipientName, kind: 'international_refund',
          amountCents: current.totalCents, balanceAfterCents: account.balanceCents,
          description: `Refund: international transfer to ${current.recipientName}`.slice(0, 100), category: 'Transfer'
        }], { session: dbSession, ordered: true });
        refundEntry = created[0];
        current.status = status; current.refundEntryId = refundEntry._id;
      }
      current.reviewedBy = actorId || undefined; current.reviewedAt = new Date(); current.reviewNote = note || '';
      await current.save({ session: dbSession });
      const label = status === 'completed' ? 'completed' : status === 'rejected' ? 'was not approved and has been refunded' : 'was canceled and refunded';
      completedMessage = `Your $${fmtMoney(current.amountCents)} transfer to ${current.recipientName} (${current.recipientCountry}) ${label}. Reference ${current.reference}.`;
      await notify(current.userId, status === 'completed' ? 'International transfer completed' : 'International transfer refunded', completedMessage, dbSession);
      item = current;
    });
  } finally { await dbSession.endSession(); }
  if (status === 'completed') sendTransactionAlert(item.userId, 'International transfer completed', completedMessage).catch(error => console.error('International completion email failed:', error.message));
  else queueEntryAlert(refundEntry._id);
  return item;
}

async function cancel(req, res) {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Transfer not found.' });
  const item = await InternationalTransfer.findOne({ _id: req.params.id, userId: req.session.user.id });
  if (!item) return res.status(404).json({ error: 'Transfer not found.' });
  try { await settle(item, 'canceled', null, 'Canceled by customer'); }
  catch (error) { if (error.status) return res.status(error.status).json({ error: error.message }); throw error; }
  res.json({ message: 'Transfer canceled and your money has been returned.' });
}

async function listAdmin(req, res) {
  const items = await InternationalTransfer.find().sort({ createdAt: -1 }).limit(100).populate('userId', 'name email').lean();
  items.sort((a, b) => (a.status === 'pending' ? 0 : 1) - (b.status === 'pending' ? 0 : 1));
  res.json({ transfers: items.map(item => ({ ...intl.present(item, { admin: true }), customer: item.userId ? { name: item.userId.name, email: item.userId.email } : null })) });
}

async function decide(req, res) {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Transfer not found.' });
  const decision = req.body.decision === 'approve' ? 'completed' : req.body.decision === 'reject' ? 'rejected' : null;
  if (!decision) return res.status(400).json({ error: 'Choose approve or reject.' });
  const item = await InternationalTransfer.findById(req.params.id);
  if (!item) return res.status(404).json({ error: 'Transfer not found.' });
  try { await settle(item, decision, req.session.user.id, req.auditReason); }
  catch (error) { if (error.status) return res.status(error.status).json({ error: error.message }); throw error; }
  await recordAdminAction(req, decision === 'completed' ? 'international_approved' : 'international_rejected', item._id, { reference: item.reference, amount: (item.amountCents / 100).toFixed(2) });
  res.json({ message: decision === 'completed' ? 'Transfer approved and marked completed.' : 'Transfer rejected and the customer was refunded.' });
}

module.exports = { currencies, quote, create, listMine, cancel, listAdmin, decide };
