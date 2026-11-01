import scheduledTransferService from '../../services/scheduledTransferService.js';
import database from '../../config/database.js';

export default async () => {
  await database.connectDatabase();
  await scheduledTransferService.processDueTransfers();
  return new Response('Scheduled transfers processed.', { status: 200 });
};

export const config = { schedule: '* * * * *' };
