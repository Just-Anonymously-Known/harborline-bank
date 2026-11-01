const crypto = require('crypto');
const DeviceSession = require('../models/DeviceSession');

function establishSession(req, user) {
  return new Promise((resolve, reject) => {
    req.session.regenerate(async error => {
      if (error) return reject(error);
      req.session.user = { id: String(user._id), role: user.role, adminRole: user.adminRole || 'operations', verified: true };
      req.session.csrf = crypto.randomBytes(32).toString('hex');
      req.session.save(async saveError => {
        if (saveError) return reject(saveError);
        try {
          await DeviceSession.create({
            userId: user._id,
            sessionId: req.sessionID,
            label: String(req.get('user-agent') || 'Unknown device').slice(0, 160),
            lastSeenAt: new Date()
          });
          resolve({ csrf: req.session.csrf });
        } catch (deviceError) { reject(deviceError); }
      });
    });
  });
}

module.exports = { establishSession };
