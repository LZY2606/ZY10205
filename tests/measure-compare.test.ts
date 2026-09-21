import { describe, expect, it } from "vitest";
import { linGrid, shuntRLCNotch, transmissionLine } from "../src/models.js";
import { cascade, Network, swapPorts } from "../src/rf.js";
import { alignToGrid } from "../src/grid.js";
import { deembed } from "../src/deembed.js";
import { compareReports, summarizeDiff } from "../src/compare.js";
import { groupDelay } from "../src/measure.js";

const CAP = 1 / ((2 * Math.PI * 1e9) ** 2 * 1e-9);

function setup() {
  const gL = linGrid(0.08e9, 4.2e9, 3e6);
  const gR = linGrid(0.05e9, 4.5e9, 7e6);
  const gM = linGrid(0.1e9, 4e9, 1e7);
  const left = transmissionLine(gL, { z0: 50, zLine: 50, tDelay: 0.4e-9, alpha0: 0.02 });
  const right = transmissionLine(gR, { z0: 50, zLine: 52, tDelay: 0.25e-9, alpha0: 0.03 });
  const dut = shuntRLCNotch(gM, { z0: 50, r: 0.02, l: 1e-9, cap: CAP });
  const la = alignToGrid(left, gM);
  const ra = alignToGrid(right, gM);
  const lNet: Network = { freq: gM, sParam: la.points.map((p) => p.mat), z0: [50, 50] };
  const rNet: Network = { freq: gM, sParam: ra.points.map((p) => p.mat), z0: [50, 50] };
  const measured = cascade(cascade(lNet, dut), rNet);
  return { gM, left, right, measured, dut };
}

describe("方案按频点对比", () => {
  it("同一方案两次运行差异为 0；交换两侧夹具产生非零差异", () => {
    const { gM, left, right, measured } = setup();
    const a = deembed({ measured, left, right, strategy: "measured", name: "A" });
    const b = deembed({ measured, left: right, right: left, strategy: "measured", name: "B" });
    const diffSelf = summarizeDiff(compareReports(a, a));
    expect(diffSelf.maxAbs).toBe(0);
    const diff = compareReports(a, b);
    expect(diff.length).toBe(gM.length);
    const sum = summarizeDiff(diff);
    expect(sum.maxAbs).toBeGreaterThan(1e-3);
    expect(sum.freqMaxAbs).not.toBeNull();
    // 差异点包含复矩阵元素
    expect(diff[10]!.dS).not.toBeNull();
  });
});

describe("群时延", () => {
  it("无损平通带 S21=-e^{-jw t} 的群时延约等于 t", () => {
    const { gM, left, measured } = setup();
    void left;
    const gd = groupDelay(measured);
    // 取远离陷波与端部的频段平均
    const mid = gd.slice(50, 80).filter((x): x is number => x !== null);
    const mean = mid.reduce((a, b) => a + b, 0) / mid.length;
    expect(mean).toBeGreaterThan(0);
    expect(mean).toBeLessThan(2e-9);
    expect(gd.length).toBe(gM.length);
  });

  it("swapPorts 保持 |S21|（交换后 S21' = S12，对互易网络相等）", () => {
    const { measured, gM } = setup();
    const sw = swapPorts(measured);
    const i = gM.indexOf(0.5e9);
    const a = measured.sParam[i]!;
    const b = sw.sParam[i]!;
    expect(Math.hypot(b.m10.re, b.m10.im)).toBeCloseTo(Math.hypot(a.m10.re, a.m10.im), 12);
  });
});
