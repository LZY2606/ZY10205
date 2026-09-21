import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  FixtureRow,
  FixtureInput,
  exportBundle,
  getRun,
  importBundle as dbImportBundle,
  insertImportedFixture,
  insertRun,
  listFixtures,
  listRuns,
  upsertBuiltinFixture,
} from "../src/db.js";
import { parseTouchstone } from "../src/touchstone.js";
import { GridStrategy } from "../src/grid.js";
import { deembed, DeembedReport } from "../src/deembed.js";
import { compareReports, summarizeDiff } from "../src/compare.js";
import { groupDelay, magDbSeries, phaseSeries } from "../src/measure.js";

export interface RunRequest {
  name: string;
  leftName: string;
  rightName: string;
  measuredName: string;
  strategy: GridStrategy;
  condWarn?: number;
  condFail?: number;
  roundtripTol?: number;
  targetZ0?: number[];
}

export class BenchService {
  constructor(private db: DatabaseSync, private dataDir: string) {}

  seedBuiltins(): { fixtures: number } {
    const map: Array<[string, string, FixtureRow["role"]]> = [
      ["fixtures/left-fixture-3mhz.s2p", "left-fixture-3mhz", "left"],
      ["fixtures/right-fixture-7mhz.s2p", "right-fixture-7mhz", "right"],
      ["dut/dut-shunt-notch-10mhz.s2p", "dut-shunt-notch-10mhz", "dut"],
      ["measured/measured-10mhz.s2p", "measured-10mhz", "measured"],
    ];
    let n = 0;
    for (const [rel, name, role] of map) {
      const body = readFileSync(resolve(this.dataDir, rel), "utf8");
      const parsed = parseTouchstone(body, name);
      const input: FixtureInput & { source: string } = {
        name,
        role,
        touchstone: body,
        points: parsed.network.freq.length,
        f_start_hz: parsed.network.freq[0]!,
        f_stop_hz: parsed.network.freq[parsed.network.freq.length - 1]!,
        z0: parsed.network.z0[0]!,
        source: "builtin",
      };
      upsertBuiltinFixture(this.db, input);
      n++;
    }
    return { fixtures: n };
  }

  listFixtures() {
    return listFixtures(this.db).map(meta);
  }

  getFixtureByName(name: string): FixtureRow | undefined {
    return this.db.prepare("SELECT * FROM fixtures WHERE name=?").get(name) as unknown as FixtureRow | undefined;
  }

  fixtureDetail(name: string) {
    const row = this.getFixtureByName(name);
    if (!row) return undefined;
    const n = parseTouchstone(row.touchstone, row.name).network;
    return {
      ...meta(row),
      freq: n.freq,
      z0: n.z0,
      sParam: n.sParam,
      groupDelay: groupDelay(n),
      magDb: {
        m00: magDbSeries(n, "m00"),
        m10: magDbSeries(n, "m10"),
        m01: magDbSeries(n, "m01"),
        m11: magDbSeries(n, "m11"),
      },
      phaseRad: {
        m00: phaseSeries(n, "m00"),
        m10: phaseSeries(n, "m10"),
        m01: phaseSeries(n, "m01"),
        m11: phaseSeries(n, "m11"),
      },
    };
  }

  importTouchstone(name: string, role: FixtureRow["role"], body: string) {
    const parsed = parseTouchstone(body, name);
    if (parsed.network.freq.length < 2) throw new Error("至少需要两个频点");
    const id = insertImportedFixture(this.db, {
      name,
      role,
      touchstone: body,
      points: parsed.network.freq.length,
      f_start_hz: parsed.network.freq[0]!,
      f_stop_hz: parsed.network.freq[parsed.network.freq.length - 1]!,
      z0: parsed.network.z0[0]!,
    });
    return { id, warnings: parsed.warnings, points: parsed.network.freq.length };
  }

  run(req: RunRequest): { id: number; report: DeembedReport } {
    const [l, r, m2] = [req.leftName, req.rightName, req.measuredName].map((n) => {
      const row = this.getFixtureByName(n);
      if (!row) throw new Error(`夹具不存在: ${n}`);
      return parseTouchstone(row.touchstone, n).network;
    });
    const report = deembed({
      measured: m2!,
      left: l!,
      right: r!,
      strategy: req.strategy,
      condWarn: req.condWarn,
      condFail: req.condFail,
      roundtripTol: req.roundtripTol,
      targetZ0: req.targetZ0,
      name: req.name,
    });
    const requestJson = JSON.stringify(req);
    const id = insertRun(this.db, req.name, requestJson, JSON.stringify(report), report.fingerprint);
    return { id, report };
  }

  listRuns() {
    return listRuns(this.db).map((r) => {
      const rep = JSON.parse(r.report_json) as DeembedReport;
      return {
        id: r.id,
        name: r.name,
        createdAt: r.created_at,
        fingerprint: r.fingerprint,
        strategy: rep.strategy,
        counts: rep.counts,
        maxRoundtripRel: rep.maxRoundtripRel,
        roundtripPass: rep.roundtripPass,
        physical: rep.physical,
        targetZ0: rep.targetZ0,
        nPoints: rep.targetGrid.length,
      };
    });
  }

  runDetail(id: number) {
    const row = getRun(this.db, id);
    if (!row) return undefined;
    return { id: row.id, name: row.name, createdAt: row.created_at, request: JSON.parse(row.request_json), report: JSON.parse(row.report_json) };
  }

  compare(aId: number, bId: number) {
    const a = this.runDetail(aId);
    const b = this.runDetail(bId);
    if (!a || !b) throw new Error("方案不存在");
    const diff = compareReports(a.report as DeembedReport, b.report as DeembedReport);
    return { summary: summarizeDiff(diff), points: diff };
  }

  export() {
    return exportBundle(this.db);
  }

  clearAndReimport(bundle: unknown, opts: { wipe: boolean }) {
    return dbImportBundle(
      this.db,
      bundle as ReturnType<typeof exportBundle>,
      (requestJson) => {
        const req = JSON.parse(requestJson) as RunRequest;
        const [l, r, m2] = [req.leftName, req.rightName, req.measuredName].map((n) => {
          const row = this.getFixtureByName(n);
          if (!row) throw new Error(`重放缺少夹具: ${n}`);
          return parseTouchstone(row.touchstone, n).network;
        });
        const report = deembed({
          measured: m2!,
          left: l!,
          right: r!,
          strategy: req.strategy,
          condWarn: req.condWarn,
          condFail: req.condFail,
          roundtripTol: req.roundtripTol,
          targetZ0: req.targetZ0,
        });
        return { reportJson: JSON.stringify(report), maxRoundtripRel: report.maxRoundtripRel };
      },
      opts,
    );
  }
}

function meta(row: FixtureRow) {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    points: row.points,
    fStartHz: row.f_start_hz,
    fStopHz: row.f_stop_hz,
    z0: row.z0,
    source: row.source,
    createdAt: row.created_at,
  };
}
