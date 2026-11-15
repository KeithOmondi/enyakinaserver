// Copies SQL migration and seed files into dist/ after `tsc`, so the compiled
// migration runner can find them at dist/db/migrations and dist/db/seeds.
import { cpSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

for (const dir of ['migrations', 'seeds']) {
  const from = resolve('src/db', dir);
  const to = resolve('dist/db', dir);
  if (existsSync(from)) {
    cpSync(from, to, { recursive: true, filter: (src) => !src.endsWith('.ts') });
  }
}
