const Beneficiary = require('../models/Beneficiary');
const Account = require('../models/Account');
const User = require('../models/User');

async function list(req, res) {
  const items = await Beneficiary.find({ userId: req.session.user.id }).sort({ updatedAt: -1 }).limit(50).lean();
  res.json({ beneficiaries: items.map(item => ({ id: String(item._id), accountNumber: item.accountNumber, name: item.name })) });
}

async function add(req, res) {
  const number = String(req.body.accountNumber || '').replace(/\s/g, '');
  if (!/^\d{10}$/.test(number)) return res.status(400).json({ error: 'Enter a 10-digit account number.' });
  const account = await Account.findOne({ accountNumber: number }).select('userId').lean();
  const owner = account ? await User.findOne({ _id: account.userId, verified: true }).select('name').lean() : null;
  if (!owner || String(account.userId) === String(req.session.user.id)) return res.status(404).json({ error: 'No Harborline account matches this number.' });
  if (await Beneficiary.countDocuments({ userId: req.session.user.id }) >= 50) return res.status(400).json({ error: 'You can save up to 50 recipients.' });
  const item = await Beneficiary.findOneAndUpdate({ userId: req.session.user.id, accountNumber: number }, { $set: { name: owner.name } }, { upsert: true, new: true });
  res.status(201).json({ beneficiary: { id: String(item._id), accountNumber: item.accountNumber, name: item.name } });
}

async function remove(req, res) {
  const result = await Beneficiary.deleteOne({ _id: req.params.id, userId: req.session.user.id });
  if (!result.deletedCount) return res.status(404).json({ error: 'Saved recipient not found.' });
  res.json({ message: 'Recipient removed.' });
}

module.exports = { list, add, remove };
