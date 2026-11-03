const MaintenanceNotice = require('../models/MaintenanceNotice');
const User = require('../models/User');
const MailLog = require('../models/MailLog');

const { mailer, sendMail, checkMailer } = require('../services/emailService');
const { recordAdminAction } = require('../services/auditService');

const NOTICE_ID = 'global';
const MAX_TITLE_LENGTH = 120;
const MAX_MESSAGE_LENGTH = 1000;
const MAX_RECIPIENTS = 500;

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[character]));
}

function getAdminId(req) {
  return req.session?.user?.id;
}

function isValidDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function formatUtcDate(date) {
  return date.toLocaleString('en-US', {
    timeZone: 'UTC',
    timeZoneName: 'UTC'
  });
}

function sendError(res, error, fallbackMessage = 'Something went wrong.') {
  console.error('[maintenanceController]', error);

  if (res.headersSent) return;

  res.status(500).json({ error: fallbackMessage });
}

async function getPublicNotice(req, res) {
  try {
    const now = new Date();

    const notice = await MaintenanceNotice.findById(NOTICE_ID).lean();

    if (
      !notice ||
      !notice.active ||
      (notice.endsAt && notice.endsAt <= now)
    ) {
      return res.json({ notice: null });
    }

    res.json({
      notice: {
        title: notice.title,
        message: notice.message,
        startsAt: notice.startsAt,
        endsAt: notice.endsAt,
        activeNow: !notice.startsAt || notice.startsAt <= now
      }
    });
  } catch (error) {
    sendError(res, error, 'Unable to load the maintenance notice.');
  }
}

async function getAdminNotice(req, res) {
  try {
    const notice = await MaintenanceNotice.findById(NOTICE_ID).lean();

    res.json({
      notice: notice
        ? {
            active: notice.active,
            title: notice.title,
            message: notice.message,
            startsAt: notice.startsAt,
            endsAt: notice.endsAt
          }
        : null
    });
  } catch (error) {
    sendError(res, error, 'Unable to load the maintenance notice.');
  }
}

async function scheduleNotice(req, res) {
  try {
    const adminId = getAdminId(req);

    if (!adminId) {
      return res.status(401).json({ error: 'Admin authentication required.' });
    }

    const title = String(req.body?.title || '')
      .trim()
      .slice(0, MAX_TITLE_LENGTH);

    const message = String(req.body?.message || '')
      .trim()
      .slice(0, MAX_MESSAGE_LENGTH);

    const startsAt = isValidDate(req.body?.startsAt);
    const endsAt = isValidDate(req.body?.endsAt);

    if (
      title.length < 3 ||
      message.length < 3 ||
      !startsAt ||
      !endsAt ||
      endsAt <= startsAt
    ) {
      return res.status(400).json({
        error: 'Add a title, message, and valid start and end times.'
      });
    }

    if (!mailer) {
      return res.status(503).json({
        error: 'Configure SMTP before sending a maintenance email.'
      });
    }

    const smtp = await checkMailer();

    if (!smtp?.ready) {
      return res.status(503).json({
        error: smtp?.reason || 'SMTP is not ready.'
      });
    }

    // Save the notice before attempting email delivery.
    const notice = await MaintenanceNotice.findByIdAndUpdate(
      NOTICE_ID,
      {
        $set: {
          active: true,
          title,
          message,
          startsAt,
          endsAt,
          updatedBy: adminId
        },
        $setOnInsert: {
          _id: NOTICE_ID
        }
      },
      {
        new: true,
        upsert: true,
        runValidators: true,
        setDefaultsOnInsert: true
      }
    );

    const recipients = await User.find({
      role: 'customer',
      verified: true,
      email: { $type: 'string', $ne: '' }
    })
      .select('email')
      .sort({ createdAt: 1 })
      .limit(MAX_RECIPIENTS)
      .lean();

    const startLabel = formatUtcDate(startsAt);
    const endLabel = formatUtcDate(endsAt);
    const subject = `Scheduled maintenance: ${title}`;

    const escapedMessage = escapeHtml(message);

    const recipientResults = [];

    for (const recipient of recipients) {
      try {
        const info = await sendMail({
          to: recipient.email,
          subject: `[Harborline service notice] ${subject}`,
          text:
            `${message}\n\n` +
            `Scheduled from ${startLabel} until ${endLabel}.`,
          html:
            `<p>${escapedMessage}</p>` +
            `<p>Scheduled from ${escapeHtml(startLabel)} ` +
            `until ${escapeHtml(endLabel)}.</p>`
        });

        if (info?.rejected?.length) {
          throw new Error('SMTP rejected the recipient address.');
        }

        recipientResults.push({
          email: recipient.email,
          status: 'sent'
        });
      } catch (error) {
        console.error(
          `[maintenanceController] Email failed for ${recipient.email}:`,
          error
        );

        recipientResults.push({
          email: recipient.email,
          status: 'failed',
          error: error.message || 'Email delivery failed.'
        });
      }
    }

    const deliveredCount = recipientResults.filter(
      item => item.status === 'sent'
    ).length;

    const failedCount = recipientResults.length - deliveredCount;

    const deliveryStatus =
      failedCount === 0
        ? 'sent'
        : deliveredCount > 0
          ? 'partial'
          : 'failed';

    // Log delivery results separately from the notice itself.
    try {
      await MailLog.create({
        adminId,
        subject,
        recipientCount: recipients.length,
        deliveredCount,
        failedCount,
        deliveryStatus,
        recipientResults,
        kind: 'maintenance'
      });
    } catch (error) {
      console.error('[maintenanceController] MailLog creation failed:', error);
    }

    // Audit failure should not undo the saved notice or email attempts.
    try {
      await recordAdminAction(
        req,
        'schedule_maintenance',
        NOTICE_ID,
        {
          title,
          startsAt,
          endsAt,
          recipientCount: recipients.length,
          deliveredCount,
          failedCount
        }
      );
    } catch (error) {
      console.error('[maintenanceController] Audit logging failed:', error);
    }

    res.json({
      message:
        `Maintenance notice scheduled: ${deliveredCount} emails sent, ` +
        `${failedCount} failed.`,
      deliveryStatus,
      deliveredCount,
      failedCount,
      notice: {
        active: notice.active,
        title: notice.title,
        startsAt: notice.startsAt,
        endsAt: notice.endsAt
      }
    });
  } catch (error) {
    sendError(res, error, 'Unable to schedule the maintenance notice.');
  }
}

async function cancelNotice(req, res) {
  try {
    const adminId = getAdminId(req);

    if (!adminId) {
      return res.status(401).json({ error: 'Admin authentication required.' });
    }

    const notice = await MaintenanceNotice.findByIdAndUpdate(
      NOTICE_ID,
      {
        $set: {
          active: false,
          updatedBy: adminId
        }
      },
      {
        new: true,
        runValidators: true
      }
    );

    if (!notice) {
      return res.status(404).json({
        error: 'No maintenance notice is scheduled.'
      });
    }

    try {
      await recordAdminAction(
        req,
        'cancel_maintenance',
        NOTICE_ID,
        { title: notice.title }
      );
    } catch (error) {
      console.error('[maintenanceController] Audit logging failed:', error);
    }

    res.json({ message: 'Maintenance notice cancelled.' });
  } catch (error) {
    sendError(res, error, 'Unable to cancel the maintenance notice.');
  }
}

module.exports = {
  getPublicNotice,
  getAdminNotice,
  scheduleNotice,
  cancelNotice
};