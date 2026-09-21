import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RunRecord, TwoPortNetwork } from '../common/types.js';

export type OperationLog = {
  id: number;
  createdAt: string;
  action: string;
  detail: string;
};

const migrate = (database: DatabaseSync): void => {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS networks (
      name TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS runs (
      run_id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS operation_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      action TEXT NOT NULL,
      detail TEXT NOT NULL
    );
  `);
};

export class AppDatabase {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    migrate(this.database);
  }

  close(): void {
    this.database.close();
  }

  upsertNetwork(network: TwoPortNetwork): void {
    this.database
      .prepare(
        `INSERT INTO networks (name, type, payload, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET type = excluded.type, payload = excluded.payload, created_at = excluded.created_at`,
      )
      .run(network.name, network.type, JSON.stringify({ ...network, sourceText: undefined }), new Date().toISOString());
    this.log('upsert-network', `${network.type}:${network.name}`);
  }

  listNetworks(): TwoPortNetwork[] {
    const rows = this.database.prepare('SELECT payload FROM networks ORDER BY type, name').all() as Array<{ payload: string }>;
    return rows.map((row) => JSON.parse(row.payload) as TwoPortNetwork);
  }

  listNetworksByType(type: TwoPortNetwork['type']): TwoPortNetwork[] {
    const rows = this.database.prepare('SELECT payload FROM networks WHERE type = ? ORDER BY name').all(type) as Array<{ payload: string }>;
    return rows.map((row) => JSON.parse(row.payload) as TwoPortNetwork);
  }

  getNetwork(name: string): TwoPortNetwork | undefined {
    const row = this.database.prepare('SELECT payload FROM networks WHERE name = ?').get(name) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as TwoPortNetwork) : undefined;
  }

  countNetworks(): number {
    const row = this.database.prepare('SELECT COUNT(*) AS count FROM networks').get() as { count: number | bigint };
    return Number(row.count);
  }

  saveRun(record: RunRecord): void {
    this.database
      .prepare(
        `INSERT INTO runs (run_id, payload, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(run_id) DO UPDATE SET payload = excluded.payload, created_at = excluded.created_at`,
      )
      .run(record.runId, JSON.stringify(record), record.createdAt);
    this.log('save-run', record.runId);
  }

  listRuns(): RunRecord[] {
    const rows = this.database.prepare('SELECT payload FROM runs ORDER BY created_at DESC, run_id DESC').all() as Array<{ payload: string }>;
    return rows.map((row) => JSON.parse(row.payload) as RunRecord);
  }

  getRun(runId: string): RunRecord | undefined {
    const row = this.database.prepare('SELECT payload FROM runs WHERE run_id = ?').get(runId) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as RunRecord) : undefined;
  }

  log(action: string, detail: string): void {
    this.database.prepare('INSERT INTO operation_logs (action, detail) VALUES (?, ?)').run(action, detail);
  }

  listLogs(limit = 200): OperationLog[] {
    const rows = this.database
      .prepare('SELECT id, created_at, action, detail FROM operation_logs ORDER BY id DESC LIMIT ?')
      .all(limit) as Array<{ id: number | bigint; created_at: string; action: string; detail: string }>;
    return rows.map((row) => ({
      id: Number(row.id),
      createdAt: row.created_at,
      action: row.action,
      detail: row.detail,
    }));
  }

  clearAll(): void {
    this.database.exec('DELETE FROM runs; DELETE FROM networks; DELETE FROM operation_logs;');
    this.log('clear-database', 'all networks, runs, and logs cleared');
  }

  exportAll(): {
    exportedAt: string;
    networks: TwoPortNetwork[];
    runs: RunRecord[];
    logs: OperationLog[];
  } {
    return {
      exportedAt: new Date().toISOString(),
      networks: this.listNetworks(),
      runs: this.listRuns(),
      logs: this.listLogs(1000),
    };
  }
}
