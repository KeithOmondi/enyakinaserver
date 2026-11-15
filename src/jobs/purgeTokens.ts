import { query } from '../config/db';

const HOUR_MS = 60 * 60 * 1000;

/** Deletes refresh tokens that expired (or were revoked) more than a day ago. Runs hourly. */
export function startTokenPurge(): void {
  const run = () =>
    query(
      `DELETE FROM refresh_tokens
        WHERE expires_at < now() - interval '1 day' OR revoked_at < now() - interval '1 day'`,
    ).catch((err: Error) => console.error('[jobs] token purge failed:', err.message));
  void run();
  setInterval(run, HOUR_MS).unref();
}
