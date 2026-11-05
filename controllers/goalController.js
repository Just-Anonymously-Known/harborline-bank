const mongoose = require('mongoose');
const Account = require('../models/Account');
const LedgerEntry = require('../models/LedgerEntry');
const SavingsGoal = require('../models/SavingsGoal');
const { cents, money, fmtMoney } = require('../utils/finance');
const { notify } = require('../services/notificationService');
const { sendTransactionAlert } = require('../services/emailAlertService');

async function listGoals(req, res) {
  const goals = await SavingsGoal.find({ userId: req.session.user.id }).sort({ createdAt: -1 }).lean();
  res.json({ goals: goals.map(goal => ({ ...goal, id: String(goal._id), target: money(goal.targetCents), saved: money(goal.savedCents), progress: Math.min(100, Math.round(goal.savedCents / goal.targetCents * 100)) })) });
}

async function createGoal(req, res) {
  const name = String(req.body.name || '').trim().slice(0, 60);
  const targetCents = cents(req.body.target);
  if (name.length < 2 || !targetCents) return res.status(400).json({ error: 'Enter a goal name and target amount.' });
  const goal = await SavingsGoal.create({ userId: req.session.user.id, name, targetCents });
  res.status(201).json({ goal: { id: String(goal._id), name: goal.name, target: money(goal.targetCents), saved: '0.00', progress: 0 } });
}

async function contribute(req, res) {
  const amount = cents(req.body.amount);
  if (!amount) return res.status(400).json({ error: 'Enter a valid contribution amount.' });
  const dbSession = await mongoose.startSession();
  let saved;
  try {
    await dbSession.withTransaction(async () => {
      const goal = await SavingsGoal.findOne({ _id: req.params.id, userId: req.session.user.id }).session(dbSession);
      const account = await Account.findOne({ userId: req.session.user.id, accountType: 'checking' }).session(dbSession);
      if (!goal || !account) throw Object.assign(new Error('Goal or checking account not found.'), { status: 404 });
      if (account.status !== 'active') throw Object.assign(new Error('This account is frozen.'), { status: 400 });
      if (account.balanceCents < amount) throw Object.assign(new Error('Insufficient balance for this contribution.'), { status: 400 });
      account.balanceCents -= amount;
      goal.savedCents += amount;
      goal.status = goal.savedCents >= goal.targetCents ? 'complete' : 'active';
      saved = goal.savedCents;
      await account.save({ session: dbSession });
      await goal.save({ session: dbSession });
      await LedgerEntry.create([{
        transferGroup: `goal-${goal._id}-${Date.now()}`, accountId: account._id, kind: 'goal_contribution',
        amountCents: amount, balanceAfterCents: account.balanceCents, description: `Saved for ${goal.name}`, category: 'Other'
      }], { session: dbSession });
      await notify(req.session.user.id, 'Savings goal updated', `$${fmtMoney(amount)} added to ${goal.name}.`, dbSession);
    });
  } catch (err) { if (err.status) return res.status(err.status).json({ error: err.message }); throw err; }
  finally { await dbSession.endSession(); }
  const goal = await SavingsGoal.findById(req.params.id).select('name');
  await sendTransactionAlert(req.session.user.id, 'Savings goal contribution', `$${fmtMoney(amount)} was added to ${goal?.name || 'your savings goal'}.`);
  res.json({ message: 'Contribution added.', saved: money(saved) });
}

async function withdraw(req, res) {
  const amount = cents(req.body.amount);
  if (!amount) return res.status(400).json({ error: 'Enter a valid withdrawal amount.' });
  const dbSession = await mongoose.startSession();
  let saved;
  try {
    await dbSession.withTransaction(async () => {
      const goal = await SavingsGoal.findOne({ _id: req.params.id, userId: req.session.user.id }).session(dbSession);
      const account = await Account.findOne({ userId: req.session.user.id, accountType: 'checking' }).session(dbSession);
      if (!goal || !account) throw Object.assign(new Error('Goal or checking account not found.'), { status: 404 });
      if (goal.savedCents < amount) throw Object.assign(new Error('The goal does not have enough saved funds.'), { status: 400 });
      goal.savedCents -= amount;
      goal.status = goal.savedCents >= goal.targetCents ? 'complete' : 'active';
      account.balanceCents += amount;
      saved = goal.savedCents;
      await goal.save({ session: dbSession });
      await account.save({ session: dbSession });
      await LedgerEntry.create([{
        transferGroup: `goal-${goal._id}-${Date.now()}`, accountId: account._id, kind: 'goal_withdrawal',
        amountCents: amount, balanceAfterCents: account.balanceCents, description: `Withdrawn from ${goal.name}`, category: 'Other'
      }], { session: dbSession });
    });
  } catch (err) { if (err.status) return res.status(err.status).json({ error: err.message }); throw err; }
  finally { await dbSession.endSession(); }
  const goal = await SavingsGoal.findById(req.params.id).select('name');
  await sendTransactionAlert(req.session.user.id, 'Savings goal withdrawal', `$${fmtMoney(amount)} was moved back to checking from ${goal?.name || 'your savings goal'}.`);
  res.json({ message: 'Funds moved back to checking.', saved: money(saved) });
}

module.exports = { listGoals, createGoal, contribute, withdraw };
