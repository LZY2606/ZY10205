import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * SQLite 持久层。
 * 表：
 *   fixtures    导入/内置的 Touchstone（存原文，便于清空后重新导入复核）
 *   runs        去嵌方案（请求参数 + 结果报告 JSON）
 * 所有结果可导出为单个 JSON，清空后重新导入即可复算比对。
 */
export interface FixtureRow {
  id: number;
  name: string;
  role: string; // left | right | measured | dut | unknown
  touchstone: string;
  points: number;
  f_start_hz: number;
  f_stop_hz: number;
  z0: number;
  source: string; // builtin | import
  created_at: string;
}

export interface RunRow {
  id: number;
  name: string;
  request_json: string;
  report_json: string;
  fingerprint: string;
  created_at: string;
}

export function openDb(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA foreign_keys=ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS fixtures (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      touchstone TEXT NOT NULL,
      points INTEGER NOT NULL,
      f_start_hz REAL NOT NULL,
      f_stop_hz REAL NOT NULL,
      z0 REAL NOT NULL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      request_json TEXT NOT NULL,
      report_json TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

export function upsertBuiltinFixture(
  db: DatabaseSync,
  f: Omit<FixtureRow, "id" | "created_at">,
): number {
  const existing = db
    .prepare("SELECT id FROM fixtures WHERE name = ? AND source = 'builtin'")
    .get(f.name) as { id: number } | undefined;
  if (existing) {
    db.prepare(
      `UPDATE fixtures SET role=?, touchstone=?, points=?, f_start_hz=?, f_stop_hz=?, z0=?
       WHERE id=?`,
    ).run(f.role, f.touchstone, f.points, f.f_start_hz, f.f_stop_hz, f.z0, existing.id);
    return existing.id;
  }
  const res = db
    .prepare(
      `INSERT INTO fixtures (name, role, touchstone, points, f_start_hz, f_stop_hz, z0, source)
       VALUES (?,?,?,?,?,?,?, 'builtin')`,
    )
    .run(f.name, f.role, f.touchstone, f.points, f.f_start_hz, f.f_stop_hz, f.z0);
  return Number(res.lastInsertRowid);
}

export type FixtureInput = Omit<FixtureRow, "id" | "created_at" | "source">;
export function insertImportedFixture(db: DatabaseSync, f: FixtureInput): number {
  const res = db
    .prepare(
      `INSERT INTO fixtures (name, role, touchstone, points, f_start_hz, f_stop_hz, z0, source)
       VALUES (?,?,?,?,?,?,?, 'import')`,
    )
    .run(f.name, f.role, f.touchstone, f.points, f.f_start_hz, f.f_stop_hz, f.z0);
  return Number(res.lastInsertRowid);
}

export function listFixtures(db: DatabaseSync): FixtureRow[] {
  return db.prepare("SELECT * FROM fixtures ORDER BY id").all() as unknown as FixtureRow[];
}

export function getFixture(db: DatabaseSync, id: number): FixtureRow | undefined {
  return db.prepare("SELECT * FROM fixtures WHERE id=?").get(id) as unknown as FixtureRow | undefined;
}

export function insertRun(
  db: DatabaseSync,
  name: string,
  requestJson: string,
  reportJson: string,
  fingerprint: string,
): number {
  const res = db
    .prepare("INSERT INTO runs (name, request_json, report_json, fingerprint) VALUES (?,?,?,?)")
    .run(name, requestJson, reportJson, fingerprint);
  return Number(res.lastInsertRowid);
}

export function listRuns(db: DatabaseSync): RunRow[] {
  return db.prepare("SELECT * FROM runs ORDER BY id").all() as unknown as RunRow[];
}
export function getRun(db: DatabaseSync, id: number): RunRow | undefined {
  return db.prepare("SELECT * FROM runs WHERE id=?").get(id) as unknown as RunRow | undefined;
}

export function clearAll(db: DatabaseSync): void {
  db.exec("DELETE FROM runs; DELETE FROM fixtures;");
}

export interface ExportBundle {
  app: string;
  exportedAt: string;
  fixtures: Array<Omit<FixtureRow, "id" | "created_at">>;
  runs: Array<{ name: string; request_json: string; report_json: string; fingerprint: string }>;
}

export function exportBundle(db: DatabaseSync): ExportBundle {
  const fixtures = listFixtures(db).map(({ name, role, touchstone, points, f_start_hz, f_stop_hz, z0, source }) => ({
    name, role, touchstone, points, f_start_hz, f_stop_hz, z0, source,
  }));
  const runs = listRuns(db).map(({ name, request_json, report_json, fingerprint }) => ({
    name, request_json, report_json, fingerprint,
  }));
  return {
    app: "reference-plane-deembed-bench",
    exportedAt: new Date().toISOString(),
    fixtures,
    runs,
  };
}

export interface ImportResult {
  fixtures: number;
  runs: number;
  /** 每个 run 重放后与导出报告的最大回级联残差。 */
  replays: Array<{ name: string; maxRoundtripRel: number; matched: boolean; mismatchDetail?: string }>;
}

export function importBundle(
  db: DatabaseSync,
  bundle: ExportBundle,
  replay: (requestJson: string) => { reportJson: string; maxRoundtripRel: number },
  opts: { wipe?: boolean } = {},
): ImportResult {
  if (opts.wipe) clearAll(db);
  const insF = db.prepare(
    `INSERT INTO fixtures (name, role, touchstone, points, f_start_hz, f_stop_hz, z0, source)
     VALUES (?,?,?,?,?,?,?,?)`,
  );
  for (const f of bundle.fixtures) {
    insF.run(f.name, f.role, f.touchstone, f.points, f.f_start_hz, f.f_stop_hz, f.z0, f.source);
  }
  const insR = db.prepare(
    "INSERT INTO runs (name, request_json, report_json, fingerprint) VALUES (?,?,?,?)",
  );
  const replays: ImportResult["replays"] = [];
  for (const r of bundle.runs) {
    let replayReport: { reportJson: string; maxRoundtripRel: number } | undefined;
    let mismatchDetail: string | undefined;
    try {
      replayReport = replay(r.request_json);
      const old = JSON.parse(r.report_json) as { maxRoundtripRel: number };
      const fresh = JSON.parse(replayReport.reportJson) as { maxRoundtripRel: number };
      const matched =
        Math.abs(old.maxRoundtripRel - fresh.maxRoundtripRel) <=
        Math.max(1e-12, 1e-6 * Math.max(1, fresh.maxRoundtripRel));
      if (!matched) {
        mismatchDetail = `旧=${old.maxRoundtripRel.toExponential(3)} 重算=${fresh.maxRoundtripRel.toExponential(3)}`;
      }
      insR.run(r.name, r.request_json, replayReport.reportJson, r.fingerprint);
      replays.push({
        name: r.name,
        maxRoundtripRel: replayReport.maxRoundtripRel,
        matched: matched ?? true,
        mismatchDetail,
      });
    } catch (err) {
      insR.run(r.name, r.request_json, r.report_json, r.fingerprint);
      replays.push({
        name: r.name,
        maxRoundtripRel: NaN,
        matched: false,
        mismatchDetail: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { fixtures: bundle.fixtures.length, runs: bundle.runs.length, replays };
}
