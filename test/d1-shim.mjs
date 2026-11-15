// A D1-shaped wrapper over node:sqlite, enough for the calls src/store.js makes.

import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const clean = (v) => (v === undefined ? null : typeof v === 'boolean' ? Number(v) : v);

class Statement {
  constructor(sqlite, sql, args = []) { this.sqlite = sqlite; this.sql = sql; this.args = args; }
  bind(...args) { return new Statement(this.sqlite, this.sql, args.map(clean)); }
  runSync() {
    const r = this.sqlite.prepare(this.sql).run(...this.args);
    return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
  async run() { return this.runSync(); }
  async all() { return { success: true, results: this.sqlite.prepare(this.sql).all(...this.args).map((r) => ({ ...r })) }; }
  async first() { const r = this.sqlite.prepare(this.sql).get(...this.args); return r ? { ...r } : null; }
}

export async function createDb() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  const dir = path.join(import.meta.dirname, '..', 'migrations');
  for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
    if (f.includes('seed')) continue; // tests insert their own sources
    sqlite.exec(await readFile(path.join(dir, f), 'utf8'));
  }
  return {
    sqlite,
    prepare: (sql) => new Statement(sqlite, sql),
    async batch(stmts) {
      sqlite.exec('BEGIN');
      try {
        // Synchronous on purpose: a D1 batch is atomic, so concurrent batches must not interleave.
        const out = stmts.map((s) => s.runSync());
        sqlite.exec('COMMIT');
        return out;
      } catch (err) { sqlite.exec('ROLLBACK'); throw err; }
    },
  };
}
