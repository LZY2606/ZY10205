import { C, abs } from "./complex.js";
import { invertInfo, M2, mulM } from "./cmat.js";
import {
  Network,
  PhysicalDiagnostics,
  renormalize,
  residualMatrix,
  sToTInfo,
  tToSInfo,
} from "./rf.js";
import { alignToGrid, AlignedNetwork, GridStrategy, buildTargetGrid } from "./grid.js";

/**
 * 去嵌引擎。口径在 DeembedRequest 中固定并随结果记录：
 *  - 固定端口顺序（1 左 / 2 右）、波定义（功率波 a 入 b 出）；
 *  - 固定参考阻抗与插值网格（strategy）。
 *
 * 测量面：    [左夹具 L] [被测 DUT] [右夹具 R]
 *   T_meas(f) = T_L * T_DUT * T_R
 *   T_DUT     = T_L^{-1} T_meas T_R^{-1}
 *
 * 每个频点独立诊断，绝不以相邻点或零矩阵填平：
 *  - 数值不稳定：T 转换条件数超阈值 / 严格奇异，但不与物理问题混报；
 *  - 物理不可行：恢复网络非无源（增益）——单独报告。
 */
export interface DeembedRequest {
  measured: Network;
  left: Network;
  right: Network;
  strategy: GridStrategy;
  /** 条件数预警/失败阈值。 */
  condWarn?: number;
  condFail?: number;
  /** 回级联相对残差超过此值视为回验失败。 */
  roundtripTol?: number;
  /** 可选：DUT 结果重归一化到该逐端口阻抗；不给则沿用测量面 z0。 */
  targetZ0?: number[];
  name?: string;
}

export type PointStatus =
  | "ok"
  | "interpolated" // 使用了夹具插值（非外推）
  | "extrapolated" // 夹具在该频点需要外推
  | "near_singular" // 条件数超预警：数值仍给出，但标记不可信
  | "unstable" // 条件数超失败阈值或求逆失败：结果保留但不可用
  | "exact_singular"; // S21=0 等严格奇异：DUT 无法由 T 法恢复（非零矩阵，null）

export interface PointDiagnostic {
  freq: number;
  status: PointStatus;
  statusLevel: "ok" | "warn" | "fail";
  measuredCond: number;
  leftCond: number;
  rightCond: number;
  leftExtrapolated: boolean;
  rightExtrapolated: boolean;
  /** 去嵌得到的 DUT S；严格奇异时为 null（不是零矩阵）。 */
  dutS: M2 | null;
  /** 用原夹具回级联恢复的“测量面”S。 */
  rebuiltS: M2 | null;
  /** 回验残差 ||M - L*DUT*R||F。 */
  roundtripAbs: number | null;
  roundtripRel: number | null;
  passivityExcess: number | null;
  messages: string[];
}

export interface DeembedReport {
  name?: string;
  strategy: GridStrategy;
  targetGrid: number[];
  z0: number[];
  targetZ0: number[] | null;
  points: PointDiagnostic[];
  physical: PhysicalDiagnostics;
  /** 汇总（逐点信息仍完整保留）。 */
  counts: Record<PointStatus, number>;
  maxRoundtripRel: number;
  roundtripPass: boolean;
  createdAt: string;
  /** 口径指纹，便于重放比对。 */
  fingerprint: string;
}

const DEFAULT_COND_WARN = 1e5;
const DEFAULT_COND_FAIL = 1e8;
const DEFAULT_ROUNDTRIP_TOL = 1e-9;

export function deembed(req: DeembedRequest): DeembedReport {
  const condWarn = req.condWarn ?? DEFAULT_COND_WARN;
  const condFail = req.condFail ?? DEFAULT_COND_FAIL;
  const roundtripTol = req.roundtripTol ?? DEFAULT_ROUNDTRIP_TOL;

  const targetGrid = buildTargetGrid(
    req.measured.freq,
    req.left.freq,
    req.right.freq,
    req.strategy,
  );

  const mL: AlignedNetwork = alignToGrid(req.left, targetGrid);
  const mR: AlignedNetwork = alignToGrid(req.right, targetGrid);
  const mM: AlignedNetwork = alignToGrid(req.measured, targetGrid);

  const z0 = req.measured.z0.slice();
  const points: PointDiagnostic[] = [];

  for (let i = 0; i < targetGrid.length; i++) {
    const f = targetGrid[i]!;
    const messages: string[] = [];
    const lp = mL.points[i]!;
    const rp = mR.points[i]!;
    const mp = mM.points[i]!;

    const tLeftInfo = sToTInfo(lp.mat);
    const tRightInfo = sToTInfo(rp.mat);
    const tMeasInfo = sToTInfo(mp.mat);

    const st: { value: PointStatus } = { value: "ok" };
    const status = () => st.value;
    const rank: PointStatus[] = ["ok", "interpolated", "extrapolated", "near_singular", "unstable", "exact_singular"];
    const bump = (cand: PointStatus) => {
      if (rank.indexOf(cand) > rank.indexOf(st.value)) st.value = cand;
    };

    if (lp.extrapolated || rp.extrapolated) bump("extrapolated");
    else if (lp.loIdx !== lp.hiIdx || rp.loIdx !== rp.hiIdx) bump("interpolated");

    let dutS: M2 | null = null;
    let rebuiltS: M2 | null = null;
    let roundtripAbs: number | null = null;
    let roundtripRel: number | null = null;
    let passivityExcess: number | null = null;

    const conds = [tLeftInfo.cond, tRightInfo.cond, tMeasInfo.cond];
    const maxCond = Math.max(...conds.filter((x) => Number.isFinite(x)));
    const anyExact = tLeftInfo.exactSingular || tRightInfo.exactSingular || tMeasInfo.exactSingular;

    if (anyExact) {
      st.value = "exact_singular";
      const which = [
        tLeftInfo.exactSingular ? "左夹具" : null,
        tRightInfo.exactSingular ? "右夹具" : null,
        tMeasInfo.exactSingular ? "测量网络" : null,
      ].filter(Boolean).join("/");
      messages.push(`${which} S21=0（或 T22=0），T 法严格奇异；该频点 DUT 置空（null），不以零矩阵或相邻点填平`);
    } else {
      const tl = tLeftInfo.t!;
      const tr = tRightInfo.t!;
      const tm = tMeasInfo.t!;
      const invL = invertInfo(tl);
      const invR = invertInfo(tr);
      if (invL.exactSingular || invR.exactSingular) {
        st.value = "exact_singular";
        messages.push("夹具 T 矩阵严格奇异，无法反演");
      } else {
        // 反演条件数也要计入
        const worstCond = Math.max(maxCond, invL.cond, invR.cond);
        const tDut = mulM(mulM(invL.inv, tm), invR.inv);
        const back = tToSInfo(tDut);
        if (!back.s) {
          st.value = "exact_singular";
          messages.push("去嵌 T->S 严格奇异（T22=0）");
        } else {
          dutS = back.s;
          // 回级联：L * DUT * R 应恢复测量面
          const tDut2 = mulM(mulM(tl, sToTInfo(dutS).t!), tr);
          const rebuilt = tToSInfo(tDut2);
          if (rebuilt.s) {
            rebuiltS = rebuilt.s;
            const res = residualMatrix(mp.mat, rebuiltS);
            roundtripAbs = res.abs;
            roundtripRel = res.rel;
          }
          // 该频点无源性（s^H s 最大特征值 - 1，通用口径）
          passivityExcess = pointEigenExcess(dutS);
          if (worstCond >= condFail) {
            bump("unstable");
            messages.push(`条件数 ${worstCond.toExponential(2)} ≥ 失败阈值 ${condFail.toExponential(2)}；结果保留但标记不可信`);
          } else if (worstCond >= condWarn) {
            bump("near_singular");
            messages.push(`条件数 ${worstCond.toExponential(2)} ≥ 预警阈值 ${condWarn.toExponential(2)}；逐频点保留`);
          }
          if (roundtripRel !== null && roundtripRel > roundtripTol && status() !== "unstable" && status() !== "exact_singular") {
            messages.push(`回级联相对残差 ${roundtripRel.toExponential(2)} 超过容差 ${roundtripTol.toExponential(2)}`);
            if (rank.indexOf(status()) < rank.indexOf("near_singular")) bump("near_singular");
          }
        }
      }
    }

    const level: "ok" | "warn" | "fail" =
      status() === "exact_singular" || status() === "unstable"
        ? "fail"
        : status() === "near_singular" || status() === "extrapolated"
          ? "warn"
          : "ok";

    points.push({
      freq: f,
      status: status(),
      statusLevel: level,
      measuredCond: finiteOrNull(tMeasInfo.cond),
      leftCond: finiteOrNull(tLeftInfo.cond),
      rightCond: finiteOrNull(tRightInfo.cond),
      leftExtrapolated: lp.extrapolated,
      rightExtrapolated: rp.extrapolated,
      dutS,
      rebuiltS,
      roundtripAbs,
      roundtripRel,
      passivityExcess,
      messages,
    });
  }

  // 汇总网络（严格奇异点以 null 表示，不生成 Network 数组）
  const physical = summarizePhysical(points);
  const counts = { ok: 0, interpolated: 0, extrapolated: 0, near_singular: 0, unstable: 0, exact_singular: 0 };
  let maxRoundtripRel = 0;
  for (const p of points) {
    counts[p.status]++;
    if (p.roundtripRel !== null && p.roundtripRel > maxRoundtripRel) maxRoundtripRel = p.roundtripRel;
  }
  const targetZ0 = req.targetZ0 ? req.targetZ0.slice() : null;
  if (targetZ0) {
    // 仅对可恢复点做重归一化，逐点进行（保持 null 点为 null）
    for (const p of points) {
      if (!p.dutS) continue;
      const single: Network = { freq: [p.freq], sParam: [p.dutS], z0 };
      const rn = renormalize(single, targetZ0);
      p.dutS = rn.sParam[0]!;
    }
  }

  const fingerprint = makeFingerprint(req, targetGrid);
  return {
    name: req.name,
    strategy: req.strategy,
    targetGrid,
    z0,
    targetZ0,
    points,
    physical,
    counts,
    maxRoundtripRel,
    roundtripPass: maxRoundtripRel <= roundtripTol,
    createdAt: new Date().toISOString(),
    fingerprint,
  };
}

function finiteOrNull(x: number): number {
  return Number.isFinite(x) ? x : Infinity;
}

function pointEigenExcess(s: M2): number {
  const conj = (x: C): C => ({ re: x.re, im: -x.im });
  const mul = (a: C, b: C): C => ({ re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re });
  const add = (a: C, b: C): C => ({ re: a.re + b.re, im: a.im + b.im });
  const h00 = add(mul(conj(s.m00), s.m00), mul(conj(s.m10), s.m10));
  const h01 = add(mul(conj(s.m00), s.m01), mul(conj(s.m10), s.m11));
  const h11 = add(mul(conj(s.m01), s.m01), mul(conj(s.m11), s.m11));
  const diff = (h00.re - h11.re) / 2;
  const lambdaMax = (h00.re + h11.re) / 2 + Math.sqrt(diff * diff + h01.re * h01.re + h01.im * h01.im);
  return Math.max(0, lambdaMax - 1);
}

function summarizePhysical(points: PointDiagnostic[]): PhysicalDiagnostics {
  let excess = 0;
  let rec = 0;
  for (const p of points) {
    if (p.passivityExcess !== null) excess = Math.max(excess, p.passivityExcess);
    if (p.dutS) rec = Math.max(rec, abs(sub(p.dutS.m01, p.dutS.m10)));
  }
  return {
    passivityExcess: excess,
    reciprocityResidual: rec,
    passive: excess <= 1e-9,
    reciprocal: rec <= 1e-9,
  };
}

function sub(a: C, b: C): C {
  return { re: a.re - b.re, im: a.im - b.im };
}

function makeFingerprint(req: DeembedRequest, grid: number[]): string {
  const h = (s: string): string => {
    let h1 = 0xdeadbeef ^ s.length;
    for (let i = 0; i < s.length; i++) {
      h1 = Math.imul(h1 ^ s.charCodeAt(i), 2654435761);
    }
    return (h1 >>> 0).toString(16).padStart(8, "0");
  };
  const sig = JSON.stringify({
    s: req.strategy,
    g: grid,
    z: req.measured.z0,
    tz: req.targetZ0 ?? null,
    l: req.left.freq.length,
    r: req.right.freq.length,
    m: req.measured.freq.length,
  });
  return h(sig);
}


