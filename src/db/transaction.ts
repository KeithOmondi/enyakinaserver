import type { PoolClient } from 'pg';
import { pool } from '../config/db';

export type TxClient = PoolClient;

export interface TransactionOptions {
  isolationLevel?: 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';
}

/**
 * Runs `fn` inside a single database transaction.
 * Commits if `fn` resolves, rolls back if it throws, and always releases the client.
 *
 * Every stock change (ledger insert + stock_levels update) and every checkout
 * must go through this helper so they are atomic.
 */
export async function withTransaction<T>(
  fn: (client: TxClient) => Promise<T>,
  options: TransactionOptions = {},
): Promise<T> {
  const client = await pool.connect();
  let brokenConnection: Error | undefined;
  try {
    await client.query(
      options.isolationLevel ? `BEGIN ISOLATION LEVEL ${options.isolationLevel}` : 'BEGIN',
    );
    // Timeouts that stop a stuck query or an abandoned transaction from holding row locks (and
    // so blocking sales) forever. SET LOCAL lasts for this transaction only, which is also what
    // makes it work through a transaction pooler.
    await client.query('SET LOCAL statement_timeout = 30000; SET LOCAL idle_in_transaction_session_timeout = 60000');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      // The connection is unusable; tell the pool to destroy it instead of reusing it.
      brokenConnection = rollbackErr as Error;
    }
    throw err;
  } finally {
    client.release(brokenConnection);
  }
}
