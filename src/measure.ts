import { abs, phase } from "./complex.js";
import { M2 } from "./cmat.js";
import { Network } from "./rf.js";

/**
 * 群时延 τ_g = -d(unwrap(∠S21))/dω（秒）。
 * 端部用单侧差分，内部中心差分；与频率网格是否均匀无关。
 */
export function groupDelay(n: Network): (number | null)[] {
  const ph = n.sParam.map((s) => phase(s.m10));
  const unwrapped = unwrap(ph);
  const out: (number | null)[] = [];
  for (let i = 0; i < n.freq.length; i++) {
    if (n.sParam[i] && abs(n.sParam[i]!.m10) === 0) {
      out.push(null);
      continue;
    }
    if (i === 0) {
      const dw = 2 * Math.PI * (n.freq[1]! - n.freq[0]!);
      out.push(-(unwrapped[1]! - unwrapped[0]!) / dw);
    } else if (i === n.freq.length - 1) {
      const dw = 2 * Math.PI * (n.freq[i]! - n.freq[i - 1]!);
      out.push(-(unwrapped[i]! - unwrapped[i - 1]!) / dw);
    } else {
      const dw = 2 * Math.PI * (n.freq[i + 1]! - n.freq[i - 1]!);
      out.push(-(unwrapped[i + 1]! - unwrapped[i - 1]!) / dw);
    }
  }
  return out;
}

export function unwrap(phases: number[]): number[] {
  const out = phases.slice();
  for (let i = 1; i < out.length; i++) {
    let d = out[i]! - out[i - 1]!;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    out[i] = out[i - 1]! + d;
  }
  return out;
}

export type SKey = "m00" | "m01" | "m10" | "m11";
export const S_LABEL: Record<SKey, string> = {
  m00: "S11",
  m01: "S12",
  m10: "S21",
  m11: "S22",
};

export function magDbSeries(n: { sParam: M2[] }, key: SKey): number[] {
  return n.sParam.map((s) => 20 * Math.log10(Math.max(abs(s[key]), 1e-300)));
}
export function phaseSeries(n: { sParam: M2[] }, key: SKey): number[] {
  return n.sParam.map((s) => phase(s[key]));
}
export function smithXY(s: { re: number; im: number }): { x: number; y: number } {
  // 反射系数直接落在单位圆；y 取 Smith 惯例（+j 在上）
  return { x: s.re, y: s.im };
}
