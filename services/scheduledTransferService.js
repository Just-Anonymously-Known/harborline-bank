const crypto = require('crypto');
const mongoose = require('mongoose');
const ScheduledTransfer = require('../models/ScheduledTransfer');
const Account = require('../models/Account');
const User = require('../models/User');
const LedgerEntry = require('../models/LedgerEntry');
const { money } = require('../utils/finance');
const { notify } = require('./notificationService');
const { sendTransactionAlert } = require('./emailAlertService');

async function processDueTransfers() {
  const now = new Date();
  const recoverBefore = new Date(now.getTime() - 5 * 60 * 1000);
  for (let count = 0; count < 10; count++) {
    const scheduled = await ScheduledTransfer.findOneAndUpdate({
      $or: [
        { status: 'scheduled', scheduledAt: { $lte: now } },
        { status: 'processing', processingAt: { $lte: recoverBefore } }
      ]
    }, { $set: { status: 'processing', processingAt: now } }, { new: true, sort: { scheduledAt: 1 } });
    if (!scheduled) break;
    let senderName = 'Harborline customer', recipientName = 'Harborline customer', recipientUserId, completed = false;
    const dbSession = await mongoose.startSession();
    try {
      await dbSession.withTransaction(async () => {
        const job = await ScheduledTransfer.findOne({ _id: scheduled._id, status: 'processing' }).session(dbSession);
        if (!job) return;
        const accounts = await Account.find({ _id: { $in: [job.fromAccountId, job.toAccountId] } }).sort({ _id: 1 }).session(dbSession);
        const byId = new Map(accounts.map(account => [String(account._id), account]));
        const from = byId.get(String(job.fromAccountId)), to = byId.get(String(job.toAccountId));
        const owner = await User.findById(job.userId).session(dbSession);
        const recipient = to ? await User.findOne({ _id: to.userId, verified: true }).session(dbSession) : null;
        if (!from || !to || !owner || !recipient || from.status !== 'active' || to.status !== 'active') throw new Error('An account is unavailable or frozen.');
        if (from.balanceCents < job.amountCents) throw new Error('Insufficient funds on the scheduled date.');
        const accountIds = await Account.find({ userId: owner._id }).distinct('_id').session(dbSession);
        const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
        const totals = await LedgerEntry.aggregate([
          { $match: { accountId: { $in: accountIds }, kind: 'transfer_out', createdAt: { $gte: dayStart } } },
          { $group: { _id: null, total: { $sum: '$amountCents' } } }
        ]).session(dbSession);
        const limit = owner.dailyTransferLimitCents || 100000;
        if ((totals[0]?.total || 0) + job.amountCents > limit) throw new Error('The scheduled transfer exceeds the daily transfer limit.');
        senderName = owner.name; recipientName = recipient.name; recipientUserId = recipient._id;
        from.balanceCents -= job.amountCents; to.balanceCents += job.amountCents;
        await from.save({ session: dbSession }); await to.save({ session: dbSession });
        const transferGroup = crypto.randomUUID();
        await LedgerEntry.create([
          { transferGroup, accountId: from._id, counterpartyAccountId: to._id, counterpartyName: recipient.name, kind: 'transfer_out', amountCents: job.amountCents, balanceAfterCents: from.balanceCents, description: job.memo, category: job.category },
          { transferGroup, accountId: to._id, counterpartyAccountId: from._id, counterpartyName: owner.name, kind: 'transfer_in', amountCents: job.amountCents, balanceAfterCents: to.balanceCents, description: job.memo, category: job.category }
        ], { session: dbSession, ordered: true });
        job.status = 'completed'; job.processingAt = undefined; await job.save({ session: dbSession });
        completed = true;
        await notify(owner._id, 'Scheduled transfer sent', `$${money(job.amountCents)} sent to ${recipient.name}.`, dbSession);
        await notify(recipient._id, 'Transfer received', `$${money(job.amountCents)} received from ${owner.name}.`, dbSession);
      });
      if (completed) {
        await Promise.all([
          sendTransactionAlert(scheduled.userId, 'Scheduled transfer sent', `$${money(scheduled.amountCents)} sent to ${recipientName}.`),
          sendTransactionAlert(recipientUserId, 'Transfer received', `$${money(scheduled.amountCents)} received from ${senderName}.`)
        ]);
      }
    } catch (error) {
      const failed = String(error.message || 'The scheduled transfer could not be completed.').slice(0, 160);
      await ScheduledTransfer.updateOne({ _id: scheduled._id, status: 'processing' }, { $set: { status: 'failed', failureReason: failed }, $unset: { processingAt: 1 } });
    } finally { await dbSession.endSession(); }
  }
}

module.exports = { processDueTransfers };
