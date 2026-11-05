const express = require('express');
const adminController = require('../controllers/adminController');
const internationalController = require('../controllers/internationalController');
const maintenanceController = require('../controllers/maintenanceController');
const { requireAuth, requireAdmin, requirePermission, requireAuditReason } = require('../middleware/sessionAccess');

const router = express.Router();
router.use(requireAuth, requireAdmin);
router.get('/accounts/:id/statement', adminController.downloadAccountStatement);
router.get('/admins', requirePermission('owner'), async (req, res) => {
  const User = require('../models/User');
  const admins = await User.find({ role: 'admin' }).select('name email adminRole createdAt').sort({ createdAt: 1 }).lean();
  res.json({ admins });
});
router.post('/admins', requirePermission('owner'), requireAuditReason, adminController.createAdmin);
router.patch('/admins/:id/role', requirePermission('owner'), requireAuditReason, adminController.setAdminRole);
router.get('/international', requirePermission('owner', 'operations'), internationalController.listAdmin);
router.post('/international/:id/decision', requirePermission('owner', 'operations'), requireAuditReason, internationalController.decide);
router.get('/accounts', adminController.listAccounts);
router.get('/transfer-reviews', adminController.listTransferReviews);
router.post('/transfer-reviews/:id/decision', requirePermission('owner', 'operations'), requireAuditReason, adminController.resolveTransferReview);
router.post('/fund', requirePermission('owner', 'operations'), requireAuditReason, adminController.fundAccount);
router.post('/accounts/create', requirePermission('owner', 'operations'), requireAuditReason, adminController.createAccount);
router.patch('/accounts/:id/account-number', requirePermission('owner', 'operations'), requireAuditReason, adminController.setAccountNumber);
router.patch('/accounts/:id/status', requirePermission('owner', 'operations'), requireAuditReason, adminController.setAccountStatus);
router.get('/accounts/:id/activity', adminController.accountActivity);
router.patch('/users/:id/transfer-limit', requirePermission('owner', 'operations'), requireAuditReason, adminController.setTransferLimit);
router.patch('/users/:id/review-threshold', requirePermission('owner', 'operations'), requireAuditReason, adminController.setTransferReviewThreshold);
router.post('/email', requirePermission('owner', 'operations'), requireAuditReason, adminController.emailCustomers);
router.get('/email-status', requirePermission('owner', 'operations'), adminController.emailStatus);
router.get('/email-history', adminController.emailHistory);
router.get('/audit', adminController.auditHistory);
router.get('/maintenance', maintenanceController.getAdminNotice);
router.post('/maintenance', requirePermission('owner', 'operations'), requireAuditReason, maintenanceController.scheduleNotice);
router.post('/maintenance/cancel', requirePermission('owner', 'operations'), requireAuditReason, maintenanceController.cancelNotice);

module.exports = router;
