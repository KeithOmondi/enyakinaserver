import { createApp } from './app';
import { checkDbConnection, closePool } from './config/db';
import { env } from './config/env';
import { startTokenPurge } from './jobs/purgeTokens';

const SHUTDOWN_TIMEOUT_MS = 10_000;

const DB_ATTEMPTS = 15;
const DB_RETRY_MS = 2_000;

/** Why a connection failed. Node's connection errors often have an empty `message`. */
function describe(err: unknown): string {
  const e = err as { message?: string; code?: string; errors?: { code?: string }[] };
  const code = e.code ?? e.errors?.[0]?.code;
  return [e.message, code].filter(Boolean).join(' ') || 'no response (is the database running?)';
}

/**
 * After a reboot the API often starts before Postgres (or Docker) is ready. Wait for it
 * instead of dying, so no one has to restart the API by hand.
 */
async function waitForDatabase(): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await checkDbConnection();
      return;
    } catch (err) {
      if (attempt >= DB_ATTEMPTS) {
        console.error(`[server] cannot reach the database after ${DB_ATTEMPTS} tries: ${describe(err)}`);
        process.exit(1);
      }
      console.warn(`[server] database not ready (${describe(err)}), retrying in ${DB_RETRY_MS / 1000}s (${attempt}/${DB_ATTEMPTS})`);
      await new Promise((resolve) => setTimeout(resolve, DB_RETRY_MS));
    }
  }
}

async function start(): Promise<void> {
  await waitForDatabase();

  startTokenPurge();
  const app = createApp();
  const server = app.listen(env.PORT, () => {
    console.log(`[server] listening on :${env.PORT} (${env.NODE_ENV})`);
  });

  // Longer than typical reverse-proxy keep-alive (nginx 75s, ALB 60s) so the proxy,
  // not Node, closes idle sockets; otherwise sporadic 502s appear under load.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.requestTimeout = 30_000;

  server.on('error', (err: NodeJS.ErrnoException) => {
    console.error(
      err.code === 'EADDRINUSE'
        ? `[server] port ${env.PORT} is already in use`
        : `[server] listen error: ${err.message}`,
    );
    process.exit(1);
  });

  let shuttingDown = false;
  const shutdown = (reason: string, exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[server] ${reason}, shutting down`);
    // Force exit if connections do not drain in time.
    setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS).unref();
    server.close(async () => {
      try {
        await closePool();
      } finally {
        process.exit(exitCode);
      }
    });
    // Keep-alive sockets would otherwise hold close() open until the timeout.
    server.closeIdleConnections();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // After either of these Node's state is undefined; log, drain, and let the
  // process manager restart us rather than limp on.
  process.on('unhandledRejection', (reason) => {
    console.error('[server] unhandled rejection', reason);
    shutdown('unhandledRejection', 1);
  });
  process.on('uncaughtException', (err) => {
    console.error('[server] uncaught exception', err);
    shutdown('uncaughtException', 1);
  });
}

void start();
