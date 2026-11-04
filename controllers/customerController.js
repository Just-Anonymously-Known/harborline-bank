const crypto = require('crypto');
const mongoose = require('mongoose');
const User = require('../models/User');
const Account = require('../models/Account');
const LedgerEntry = require('../models/LedgerEntry');
const DeviceSession = require('../models/DeviceSession');
const Notification = require('../models/Notification');
const CardTransaction = require('../models/CardTransaction');
const Card = require('../models/Card');
const { notify } = require('../services/notificationService');
const { sendTransactionAlert } = require('../services/emailAlertService');
const { cents, money } = require('../utils/finance');
const { safeUser } = require('../utils/identity');
const { statementHtml } = require('../services/statementService');
const ScheduledTransfer = require('../models/ScheduledTransfer');
const { processDueTransfers } = require('../services/scheduledTransferService');
const TransferReview = require('../models/TransferReview');
const { generateReceipt } = require('../services/fundingReceiptService');

function dateRange(query) {
  const start = query.start ? new Date(`${query.start}T00:00:00.000Z`) : new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
  const end = query.end ? new Date(`${query.end}T23:59:59.999Z`) : new Date();
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end || end - start > 366 * 86400000) return null;
  return { start, end };
}

async function downloadStatement(req, res) {
  const range = dateRange(req.query);
  if (!range) return res.status(400).json({ error: 'Choose a valid statement period of no more than 12 months.' });
  const account = await Account.findOne({ _id: req.query.accountId, userId: req.session.user.id }).lean();
  if (!account) return res.status(404).json({ error: 'Account not found.' });
  const [owner, entries] = await Promise.all([
    User.findById(req.session.user.id).select('name email').lean(),
    LedgerEntry.find({ accountId: account._id, createdAt: { $gte: range.start, $lte: range.end } }).sort({ createdAt: 1 }).limit(5000).lean()
  ]);
  res.type('html').set('Content-Disposition', 'attachment; filename="harborline-statement.html"')
    .send(statementHtml({ owner, account, entries, ...range }));
}

// GET /api/receipts/:id  ->  PDF receipt for one of the signed-in customer's transactions.
async function downloadReceipt(req, res) {
  const id = String(req.params.id || '').replace(/\.pdf$/i, '');
  if (!mongoose.isValidObjectId(id)) return res.status(404).json({ error: 'Receipt not found.' });
  const owner = await User.findById(req.session.user.id).select('name email').lean();
  if (!owner) return res.status(404).json({ error: 'Receipt not found.' });

  let pdfInput;
  const entry = await LedgerEntry.findById(id).lean();
  if (entry) {
    const account = await Account.findOne({ _id: entry.accountId, userId: req.session.user.id }).lean();
    if (!account) return res.status(404).json({ error: 'Receipt not found.' });
    const credit = ['funding', 'transfer_in', 'goal_withdrawal'].includes(entry.kind);
    pdfInput = {
      customer: owner, account, amount: entry.amountCents, balance: entry.balanceAfterCents,
      previousBalance: entry.balanceAfterCents + (credit ? -entry.amountCents : entry.amountCents),
      entry: { kind: entry.kind, reference: entry.transferGroup, createdAt: entry.createdAt, description: entry.description, category: entry.category, counterparty: entry.counterpartyName }
    };
    if (pdfInput.previousBalance < 0) pdfInput.previousBalance = undefined;
  } else {
    const purchase = await CardTransaction.findOne({ _id: id, userId: req.session.user.id }).lean();
    if (!purchase) return res.status(404).json({ error: 'Receipt not found.' });
    pdfInput = {
      customer: owner, account: undefined, amount: purchase.amountCents,
      entry: { kind: purchase.kind === 'payment' ? 'card_payment' : 'card_purchase', reference: `card-${purchase._id}`, createdAt: purchase.createdAt, description: purchase.description, category: purchase.category }
    };
  }

  const pdf = await generateReceipt(pdfInput);
  res.set({
    'Content-Type': 'application/pdf',
    'Content-Length': pdf.length,
    'Content-Disposition': `inline; filename="harborline-receipt-${id.slice(-8)}.pdf"`,
    'Cache-Control': 'private, no-store'
  }).send(pdf);
}

async function currentUser(req, res) {
  if (!req.session.user) return res.json({ user: null });
  const user = await User.findById(req.session.user.id);
  if (!user) { req.session.destroy(() => {}); return res.json({ user: null }); }
  if (!user.verified || user.role === 'admin') return res.json({ user: safeUser(user), account: null, transactions: [] });
  const accounts = await Account.find({ userId: user._id }).sort({ accountType: 1, createdAt: 1 }).lean();
  const account = accounts.find(item => item.accountType === 'checking') || accounts[0];
  if (!account) return res.status(500).json({ error: 'Account is unavailable.' });
  const entries = await LedgerEntry.find({ accountId: { $in: accounts.map(item => item._id) } }).sort({ createdAt: -1 }).limit(100).lean();
  const creditPurchases = await CardTransaction.find({ userId: user._id, kind: 'purchase' }).populate('cardId', 'cardType').sort({ createdAt: -1 }).limit(50).lean();
  const creditCardIds = await Card.find({ userId: user._id, cardType: 'credit' }).distinct('_id');
  const [ledgerTotal, creditTotal] = await Promise.all([
    LedgerEntry.countDocuments({ accountId: { $in: accounts.map(item => item._id) } }),
    CardTransaction.countDocuments({ userId: user._id, cardId: { $in: creditCardIds }, kind: 'purchase' })
  ]);
  const notifications = await Notification.find({ userId: user._id }).sort({ createdAt: -1 }).limit(20).lean();
  res.json({
    user: safeUser(user),
    account: { id: String(account._id), accountNumber: account.accountNumber, balance: money(account.balanceCents), currency: account.currency, status: account.status },
    accounts: accounts.map(item => ({ id: String(item._id), accountNumber: item.accountNumber, accountType: item.accountType, nickname: item.nickname || '', status: item.status, balance: money(item.balanceCents), currency: item.currency })),
    dailyTransferLimit: money(user.dailyTransferLimitCents || 100000),
    transactionsHasMore: ledgerTotal + creditTotal > 100,
    notifications: notifications.map(item => ({ id: String(item._id), title: item.title, message: item.message, read: Boolean(item.readAt), createdAt: item.createdAt })),
    transactions: [
      ...entries.map(entry => ({ ...entry, counterparty_name: entry.counterpartyName || null, amount: money(entry.amountCents), balanceAfter: money(entry.balanceAfterCents) })),
      ...creditPurchases.filter(item => item.cardId?.cardType === 'credit').map(item => ({
        _id: item._id, transferGroup: `card-${item._id}`, kind: 'card_purchase', category: item.category,
        description: item.description, amount: money(item.amountCents), balanceAfter: '', createdAt: item.createdAt,
        counterparty_name: null
      }))
    ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 100)
  });
}

async function listTransactions(req, res) {
  const offset = Math.max(0, Math.min(5000, Number.parseInt(req.query.offset, 10) || 0));
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 100));
  const accounts = await Account.find({ userId: req.session.user.id }).select('_id').lean();
  const accountIds = accounts.map(item => item._id);
  const creditCardIds = await Card.find({ userId: req.session.user.id, cardType: 'credit' }).distinct('_id');
  const [entries, purchases, ledgerTotal, purchaseTotal] = await Promise.all([
    LedgerEntry.find({ accountId: { $in: accountIds } }).sort({ createdAt: -1 }).limit(offset + limit).lean(),
    CardTransaction.find({ userId: req.session.user.id, cardId: { $in: creditCardIds }, kind: 'purchase' }).populate('cardId', 'cardType').sort({ createdAt: -1 }).limit(offset + limit).lean(),
    LedgerEntry.countDocuments({ accountId: { $in: accountIds } }),
    CardTransaction.countDocuments({ userId: req.session.user.id, cardId: { $in: creditCardIds }, kind: 'purchase' })
  ]);
  const rows = [
    ...entries.map(item => ({ ...item, counterparty_name: item.counterpartyName || null, amount: money(item.amountCents), balanceAfter: money(item.balanceAfterCents) })),
    ...purchases.filter(item => item.cardId?.cardType === 'credit').map(item => ({
      _id: item._id, transferGroup: `card-${item._id}`, kind: 'card_purchase', category: item.category,
      description: item.description, amount: money(item.amountCents), balanceAfter: '', createdAt: item.createdAt, counterparty_name: null
    }))
  ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ transactions: rows.slice(offset, offset + limit), offset, total: ledgerTotal + purchaseTotal, hasMore: ledgerTotal + purchaseTotal > offset + limit });
}

async function updatePreferences(req, res) {
  const update = {};
  if (typeof req.body.emailOptIn === 'boolean') update.emailOptIn = req.body.emailOptIn;
  if (typeof req.body.transactionAlerts === 'boolean') update.transactionAlerts = req.body.transactionAlerts;
  if (!Object.keys(update).length) return res.status(400).json({ error: 'Choose an email preference.' });
  const user = await User.findByIdAndUpdate(req.session.user.id, update, { new: true });
  res.json({ user: safeUser(user), message: 'Email preferences saved.' });
}

async function transfer(req, res) {
  if (req.body.scheduledAt) return scheduleTransfer(req, res);
  const recipientNumber = String(req.body.accountNumber || '').replace(/\s/g, '');
  const amount = cents(req.body.amount);
  const memo = String(req.body.memo || 'Personal transfer').trim().slice(0, 100) || 'Personal transfer';
  const categoryOptions = ['Transfer', 'Food & drink', 'Home & bills', 'Shopping', 'Transport', 'Health', 'Other'];
  const category = categoryOptions.includes(req.body.category) ? req.body.category : 'Transfer';
  if (!/^\d{10}$/.test(recipientNumber) || !amount || amount > 100000000) {
    return res.status(400).json({ error: 'Enter a valid 10-digit recipient account and amount up to $1,000,000.' });
  }
  const dbSession = await mongoose.startSession();
  let newBalance, recipientName, recipientId, reviewPending = false;
  try {
    await dbSession.withTransaction(async () => {
      const sender = await Account.findOne(req.body.fromAccountId
        ? { _id: req.body.fromAccountId, userId: req.session.user.id }
        : { userId: req.session.user.id, accountType: 'checking' }).session(dbSession);
      const recipient = await Account.findOne({ accountNumber: recipientNumber }).session(dbSession);
      if (!sender || !recipient || String(recipient._id) === String(sender._id)) throw Object.assign(new Error('Recipient account was not found.'), { status: 400 });
      const recipientUser = await User.findOne({ _id: recipient.userId, verified: true }).session(dbSession);
      if (!recipientUser) throw Object.assign(new Error('Recipient account was not found.'), { status: 400 });
      if (sender.status !== 'active' || recipient.status !== 'active') throw Object.assign(new Error('One of these accounts is frozen.'), { status: 400 });
      const locked = await Account.find({ _id: { $in: [sender._id, recipient._id] } }).sort({ _id: 1 }).session(dbSession);
      const byId = new Map(locked.map(account => [String(account._id), account]));
      const from = byId.get(String(sender._id)), to = byId.get(String(recipient._id));
      if (!from || !to) throw Object.assign(new Error('Account is unavailable.'), { status: 400 });
      if (from.balanceCents < amount) throw Object.assign(new Error('Insufficient funds for this transfer.'), { status: 400 });
      const user = await User.findById(req.session.user.id).session(dbSession);
      const dailyLimit = user.dailyTransferLimitCents || 100000;
      const accountIds = await Account.find({ userId: user._id }).distinct('_id').session(dbSession);
      const startOfDay = new Date(); startOfDay.setUTCHours(0, 0, 0, 0);
      const totals = await LedgerEntry.aggregate([
        { $match: { accountId: { $in: accountIds }, kind: 'transfer_out', createdAt: { $gte: startOfDay } } },
        { $group: { _id: null, total: { $sum: '$amountCents' } } }
      ]).session(dbSession);
      if ((totals[0]?.total || 0) + amount > dailyLimit) throw Object.assign(new Error(`This transfer exceeds your daily limit of $${money(dailyLimit)}.`), { status: 400 });
      if (user.transferReviewThresholdCents > 0 && amount >= user.transferReviewThresholdCents) {
        await TransferReview.create([{
          userId: user._id, fromAccountId: from._id, toAccountId: to._id,
          amountCents: amount, memo, category, status: 'pending'
        }], { session: dbSession });
        await notify(user._id, 'Transfer awaiting review', `Your $${money(amount)} transfer is awaiting administrator review.`, dbSession);
        reviewPending = true;
        return;
      }
      const senderUser = await User.findById(from.userId).session(dbSession);
      from.balanceCents -= amount;
      to.balanceCents += amount;
      newBalance = from.balanceCents;
      recipientName = recipientUser.name;
      recipientId = recipientUser._id;
      await from.save({ session: dbSession });
      await to.save({ session: dbSession });
      const transferGroup = crypto.randomUUID();
      await LedgerEntry.create([
        { transferGroup, accountId: from._id, counterpartyAccountId: to._id, counterpartyName: recipientUser.name, kind: 'transfer_out', amountCents: amount, balanceAfterCents: from.balanceCents, description: memo, category },
        { transferGroup, accountId: to._id, counterpartyAccountId: from._id, counterpartyName: senderUser?.name || 'Harborline customer', kind: 'transfer_in', amountCents: amount, balanceAfterCents: to.balanceCents, description: memo, category }
      ], { session: dbSession, ordered: true });
      await notify(user._id, 'Transfer sent', `$${money(amount)} sent to ${recipientUser.name}.`, dbSession);
      await notify(recipientUser._id, 'Transfer received', `$${money(amount)} received from ${senderUser?.name || 'a Harborline customer'}.`, dbSession);
    });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  } finally { await dbSession.endSession(); }
  if (reviewPending) return res.status(202).json({ message: 'Transfer submitted for administrator review. The balance has not changed yet.', status: 'pending_review' });
  await Promise.all([
    sendTransactionAlert(req.session.user.id, 'Transfer sent', `$${money(amount)} sent to ${recipientName}.`),
    sendTransactionAlert(recipientId, 'Transfer received', `$${money(amount)} received from a Harborline customer.`)
  ]);
  res.json({ message: 'Transfer completed.', balance: money(newBalance), recipient: recipientName });
}

async function scheduleTransfer(req, res) {
  const recipientNumber = String(req.body.accountNumber || '').replace(/\s/g, '');
  const amount = cents(req.body.amount);
  const scheduledAt = new Date(req.body.scheduledAt);
  const memo = String(req.body.memo || 'Scheduled personal transfer').trim().slice(0, 100) || 'Scheduled personal transfer';
  const categories = ['Transfer', 'Food & drink', 'Home & bills', 'Shopping', 'Transport', 'Health', 'Other'];
  const category = categories.includes(req.body.category) ? req.body.category : 'Transfer';
  if (!/^\d{10}$/.test(recipientNumber) || !amount || amount > 100000000 || Number.isNaN(scheduledAt.getTime()) || scheduledAt.getTime() < Date.now() + 5 * 60 * 1000 || scheduledAt.getTime() > Date.now() + 366 * 86400000) return res.status(400).json({ error: 'Choose a valid recipient, amount, and date at least 5 minutes from now and within one year.' });
  const [from, to] = await Promise.all([
    Account.findOne({ _id: req.body.fromAccountId, userId: req.session.user.id, status: 'active' }),
    Account.findOne({ accountNumber: recipientNumber, status: 'active' })
  ]);
  if (!from || !to || String(from._id) === String(to._id)) return res.status(400).json({ error: 'Choose active accounts belonging to different customers.' });
  const recipient = await User.findOne({ _id: to.userId, role: 'customer', verified: true });
  if (!recipient) return res.status(400).json({ error: 'Recipient account was not found.' });
  const sender = await User.findById(req.session.user.id).select('transferReviewThresholdCents');
  if (sender?.transferReviewThresholdCents > 0 && amount >= sender.transferReviewThresholdCents) return res.status(409).json({ error: 'This amount requires administrator review. Submit it as an immediate transfer to send it for review.' });
  const transfer = await ScheduledTransfer.create({ userId: req.session.user.id, fromAccountId: from._id, toAccountId: to._id, amountCents: amount, memo, category, scheduledAt });
  res.status(201).json({ message: `Transfer scheduled for ${scheduledAt.toLocaleString()}.`, transfer: { id: String(transfer._id), scheduledAt, amount: money(amount), status: transfer.status } });
}

async function listScheduledTransfers(req, res) {
  await processDueTransfers();
  const transfers = await ScheduledTransfer.find({ userId: req.session.user.id }).sort({ scheduledAt: -1 }).limit(100).populate('toAccountId', 'accountNumber nickname').lean();
  res.json({ transfers: transfers.map(item => ({ id: String(item._id), scheduledAt: item.scheduledAt, amount: money(item.amountCents), status: item.status, failureReason: item.failureReason || '', memo: item.memo, recipient: item.toAccountId?.nickname || `•••• ${item.toAccountId?.accountNumber?.slice(-4) || ''}` })) });
}

async function cancelScheduledTransfer(req, res) {
  const item = await ScheduledTransfer.findOneAndUpdate({ _id: req.params.id, userId: req.session.user.id, status: 'scheduled', scheduledAt: { $gt: new Date() } }, { status: 'canceled' }, { new: true });
  if (!item) return res.status(404).json({ error: 'Upcoming scheduled transfer not found.' });
  res.json({ message: 'Scheduled transfer canceled.' });
}

async function listTransferReviews(req, res) {
  const items = await TransferReview.find({ userId: req.session.user.id }).sort({ createdAt: -1 }).limit(20).populate('toAccountId', 'accountNumber nickname').lean();
  res.json({ reviews: items.map(item => ({ id: String(item._id), amount: money(item.amountCents), status: item.status, createdAt: item.createdAt, recipient: item.toAccountId?.nickname || `•••• ${item.toAccountId?.accountNumber?.slice(-4) || ''}` })) });
}

async function listSessions(req, res) {
  const sessions = await DeviceSession.find({ userId: req.session.user.id }).sort({ lastSeenAt: -1 }).lean();
  res.json({ sessions: sessions.map(item => ({ id: String(item._id), label: item.label, lastSeenAt: item.lastSeenAt, current: item.sessionId === req.sessionID })) });
}

async function revokeSession(req, res) {
  const device = await DeviceSession.findOne({ _id: req.params.id, userId: req.session.user.id });
  if (!device) return res.status(404).json({ error: 'Session not found.' });
  await mongoose.connection.collection('web_sessions').deleteOne({ _id: device.sessionId });
  await device.deleteOne();
  const isCurrent = device.sessionId === req.sessionID;
  if (isCurrent) return req.session.destroy(() => { res.clearCookie('harborline.sid'); res.json({ message: 'This session was signed out.', current: true }); });
  res.json({ message: 'Session signed out.', current: false });
}

async function markNotificationRead(req, res) {
  const item = await Notification.findOneAndUpdate({ _id: req.params.id, userId: req.session.user.id }, { readAt: new Date() }, { new: true });
  if (!item) return res.status(404).json({ error: 'Notification not found.' });
  res.json({ ok: true });
}

module.exports = { currentUser, listTransactions, updatePreferences, transfer, listSessions, revokeSession, markNotificationRead, downloadStatement, downloadReceipt, listScheduledTransfers, cancelScheduledTransfer, listTransferReviews };
