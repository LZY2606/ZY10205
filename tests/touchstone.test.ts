import { describe, expect, it } from "vitest";
import { parseTouchstone, writeTouchstone } from "../src/touchstone.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { abs } from "../src/complex.js";
import { frob, subM } from "../src/cmat.js";

describe("Touchstone 解析", () => {
  it("解析 MA/DB/RI 三种格式", () => {
    const ri = `# GHz S RI R 50
1.0 0.1 0.2 0.9 0.0 0.9 0.0 -0.1 -0.2`;
    const ma = `# GHz S MA R 50
1.0 0.2236 63.4349 0.9 0 0.9 0 0.2236 -116.565`;
    const db = `# GHz S DB R 50
1.0 -13.0103 63.4349 -0.9151 0 -0.9151 0 -13.0103 -116.565`;
    const a = parseTouchstone(ri).network;
    const b = parseTouchstone(ma).network;
    const d = parseTouchstone(db).network;
    expect(frob(subM(a.sParam[0]!, b.sParam[0]!))).toBeLessThan(1e-3);
    expect(frob(subM(a.sParam[0]!, d.sParam[0]!))).toBeLessThan(1e-3);
  });

  it("频率单位与严格递增校验", () => {
    const ok = parseTouchstone(`# MHz S RI R 75
100 0 0 1 0 1 0 0 0
200 0 0 1 0 1 0 0 0`).network;
    expect(ok.freq).toEqual([1e8, 2e8]);
    expect(ok.z0).toEqual([75, 75]);
    expect(() =>
      parseTouchstone(`# GHz S RI R 50
2 0 0 1 0 1 0 0 0
1 0 0 1 0 1 0 0 0`),
    ).toThrow(/严格递增/);
  });

  it("固定夹具文件可读、物理合理、左右网格不同", () => {
    const root = process.cwd();
    const l = parseTouchstone(readFileSync(resolve(root, "data/fixtures/left-fixture-3mhz.s2p"), "utf8")).network;
    const r = parseTouchstone(readFileSync(resolve(root, "data/fixtures/right-fixture-7mhz.s2p"), "utf8")).network;
    expect(l.freq.length).not.toBe(r.freq.length);
    expect(l.freq[1]! - l.freq[0]!).toBeCloseTo(3e6);
    expect(r.freq[1]! - r.freq[0]!).toBeCloseTo(7e6);
    for (const s of [...l.sParam, ...r.sParam]) {
      const col1 = abs(s.m00) ** 2 + abs(s.m10) ** 2;
      const col2 = abs(s.m01) ** 2 + abs(s.m11) ** 2;
      expect(col1).toBeLessThanOrEqual(1 + 1e-9);
      expect(col2).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it("写出再读回保持数值", () => {
    const n = parseTouchstone(`# GHz S RI R 50
1 0.1 0.2 0.9 0 0.9 0 -0.1 -0.2
2 0 0 1 0 1 0 0 0`).network;
    const back = parseTouchstone(writeTouchstone(n)).network;
    expect(frob(subM(back.sParam[0]!, n.sParam[0]!))).toBeLessThan(1e-9);
  });
});
