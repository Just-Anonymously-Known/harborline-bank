const express = require('express');
const maintenanceController = require('../controllers/maintenanceController');

const router = express.Router();
router.get('/', maintenanceController.getPublicNotice);

module.exports = router;
