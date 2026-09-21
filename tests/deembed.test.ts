import { describe, expect, it } from "vitest";
import { linGrid, shuntRLCNotch, transmissionLine } from "../src/models.js";
import { cascade, Network } from "../src/rf.js";
import { alignToGrid } from "../src/grid.js";
import { deembed } from "../src/deembed.js";
import { frob, subM } from "../src/cmat.js";

const CAP = 1 / ((2 * Math.PI * 1e9) ** 2 * 1e-9);

function buildMeasured(strategy: "different-grids" | "same-grid" = "different-grids") {
  const gLeft = linGrid(0.08e9, 4.2e9, 3e6);
  const gRight = linGrid(0.05e9, 4.5e9, 7e6);
  const gMeas = linGrid(0.1e9, 4e9, 1e7);
  const left = transmissionLine(gLeft, { z0: 50, zLine: 50, tDelay: 0.4e-9, alpha0: 0.02 });
  const right = transmissionLine(gRight, { z0: 50, zLine: 52, tDelay: 0.25e-9, alpha0: 0.03 });
  const dut = shuntRLCNotch(gMeas, { z0: 50, r: 0.02, l: 1e-9, cap: CAP });
  const la = alignToGrid(left, gMeas);
  const ra = alignToGrid(right, gMeas);
  const lNet: Network = { freq: gMeas, sParam: la.points.map((p) => p.mat), z0: [50, 50] };
  const rNet: Network = { freq: gMeas, sParam: ra.points.map((p) => p.mat), z0: [50, 50] };
  const measured = cascade(cascade(lNet, dut), rNet);
  if (strategy === "same-grid") {
    return {
      measured,
      left: lNet,
      right: rNet,
      dut,
      gMeas,
    };
  }
  return { measured, left, right, dut, gMeas };
}

describe("去嵌与回级联（不同频率网格）", () => {
  it("回级联原夹具在容差内恢复测量网络（机器精度级）", () => {
    const { measured, left, right } = buildMeasured();
    const rep = deembed({ measured, left, right, strategy: "measured" });
    expect(rep.roundtripPass).toBe(true);
    expect(rep.maxRoundtripRel).toBeLessThan(1e-10);
  });

  it("恢复的 DUT 与解析真值一致（窄带陷波中心也恢复到高精度）", () => {
    const { measured, left, right, dut, gMeas } = buildMeasured();
    const rep = deembed({ measured, left, right, strategy: "measured" });
    const notchIdx = gMeas.indexOf(1e9);
    const p = rep.points[notchIdx]!;
    expect(p.dutS).not.toBeNull();
    const err = frob(subM(p.dutS!, dut.sParam[notchIdx]!)) / Math.max(1, frob(dut.sParam[notchIdx]!));
    expect(err).toBeLessThan(1e-10);
  });

  it("近奇异点逐频报告：1GHz 附近窄带 near_singular，其余点不被误伤", () => {
    const { measured, left, right } = buildMeasured();
    const rep = deembed({ measured, left, right, strategy: "measured" });
    const flagged = rep.points
      .filter((p) => p.status === "near_singular" || p.status === "unstable" || p.status === "exact_singular")
      .map((p) => p.freq);
    // 陷波窄带：所有标记点必须落在 0.97~1.03 GHz，且至少包含中心频点
    expect(flagged).toContain(1e9);
    expect(flagged.every((f) => Math.abs(f - 1e9) <= 30e6)).toBe(true);
    expect(flagged.length).toBeGreaterThan(0);
    expect(flagged.length).toBeLessThan(20);
    // 每个标记频点保留诊断与结果，不是零矩阵
    for (const p of rep.points.filter((x) => flagged.includes(x.freq))) {
      expect(p.dutS).not.toBeNull();
      expect(p.roundtripRel).not.toBeNull();
      expect(p.messages.length).toBeGreaterThan(0);
    }
  });

  it("严格奇异（S21=0）点 dutS=null，绝不用零矩阵或相邻点填平", () => {
    const { measured, left, right, gMeas } = buildMeasured();
    // 人工在测量网络中心频点制造 S21=0
    const broken: Network = {
      freq: measured.freq.slice(),
      sParam: measured.sParam.map((s, i) =>
        i === gMeas.indexOf(1e9) ? { ...s, m10: { re: 0, im: 0 } } : s,
      ),
      z0: [50, 50],
    };
    const rep = deembed({ measured: broken, left, right, strategy: "measured" });
    const center = rep.points[gMeas.indexOf(1e9)]!;
    expect(center.status).toBe("exact_singular");
    expect(center.dutS).toBeNull();
    expect(center.rebuiltS).toBeNull();
    expect(center.messages.join(" ")).toMatch(/严格奇异|零矩阵|相邻点/);
    // 相邻点不受影响
    expect(rep.points[gMeas.indexOf(1e9) - 1]!.dutS).not.toBeNull();
    expect(rep.points[gMeas.indexOf(1e9) + 1]!.dutS).not.toBeNull();
    // 全部点都存在（没有丢点）
    expect(rep.points.length).toBe(gMeas.length);
  });

  it("外推逐点标记（测量网格落在夹具覆盖之外）", () => {
    const { measured, left, right } = buildMeasured();
    const rep = deembed({ measured, left, right, strategy: "union" });
    // union 含右夹具 4.5GHz，超出测量 4GHz/左夹具 4.2GHz
    const beyond = rep.points.filter((p) => p.freq > 4.2e9);
    expect(beyond.length).toBeGreaterThan(0);
    expect(beyond.every((p) => p.leftExtrapolated || p.rightExtrapolated)).toBe(true);
  });

  it("数值不稳定与物理不可行分开报告：有源测量面 -> DUT 非无源，与条件数状态分列", () => {
    const { measured, left, right, gMeas } = buildMeasured();
    // 在远离陷波的频点（100 MHz）注入 20dB 增益，制造物理不可行但良态的测量网络
    const idx = gMeas.indexOf(0.1e9);
    const activeMeasured: Network = {
      ...measured,
      sParam: measured.sParam.map((s, i) =>
        i === idx
          ? { ...s, m10: { re: s.m10.re * 10, im: s.m10.im * 10 } }
          : s,
      ),
    };
    const rep = deembed({ measured: activeMeasured, left, right, strategy: "measured" });
    const bad = rep.points[idx]!;
    // 物理不可行：独立字段，且该点数值上是良态（ok/interpolated），不与奇异混淆
    expect(bad.passivityExcess).toBeGreaterThan(1e-6);
    expect(rep.physical.passive).toBe(false);
    expect(["ok", "interpolated"]).toContain(bad.status);
    // 数值不稳定状态在另一处（陷波）独立存在
    const notch = rep.points[gMeas.indexOf(1e9)]!;
    expect(notch.status).toBe("near_singular");
    // 两类诊断字段各自独立保留
    expect(notch).toHaveProperty("passivityExcess");
    expect(bad).toHaveProperty("measuredCond");
  });

  it("口径被固定并记录（策略、网格、z0、指纹）", () => {
    const { measured, left, right } = buildMeasured();
    const rep1 = deembed({ measured, left, right, strategy: "measured" });
    const rep2 = deembed({ measured, left, right, strategy: "measured" });
    expect(rep1.fingerprint).toBe(rep2.fingerprint);
    expect(rep1.strategy).toBe("measured");
    expect(rep1.z0).toEqual([50, 50]);
  });
});
