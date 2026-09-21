import { M2, subM, frob } from "./cmat.js";
import { DeembedReport, PointDiagnostic } from "./deembed.js";

/**
 * 两方案按频点对比（而不是按下标）：
 * 以频率值做内连接，DUT S 在频点上求复矩阵差。
 */
export interface DiffPoint {
  freq: number;
  abs: number;
  rel: number;
  /** 元素级复差（直角分量）。 */
  dS: M2 | null;
  left: PointDiagnostic;
  right: PointDiagnostic;
}

export function compareReports(a: DeembedReport, b: DeembedReport): DiffPoint[] {
  const bMap = new Map<number, PointDiagnostic>();
  b.points.forEach((p) => bMap.set(p.freq, p));
  const out: DiffPoint[] = [];
  for (const pa of a.points) {
    const pb = bMap.get(pa.freq);
    if (!pb) continue;
    let dS: M2 | null = null;
    let absErr = 0;
    let rel = 0;
    if (pa.dutS && pb.dutS) {
      dS = subM(pa.dutS, pb.dutS);
      absErr = frob(dS);
      rel = absErr / Math.max(1, frob(pa.dutS));
    }
    out.push({ freq: pa.freq, abs: absErr, rel, dS, left: pa, right: pb });
  }
  return out.sort((x, y) => x.freq - y.freq);
}

export function summarizeDiff(points: DiffPoint[]): {
  count: number;
  maxAbs: number;
  maxRel: number;
  freqMaxAbs: number | null;
  bothRecoverable: number;
  eitherNull: number;
} {
  let maxAbs = 0;
  let maxRel = 0;
  let freqMaxAbs: number | null = null;
  let bothRecoverable = 0;
  let eitherNull = 0;
  for (const p of points) {
    if (p.dS) {
      bothRecoverable++;
      if (p.abs > maxAbs) {
        maxAbs = p.abs;
        freqMaxAbs = p.freq;
      }
      if (p.rel > maxRel) maxRel = p.rel;
    } else {
      eitherNull++;
    }
  }
  return { count: points.length, maxAbs, maxRel, freqMaxAbs, bothRecoverable, eitherNull };
}
