
const mongoose = require('mongoose');
const crypto = require('crypto');

const Account = require('../models/Account');
const LedgerEntry = require('../models/LedgerEntry');
const SavingsGoal = require('../models/SavingsGoal');

const { cents, money } = require('../utils/finance');
const { notify } = require('../services/notificationService');
const { sendTransactionAlert } = require('../services/emailAlertService');

function getUserId(req) {
  return req.session.user.id;
}

function createHttpError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function sendError(res, error) {
  if (error.status) {
    return res.status(error.status).json({ error: error.message });
  }

  throw error;
}

function parsePositiveCents(value) {
  const amount = cents(value);

  if (!Number.isSafeInteger(amount) || amount <= 0) {
    return null;
  }

  return amount;
}

function getProgress(savedCents, targetCents) {
  if (!Number.isFinite(targetCents) || targetCents <= 0) {
    return 0;
  }

  return Math.min(
    100,
    Math.round((savedCents / targetCents) * 100)
  );
}

async function sendAlertSafely(userId, subject, message) {
  try {
    await sendTransactionAlert(userId, subject, message);
  } catch (error) {
    // The database transaction has already committed.
    // An email failure should not make the completed operation appear failed.
    console.error('Savings goal email alert failed:', error.message);
  }
}

async function listGoals(req, res) {
  const goals = await SavingsGoal.find({
    userId: getUserId(req)
  })
    .sort({ createdAt: -1 })
    .lean();

  return res.json({
    goals: goals.map(goal => ({
      ...goal,
      id: String(goal._id),
      target: money(goal.targetCents),
      saved: money(goal.savedCents),
      progress: getProgress(goal.savedCents, goal.targetCents)
    }))
  });
}

async function createGoal(req, res) {
  const name = String(req.body.name || '')
    .trim()
    .slice(0, 60);

  const targetCents = parsePositiveCents(req.body.target);

  if (name.length < 2 || !targetCents) {
    return res.status(400).json({
      error: 'Enter a goal name and a valid target amount.'
    });
  }

  const goal = await SavingsGoal.create({
    userId: getUserId(req),
    name,
    targetCents
  });

  return res.status(201).json({
    goal: {
      id: String(goal._id),
      name: goal.name,
      target: money(goal.targetCents),
      saved: money(0),
      progress: 0
    }
  });
}

async function contribute(req, res) {
  const userId = getUserId(req);
  const amount = parsePositiveCents(req.body.amount);

  if (!amount) {
    return res.status(400).json({
      error: 'Enter a valid contribution amount.'
    });
  }

  const dbSession = await mongoose.startSession();
  let saved;
  let goalName;

  try {
    await dbSession.withTransaction(async () => {
      const goal = await SavingsGoal.findOne({
        _id: req.params.id,
        userId
      }).session(dbSession);

      const account = await Account.findOne({
        userId,
        accountType: 'checking'
      }).session(dbSession);

      if (!goal || !account) {
        throw createHttpError(
          'Goal or checking account not found.',
          404
        );
      }

      if (goal.status === 'archived') {
        throw createHttpError('This savings goal is archived.');
      }

      if (account.status !== 'active') {
        throw createHttpError('This account is frozen.');
      }

      if (account.balanceCents < amount) {
        throw createHttpError(
          'Insufficient balance for this contribution.'
        );
      }

      account.balanceCents -= amount;
      goal.savedCents += amount;
      goal.status =
        goal.savedCents >= goal.targetCents
          ? 'complete'
          : 'active';

      saved = goal.savedCents;
      goalName = goal.name;

      await account.save({ session: dbSession });
      await goal.save({ session: dbSession });

      await LedgerEntry.create(
        [
          {
            transferGroup: `goal-${goal._id}-${crypto.randomUUID()}`,
            accountId: account._id,
            kind: 'goal_contribution',
            amountCents: amount,
            balanceAfterCents: account.balanceCents,
            description: `Saved for ${goal.name}`,
            category: 'Other'
          }
        ],
        {
          session: dbSession,
          ordered: true
        }
      );

      await notify(
        userId,
        'Savings goal updated',
        `$${money(amount)} added to ${goal.name}.`,
        dbSession
      );
    });
  } catch (error) {
    return sendError(res, error);
  } finally {
    await dbSession.endSession();
  }

  await sendAlertSafely(
    userId,
    'Savings goal contribution',
    `$${money(amount)} was added to ${goalName || 'your savings goal'}.`
  );

  return res.json({
    message: 'Contribution added.',
    saved: money(saved)
  });
}

async function withdraw(req, res) {
  const userId = getUserId(req);
  const amount = parsePositiveCents(req.body.amount);

  if (!amount) {
    return res.status(400).json({
      error: 'Enter a valid withdrawal amount.'
    });
  }

  const dbSession = await mongoose.startSession();
  let saved;
  let goalName;

  try {
    await dbSession.withTransaction(async () => {
      const goal = await SavingsGoal.findOne({
        _id: req.params.id,
        userId
      }).session(dbSession);

      const account = await Account.findOne({
        userId,
        accountType: 'checking'
      }).session(dbSession);

      if (!goal || !account) {
        throw createHttpError(
          'Goal or checking account not found.',
          404
        );
      }

      if (account.status !== 'active') {
        throw createHttpError(
          'This account is frozen. Funds cannot be moved into it.'
        );
      }

      if (goal.savedCents < amount) {
        throw createHttpError(
          'The goal does not have enough saved funds.'
        );
      }

      goal.savedCents -= amount;
      goal.status =
        goal.savedCents >= goal.targetCents
          ? 'complete'
          : 'active';

      account.balanceCents += amount;

      saved = goal.savedCents;
      goalName = goal.name;

      await goal.save({ session: dbSession });
      await account.save({ session: dbSession });

      await LedgerEntry.create(
        [
          {
            transferGroup: `goal-${goal._id}-${crypto.randomUUID()}`,
            accountId: account._id,
            kind: 'goal_withdrawal',
            amountCents: amount,
            balanceAfterCents: account.balanceCents,
            description: `Withdrawn from ${goal.name}`,
            category: 'Other'
          }
        ],
        {
          session: dbSession,
          ordered: true
        }
      );

      await notify(
        userId,
        'Savings goal withdrawal',
        `$${money(amount)} moved back to checking from ${goal.name}.`,
        dbSession
      );
    });
  } catch (error) {
    return sendError(res, error);
  } finally {
    await dbSession.endSession();
  }

  await sendAlertSafely(
    userId,
    'Savings goal withdrawal',
    `$${money(amount)} was moved back to checking from ${goalName || 'your savings goal'}.`
  );

  return res.json({
    message: 'Funds moved back to checking.',
    saved: money(saved)
  });
}

module.exports = {
  listGoals,
  createGoal,
  contribute,
  withdraw
};
