/**
 * Forward-only SQL migration runner.
 *
 *   npm run migrate              apply all pending migrations
 *   npm run migrate:status       list applied / pending migrations
 *   npm run migrate:create name  create src/db/migrations/<NNNN>_<name>.sql (next number)
 *
 * Rules:
 * - Files in ./migrations named NNNN..._description.sql run in lexical order.
 * - Each file runs in its own transaction and is recorded in schema_migrations
 *   with a SHA-256 checksum. Editing an applied file is detected and refused:
 *   write a new migration instead.
 * - A Postgres advisory lock stops two processes migrating at once.
 * - No "down" migrations: on a live POS, rollbacks are done with a new forward migration.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { PoolClient } from 'pg';
import { pool } from '../config/db';

export const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const LOCK_KEY = 7_331_001; // arbitrary constant, unique to this app
const FILE_PATTERN = /^\d{4,}_[a-z0-9_]+\.sql$/;

interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

export interface MigrateOptions {
  dir?: string;
  /** Tracking table name. Only tests override this. */
  table?: string;
  log?: (msg: string) => void;
}

function resolveOptions(o: MigrateOptions) {
  const table = o.table ?? 'schema_migrations';
  if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error(`Invalid migrations table "${table}"`);
  return { dir: o.dir ?? MIGRATIONS_DIR, table, log: o.log ?? console.log };
}

interface AppliedRow {
  name: string;
  checksum: string;
  applied_at: Date;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function readMigrationFiles(dir = MIGRATIONS_DIR): MigrationFile[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql'));
  const bad = files.filter((f) => !FILE_PATTERN.test(f));
  if (bad.length) {
    throw new Error(
      `Invalid migration file name(s): ${bad.join(', ')}. Expected e.g. 0001_create_users.sql`,
    );
  }
  return files.sort().map((name) => {
    const sql = readFileSync(path.join(dir, name), 'utf8');
    return { name, sql, checksum: sha256(sql) };
  });
}

async function ensureMigrationsTable(client: PoolClient, table: string): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${table} (
      name        text PRIMARY KEY,
      checksum    char(64) NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function getApplied(client: PoolClient, table: string): Promise<Map<string, AppliedRow>> {
  const { rows } = await client.query<AppliedRow>(
    `SELECT name, checksum, applied_at FROM ${table} ORDER BY name`,
  );
  return new Map(rows.map((r) => [r.name, r]));
}

function verifyChecksums(files: MigrationFile[], applied: Map<string, AppliedRow>): void {
  for (const file of files) {
    const row = applied.get(file.name);
    if (row && row.checksum !== file.checksum) {
      throw new Error(
        `Migration ${file.name} was modified after it was applied. ` +
          'Revert the file and create a new migration for the change.',
      );
    }
  }
  const known = new Set(files.map((f) => f.name));
  for (const name of applied.keys()) {
    if (!known.has(name)) {
      throw new Error(`Migration ${name} is recorded in the database but its file is missing.`);
    }
  }
}

export async function migrateUp(options: MigrateOptions = {}): Promise<string[]> {
  const { dir, table, log } = resolveOptions(options);
  const files = readMigrationFiles(dir);
  const client = await pool.connect();
  const ran: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    // Schema changes on a big table can exceed the pool's request-oriented timeout.
    await client.query('SET statement_timeout = 0');
    await ensureMigrationsTable(client, table);
    const applied = await getApplied(client, table);
    verifyChecksums(files, applied);

    const pending = files.filter((f) => !applied.has(f.name));
    if (pending.length === 0) {
      log('No pending migrations.');
      return ran;
    }

    for (const file of pending) {
      log(`Applying ${file.name} ...`);
      try {
        await client.query('BEGIN');
        await client.query(file.sql);
        await client.query(`INSERT INTO ${table} (name, checksum) VALUES ($1, $2)`, [
          file.name,
          file.checksum,
        ]);
        await client.query('COMMIT');
        ran.push(file.name);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file.name} failed: ${(err as Error).message}`);
      }
    }
    log(`Applied ${ran.length} migration(s).`);
    return ran;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}

export async function migrationStatus(options: MigrateOptions = {}): Promise<void> {
  const { dir, table, log } = resolveOptions(options);
  const files = readMigrationFiles(dir);
  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client, table);
    const applied = await getApplied(client, table);
    if (files.length === 0) log('No migration files found.');
    for (const file of files) {
      const row = applied.get(file.name);
      const state = !row
        ? 'pending'
        : row.checksum === file.checksum
          ? `applied ${row.applied_at.toISOString()}`
          : 'MODIFIED AFTER APPLY';
      log(`${file.name.padEnd(50)} ${state}`);
    }
    for (const name of applied.keys()) {
      if (!files.some((f) => f.name === name)) log(`${name.padEnd(50)} MISSING FILE`);
    }
  } finally {
    client.release();
  }
}

export function createMigration(rawName: string, dir = MIGRATIONS_DIR): string {
  const slug = rawName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
  if (!slug) throw new Error('Usage: npm run migrate:create <name>');
  const existing = readMigrationFiles(dir);
  const last = existing.at(-1)?.name.split('_')[0] ?? '0000';
  const next = String(Number(last) + 1).padStart(4, '0');
  const file = path.join(dir, `${next}_${slug}.sql`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, `-- ${next}_${slug}\n\n`);
  return file;
}

async function main(): Promise<void> {
  const [command = 'up', ...rest] = process.argv.slice(2);
  try {
    switch (command) {
      case 'up':
        await migrateUp();
        break;
      case 'status':
        await migrationStatus();
        break;
      case 'create':
        console.log(`Created ${createMigration(rest.join(' '))}`);
        return;
      default:
        throw new Error(`Unknown command "${command}". Use up | status | create <name>.`);
    }
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  void main();
}
