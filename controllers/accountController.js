const Account = require('../models/Account');
const mongoose = require('mongoose');
const crypto = require('crypto');
const LedgerEntry = require('../models/LedgerEntry');
const { createAccountNumber } = require('../config/database');
const { cents, money } = require('../utils/finance');
const { sendTransactionAlert } = require('../services/emailAlertService');

async function listAccounts(req, res) {
  const accounts = await Account.find({ userId: req.session.user.id }).sort({ accountType: 1, createdAt: 1 }).lean();
  res.json({ accounts: accounts.map(account => ({
    id: String(account._id), accountNumber: account.accountNumber, accountType: account.accountType,
    nickname: account.nickname || '', status: account.status, balance: (account.balanceCents / 100).toFixed(2), currency: account.currency
  })) });
}

async function openSavings(req, res) {
  if (await Account.exists({ userId: req.session.user.id, accountType: 'savings' })) return res.status(409).json({ error: 'You already have a savings account.' });
  const nickname = String(req.body.nickname || 'Savings').trim().slice(0, 40) || 'Savings';
  try {
    const account = await Account.create({ userId: req.session.user.id, accountNumber: await createAccountNumber(), accountType: 'savings', nickname });
    res.status(201).json({ account: { id: String(account._id), accountNumber: account.accountNumber, accountType: account.accountType, nickname: account.nickname, status: account.status, balance: '0.00' } });
  } catch (err) { if (err.code === 11000) return res.status(409).json({ error: 'A savings account already exists.' }); throw err; }
}

async function renameAccount(req, res) {
  const nickname = String(req.body.nickname || '').trim().slice(0, 40);
  if (nickname.length < 2) return res.status(400).json({ error: 'Enter a name of at least 2 characters.' });
  const account = await Account.findOneAndUpdate({ _id: req.params.id, userId: req.session.user.id }, { nickname }, { new: true });
  if (!account) return res.status(404).json({ error: 'Account not found.' });
  res.json({ message: 'Account name updated.', nickname: account.nickname });
}

async function transferBetweenAccounts(req, res) {
  const amount = cents(req.body.amount);
  if (!amount) return res.status(400).json({ error: 'Enter a valid amount.' });
  const dbSession = await mongoose.startSession();
  let balance, fromName, toName;
  try {
    await dbSession.withTransaction(async () => {
      const accounts = await Account.find({ _id: { $in: [req.body.fromAccountId, req.body.toAccountId] }, userId: req.session.user.id }).sort({ _id: 1 }).session(dbSession);
      const from = accounts.find(account => String(account._id) === String(req.body.fromAccountId));
      const to = accounts.find(account => String(account._id) === String(req.body.toAccountId));
      if (!from || !to || String(from._id) === String(to._id)) throw Object.assign(new Error('Choose two different accounts you own.'), { status: 400 });
      if (from.status !== 'active' || to.status !== 'active') throw Object.assign(new Error('Both accounts must be active.'), { status: 400 });
      if (from.balanceCents < amount) throw Object.assign(new Error('Insufficient balance.'), { status: 400 });
      from.balanceCents -= amount; to.balanceCents += amount; balance = from.balanceCents;
      fromName = from.nickname || from.accountType; toName = to.nickname || to.accountType;
      await from.save({ session: dbSession }); await to.save({ session: dbSession });
      const transferGroup = crypto.randomUUID();
      await LedgerEntry.create([
        { transferGroup, accountId: from._id, counterpartyAccountId: to._id, counterpartyName: to.nickname || to.accountType, kind: 'transfer_out', amountCents: amount, balanceAfterCents: from.balanceCents, description: `Moved to ${to.nickname || to.accountType}`, category: 'Transfer' },
        { transferGroup, accountId: to._id, counterpartyAccountId: from._id, counterpartyName: from.nickname || from.accountType, kind: 'transfer_in', amountCents: amount, balanceAfterCents: to.balanceCents, description: `Moved from ${from.nickname || from.accountType}`, category: 'Transfer' }
      ], { session: dbSession, ordered: true });
    });
  } catch (error) { if (error.status) return res.status(error.status).json({ error: error.message }); throw error; }
  finally { await dbSession.endSession(); }
  await sendTransactionAlert(req.session.user.id, 'Transfer between accounts', `$${money(amount)} moved from ${fromName} to ${toName}.`);
  res.json({ message: 'Transfer between your accounts complete.', balance: money(balance) });
}

module.exports = { listAccounts, openSavings, renameAccount, transferBetweenAccounts };
