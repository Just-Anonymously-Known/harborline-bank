const mongoose = require('mongoose');
const crypto = require('crypto');
const Card = require('../models/Card');
const CardTransaction = require('../models/CardTransaction');
const Account = require('../models/Account');
const LedgerEntry = require('../models/LedgerEntry');
const { cents, money } = require('../utils/finance');
const { notify } = require('../services/notificationService');
const { sendTransactionAlert } = require('../services/emailAlertService');

async function listCards(req, res) {
  let cards = await Card.find({ userId: req.session.user.id }).sort({ cardType: 1 }).lean();
  if (!cards.length) {
    const generated = await Card.create([
      { userId: req.session.user.id, cardType: 'debit', last4: String(crypto.randomInt(0, 10000)).padStart(4, '0') },
      { userId: req.session.user.id, cardType: 'credit', last4: String(crypto.randomInt(0, 10000)).padStart(4, '0'), creditLimitCents: 500000 }
    ]);
    cards = generated.map(card => card.toObject());
  }
  res.json({ cards: cards.map(card => ({
    id: String(card._id), cardType: card.cardType, last4: card.last4, status: card.status,
    creditLimit: money(card.creditLimitCents), balance: money(card.balanceCents), rewardsPoints: card.rewardsPoints
  })) });
}

async function setCardStatus(req, res) {
  const status = req.body.status;
  if (!['active', 'locked'].includes(status)) return res.status(400).json({ error: 'Choose active or locked.' });
  const card = await Card.findOneAndUpdate({ userId: req.session.user.id, cardType: req.params.type }, { status }, { new: true });
  if (!card) return res.status(404).json({ error: 'Card not found.' });
  res.json({ message: `${card.cardType === 'debit' ? 'Debit' : 'Credit'} card ${status}.`, status: card.status });
}

async function debitPurchase(req, res) {
  const amount = cents(req.body.amount);
  const description = String(req.body.description || 'Card purchase').trim().slice(0, 100) || 'Card purchase';
  const categories = ['Food & drink', 'Home & bills', 'Shopping', 'Transport', 'Health', 'Other'];
  const category = categories.includes(req.body.category) ? req.body.category : 'Other';
  if (!amount) return res.status(400).json({ error: 'Enter a valid purchase amount.' });
  const dbSession = await mongoose.startSession();
  let remaining;
  try {
    await dbSession.withTransaction(async () => {
      const card = await Card.findOne({ userId: req.session.user.id, cardType: 'debit' }).session(dbSession);
      const account = await Account.findOne({ userId: req.session.user.id, accountType: 'checking' }).session(dbSession);
      if (!card || !account) throw Object.assign(new Error('Debit card or checking account unavailable.'), { status: 404 });
      if (card.status !== 'active') throw Object.assign(new Error('Unlock your debit card before using it.'), { status: 400 });
      if (account.status !== 'active') throw Object.assign(new Error('This account is frozen.'), { status: 400 });
      if (account.balanceCents < amount) throw Object.assign(new Error('Insufficient checking balance.'), { status: 400 });
      account.balanceCents -= amount;
      remaining = account.balanceCents;
      await account.save({ session: dbSession });
      await LedgerEntry.create([{
        transferGroup: `purchase-${Date.now()}`, accountId: account._id, kind: 'card_purchase',
        amountCents: amount, balanceAfterCents: remaining, description, category
      }], { session: dbSession });
      await CardTransaction.create([{ userId: req.session.user.id, cardId: card._id, kind: 'purchase', amountCents: amount, description, category }], { session: dbSession });
      await notify(req.session.user.id, 'Debit card purchase', `$${money(amount)} at ${description}.`, dbSession);
    });
  } catch (err) { if (err.status) return res.status(err.status).json({ error: err.message }); throw err; }
  finally { await dbSession.endSession(); }
  await sendTransactionAlert(req.session.user.id, 'Debit card purchase', `$${money(amount)} at ${description}.`);
  res.json({ message: 'Card purchase recorded.', balance: money(remaining) });
}

async function creditPurchase(req, res) {
  const amount = cents(req.body.amount);
  const description = String(req.body.description || 'Card purchase').trim().slice(0, 100) || 'Card purchase';
  const categories = ['Food & drink', 'Home & bills', 'Shopping', 'Transport', 'Health', 'Other'];
  const category = categories.includes(req.body.category) ? req.body.category : 'Other';
  if (!amount) return res.status(400).json({ error: 'Enter a valid purchase amount.' });
  const dbSession = await mongoose.startSession();
  let balance;
  try {
    await dbSession.withTransaction(async () => {
      const card = await Card.findOne({ userId: req.session.user.id, cardType: 'credit' }).session(dbSession);
      if (!card) throw Object.assign(new Error('Credit card unavailable.'), { status: 404 });
      if (card.status !== 'active') throw Object.assign(new Error('Unlock your credit card before using it.'), { status: 400 });
      if (card.balanceCents + amount > card.creditLimitCents) throw Object.assign(new Error('Purchase exceeds the available credit.'), { status: 400 });
      card.balanceCents += amount;
      card.rewardsPoints += Math.floor(amount / 100);
      balance = card.balanceCents;
      await card.save({ session: dbSession });
      await CardTransaction.create([{ userId: req.session.user.id, cardId: card._id, kind: 'purchase', amountCents: amount, description, category }], { session: dbSession });
      await notify(req.session.user.id, 'Credit card purchase', `$${money(amount)} at ${description}.`, dbSession);
    });
  } catch (err) { if (err.status) return res.status(err.status).json({ error: err.message }); throw err; }
  finally { await dbSession.endSession(); }
  await sendTransactionAlert(req.session.user.id, 'Credit card purchase', `$${money(amount)} at ${description}.`);
  res.json({ message: 'Card purchase recorded.', balance: money(balance) });
}

async function payCreditCard(req, res) {
  const amount = cents(req.body.amount);
  if (!amount) return res.status(400).json({ error: 'Enter a valid payment amount.' });
  const dbSession = await mongoose.startSession();
  let cardBalance;
  try {
    await dbSession.withTransaction(async () => {
      const card = await Card.findOne({ userId: req.session.user.id, cardType: 'credit' }).session(dbSession);
      const account = await Account.findOne({ userId: req.session.user.id, accountType: 'checking' }).session(dbSession);
      if (!card || !account) throw Object.assign(new Error('Credit card or checking account unavailable.'), { status: 404 });
      if (account.status !== 'active') throw Object.assign(new Error('This account is frozen.'), { status: 400 });
      if (card.balanceCents < amount) throw Object.assign(new Error('Payment exceeds the credit card balance.'), { status: 400 });
      if (account.balanceCents < amount) throw Object.assign(new Error('Insufficient checking balance.'), { status: 400 });
      card.balanceCents -= amount;
      account.balanceCents -= amount;
      cardBalance = card.balanceCents;
      await card.save({ session: dbSession });
      await account.save({ session: dbSession });
      await CardTransaction.create([{ userId: req.session.user.id, cardId: card._id, kind: 'payment', amountCents: amount, description: 'Credit card payment', category: 'Payment' }], { session: dbSession });
      await LedgerEntry.create([{ transferGroup: `card-payment-${Date.now()}`, accountId: account._id, kind: 'card_payment', amountCents: amount, balanceAfterCents: account.balanceCents, description: 'Credit card payment', category: 'Other' }], { session: dbSession });
      await notify(req.session.user.id, 'Credit card payment', `A $${money(amount)} payment was made.`, dbSession);
    });
  } catch (err) { if (err.status) return res.status(err.status).json({ error: err.message }); throw err; }
  finally { await dbSession.endSession(); }
  await sendTransactionAlert(req.session.user.id, 'Credit card payment', `A $${money(amount)} payment was made from checking.`);
  res.json({ message: 'Credit card payment recorded.', cardBalance: money(cardBalance) });
}

async function creditStatement(req, res) {
  const month = String(req.query.month || new Date().toISOString().slice(0, 7));
  if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'Choose a valid month.' });
  const [year, monthNumber] = month.split('-').map(Number);
  const start = new Date(Date.UTC(year, monthNumber - 1, 1));
  const end = new Date(Date.UTC(year, monthNumber, 1));
  const card = await Card.findOne({ userId: req.session.user.id, cardType: 'credit' }).lean();
  if (!card) return res.status(404).json({ error: 'Credit card unavailable.' });
  const activity = await CardTransaction.find({ cardId: card._id, createdAt: { $gte: start, $lt: end } }).sort({ createdAt: -1 }).lean();
  const purchases = activity.filter(item => item.kind === 'purchase').reduce((sum, item) => sum + item.amountCents, 0);
  const payments = activity.filter(item => item.kind === 'payment').reduce((sum, item) => sum + item.amountCents, 0);
  res.json({ month, balance: money(card.balanceCents), creditLimit: money(card.creditLimitCents), purchases: money(purchases), payments: money(payments), rewardsPoints: card.rewardsPoints, activity: activity.map(item => ({ ...item, amount: money(item.amountCents) })) });
}

module.exports = { listCards, setCardStatus, debitPurchase, creditPurchase, payCreditCard, creditStatement };
