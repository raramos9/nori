import { setTimeout as sleep } from 'node:timers/promises';
import { openWriteDatabase } from '../store/database.js';

const [path, label, iterations, startAt] = process.argv.slice(2);
if (path === undefined || label === undefined || iterations === undefined || startAt === undefined) {
  throw new Error('usage: concurrent-writer <db path> <label> <iterations> <start epoch ms>');
}
await sleep(Math.max(0, Number(startAt) - Date.now()));
const db = await openWriteDatabase({ path });
try {
  for (let i = 0; i < Number(iterations); i++) {
    await db.transaction().execute(async (trx) => {
      const seen = await trx.selectFrom('applications').select('id').execute();
      await sleep(1);
      await trx
        .insertInto('applications')
        .values({ id: `${label}-${i}-${seen.length}`, repo_identity: label, subpath: '', framework: 'next-app-router' })
        .execute();
    });
  }
} finally {
  await db.destroy();
}
