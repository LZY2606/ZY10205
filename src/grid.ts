import { lerpM, M2 } from "./cmat.js";
import { Network } from "./rf.js";

/**
 * 频率对齐：绝不按数组下标直接相乘。
 * 插值一律在复数直角分量 (re, im) 上逐元素线性进行；
 * 落在源网格之外的目标频点按“端部斜率外推”，并逐点记录 extrapolated。
 */
export type GridStrategy = "union" | "measured" | "left" | "right";

export interface AlignedPoint {
  freq: number;
  mat: M2;
  /** 插值权重所用的左右源频点下标；外推时为端部两个点。 */
  loIdx: number;
  hiIdx: number;
  weight: number;
  extrapolated: boolean;
  /** 距源网格最近端部的距离（Hz），外推诊断用。 */
  extrapolationSpan: number;
}

export type AlignedNetwork = Omit<Network, "sParam"> & {
  points: AlignedPoint[];
  sourceFreq: number[];
};

export function alignToGrid(
  n: Network,
  targetFreq: number[],
): AlignedNetwork {
  const sf = n.freq;
  const points: AlignedPoint[] = targetFreq.map((f) => {
    // 二分查找右侧插入点
    let lo = 0;
    let hi = sf.length - 1;
    if (f <= sf[0]!) {
      const span = sf[1]! - sf[0]!;
      const t = (f - sf[0]!) / span;
      return {
        freq: f,
        mat: lerpM(n.sParam[0]!, n.sParam[1]!, t),
        loIdx: 0,
        hiIdx: 1,
        weight: t,
        extrapolated: f < sf[0]!,
        extrapolationSpan: f < sf[0]! ? sf[0]! - f : 0,
      };
    }
    if (f >= sf[sf.length - 1]!) {
      const a = sf.length - 2;
      const b = sf.length - 1;
      const span = sf[b]! - sf[a]!;
      const t = (f - sf[a]!) / span;
      return {
        freq: f,
        mat: lerpM(n.sParam[a]!, n.sParam[b]!, t),
        loIdx: a,
        hiIdx: b,
        weight: t,
        extrapolated: f > sf[b]!,
        extrapolationSpan: f > sf[b]! ? f - sf[b]! : 0,
      };
    }
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (sf[mid]! <= f) lo = mid;
      else hi = mid;
    }
    const span = sf[hi]! - sf[lo]!;
    const t = span === 0 ? 0 : (f - sf[lo]!) / span;
    return {
      freq: f,
      mat: lerpM(n.sParam[lo]!, n.sParam[hi]!, t),
      loIdx: lo,
      hiIdx: hi,
      weight: t,
      extrapolated: false,
      extrapolationSpan: 0,
    };
  });
  return {
    freq: targetFreq.slice(),
    points,
    z0: n.z0.slice(),
    name: n.name,
    sourceFreq: sf.slice(),
  };
}

export function buildTargetGrid(
  measuredFreq: number[],
  leftFreq: number[],
  rightFreq: number[],
  strategy: GridStrategy,
): number[] {
  const sortedMerge = (a: number[], b: number[]): number[] => {
    const set = new Set<number>([...a, ...b]);
    return [...set].sort((x, y) => x - y);
  };
  switch (strategy) {
    case "measured":
      return measuredFreq.slice();
    case "left":
      return leftFreq.slice();
    case "right":
      return rightFreq.slice();
    case "union":
      return sortedMerge(sortedMerge(measuredFreq, leftFreq), rightFreq);
  }
}

/** 三个网格是否两两完全一致（用于判定残差是否为机器精度级）。 */
export function sameGrid(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((f, i) => f === b[i]);
}
