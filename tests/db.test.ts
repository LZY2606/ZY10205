import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearAll,
  exportBundle,
  getRun,
  importBundle,
  insertImportedFixture,
  insertRun,
  listFixtures,
  listRuns,
  openDb,
  upsertBuiltinFixture,
} from "../src/db.js";
import { parseTouchstone } from "../src/touchstone.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { deembed, DeembedRequest } from "../src/deembed.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "deembed-db-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function loadAndReplay(requestJson: string, dbPath: string): { reportJson: string; maxRoundtripRel: number } {
  // 从已导入数据库的 fixtures 重建网络（模拟清空后重新导入的复核路径）
  const db = openDb(dbPath);
  const req = JSON.parse(requestJson) as {
    leftId: number;
    rightId: number;
    measuredId: number;
    strategy: DeembedRequest["strategy"];
    condWarn?: number;
    condFail?: number;
    roundtripTol?: number;
    targetZ0?: number[];
    name?: string;
  };
  // 重放按稳定键 name 取夹具（清空后 AUTOINCREMENT id 不复用）。
  const byId = new Map(listFixtures(db).map((f) => [f.id, f]));
  const names = [req.leftId, req.rightId, req.measuredId].map(
    (id) => {
      const byIdRow = byId.get(id);
      return byIdRow?.name;
    },
  );
  // 请求同时记录 name（见用例），优先用 name
  const req2 = JSON.parse(requestJson) as { leftName?: string; rightName?: string; measuredName?: string };
  const keys = [req2.leftName ?? names[0], req2.rightName ?? names[1], req2.measuredName ?? names[2]];
  const nets = keys.map((name) => {
    if (!name) throw new Error("缺少夹具 name");
    const fix = db.prepare("SELECT * FROM fixtures WHERE name=?").get(name) as { touchstone: string } | undefined;
    if (!fix) throw new Error(`重放缺少夹具: ${name}`);
    return parseTouchstone(fix.touchstone).network;
  });
  const report = deembed({
    left: nets[0]!,
    right: nets[1]!,
    measured: nets[2]!,
    strategy: req.strategy,
    condWarn: req.condWarn,
    condFail: req.condFail,
    roundtripTol: req.roundtripTol,
    targetZ0: req.targetZ0,
    name: req.name,
  });
  return { reportJson: JSON.stringify(report), maxRoundtripRel: report.maxRoundtripRel };
}

describe("SQLite 持久化与清空后重放", () => {
  it("内置 fixture 幂等 upsert；导入 Touchstone 可列出", () => {
    const dbPath = join(dir, "test.db");
    const db = openDb(dbPath);
    const s2p = readFileSync(resolve(process.cwd(), "data/fixtures/left-fixture-3mhz.s2p"), "utf8");
    const n = parseTouchstone(s2p).network;
    const id1 = upsertBuiltinFixture(db, {
      name: "left",
      role: "left",
      touchstone: s2p,
      points: n.freq.length,
      f_start_hz: n.freq[0]!,
      f_stop_hz: n.freq[n.freq.length - 1]!,
      z0: 50,
      source: "builtin",
    });
    const id2 = upsertBuiltinFixture(db, {
      name: "left",
      role: "left",
      touchstone: s2p,
      points: n.freq.length,
      f_start_hz: n.freq[0]!,
      f_stop_hz: n.freq[n.freq.length - 1]!,
      z0: 50,
      source: "builtin",
    });
    expect(id1).toBe(id2);
    insertImportedFixture(db, {
      name: "user.s2p",
      role: "unknown",
      touchstone: "# GHz S RI R 50\n1 0 0 1 0 1 0 0 0\n2 0 0 1 0 1 0 0 0\n",
      points: 2,
      f_start_hz: 1e9,
      f_stop_hz: 2e9,
      z0: 50,
    });
    expect(listFixtures(db)).toHaveLength(2);
  });

  it("导出 -> 清空 -> 重新导入 -> 重算回级联残差一致", () => {
    const dbPath = join(dir, "bench.db");
    const db = openDb(dbPath);
    const root = process.cwd();
    const files: Array<[string, "left" | "right" | "measured"]> = [
      ["data/fixtures/left-fixture-3mhz.s2p", "left"],
      ["data/fixtures/right-fixture-7mhz.s2p", "right"],
      ["data/measured/measured-10mhz.s2p", "measured"],
    ];
    const ids: Record<string, number> = {};
    for (const [rel, role] of files) {
      const body = readFileSync(resolve(root, rel), "utf8");
      const n = parseTouchstone(body).network;
      ids[role] = insertImportedFixture(db, {
        name: rel,
        role,
        touchstone: body,
        points: n.freq.length,
        f_start_hz: n.freq[0]!,
        f_stop_hz: n.freq[n.freq.length - 1]!,
        z0: 50,
      });
    }
    const req = {
      leftId: ids.left!,
      rightId: ids.right!,
      measuredId: ids.measured!,
      leftName: files[0]![0],
      rightName: files[1]![0],
      measuredName: files[2]![0],
      strategy: "measured" as const,
      name: "replay-case",
    };
    const first = loadAndReplay(JSON.stringify(req), dbPath);
    const rid = insertRun(db, req.name, JSON.stringify(req), first.reportJson, "fp");
    expect(getRun(db, rid)!.fingerprint).toBe("fp");

    const bundle = exportBundle(db);
    expect(bundle.fixtures).toHaveLength(3);
    expect(bundle.runs).toHaveLength(1);

    // 清空
    clearAll(db);
    expect(listRuns(db)).toHaveLength(0);
    expect(listFixtures(db)).toHaveLength(0);

    // 重新导入并由引擎重放（不使用旧报告结果）
    const result = importBundle(
      db,
      bundle,
      (requestJson) => loadAndReplay(requestJson, dbPath),
      { wipe: false },
    );
    expect(result.fixtures).toBe(3);
    expect(result.runs).toBe(1);
    expect(result.replays[0]!.matched).toBe(true);
    expect(result.replays[0]!.maxRoundtripRel).toBeLessThan(1e-10);
    // 重放后的 run 仍是 1 条且报告已更新
    expect(listRuns(db)).toHaveLength(1);
    const freshReport = JSON.parse(listRuns(db)[0]!.report_json) as { maxRoundtripRel: number };
    expect(freshReport.maxRoundtripRel).toBeLessThan(1e-10);
  });

  it("数据库文件确实落盘", () => {
    const dbPath = join(dir, "x.db");
    const db = openDb(dbPath);
    db.exec("CREATE TABLE IF NOT EXISTS t(x);");
    expect(existsSync(dbPath)).toBe(true);
  });
});
