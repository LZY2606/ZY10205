/**
 * 2x2 复数矩阵：元素按行主序 [m00,m01;m10,m11]。
 * 奇异度用 GESV 风格的倒数估计：rcond = 1/(||A|| * ||A^-1||)，
 * 其倒数即条件数估计。不做任何零矩阵填补。
 */
import { C, ONE, ZERO, abs, add, c, div, inv, isFiniteC, mul, neg, scale, sub } from "./complex.js";

export interface M2 {
  m00: C;
  m01: C;
  m10: C;
  m11: C;
}

export const m = (m00: C, m01: C, m10: C, m11: C): M2 => ({ m00, m01, m10, m11 });
export const ident: M2 = { m00: ONE, m01: ZERO, m10: ZERO, m11: ONE };
export const zero: M2 = { m00: ZERO, m01: ZERO, m10: ZERO, m11: ZERO };

export const addM = (a: M2, b: M2): M2 => ({
  m00: add(a.m00, b.m00),
  m01: add(a.m01, b.m01),
  m10: add(a.m10, b.m10),
  m11: add(a.m11, b.m11),
});

export const subM = (a: M2, b: M2): M2 => ({
  m00: sub(a.m00, b.m00),
  m01: sub(a.m01, b.m01),
  m10: sub(a.m10, b.m10),
  m11: sub(a.m11, b.m11),
});

export const scaleM = (a: M2, k: number): M2 => ({
  m00: scale(a.m00, k),
  m01: scale(a.m01, k),
  m10: scale(a.m10, k),
  m11: scale(a.m11, k),
});

export const mulM = (a: M2, b: M2): M2 => ({
  m00: add(mul(a.m00, b.m00), mul(a.m01, b.m10)),
  m01: add(mul(a.m00, b.m01), mul(a.m01, b.m11)),
  m10: add(mul(a.m10, b.m00), mul(a.m11, b.m10)),
  m11: add(mul(a.m10, b.m01), mul(a.m11, b.m11)),
});

/** 行列式。 */
export const det = (a: M2): C =>
  sub(mul(a.m00, a.m11), mul(a.m01, a.m10));

/**
 * 求逆，并返回逐频点诊断所需的信息。
 * 返回 null 仅当行列式在数值上恒为 0；
 * 条件数超过 warnCond 时结果仍然返回（不填补零矩阵），由调用方标记。
 */
export interface InvResult {
  inv: M2;
  det: C;
  /** 无穷范数（行和绝对值之和的最大值）。 */
  normInf: number;
  cond: number;
  exactSingular: boolean;
}

export function invertInfo(a: M2): InvResult {
  const d = det(a);
  const normInf = Math.max(
    abs(a.m00) + abs(a.m01),
    abs(a.m10) + abs(a.m11),
  );
  const absDet = abs(d);
  if (absDet === 0 || !isFiniteC(d)) {
    return {
      inv: zero,
      det: d,
      normInf,
      cond: Infinity,
      exactSingular: true,
    };
  }
  const invM: M2 = {
    m00: div(a.m11, d),
    m01: neg(div(a.m01, d)),
    m10: neg(div(a.m10, d)),
    m11: div(a.m00, d),
  };
  const invNormInf = Math.max(
    abs(invM.m00) + abs(invM.m01),
    abs(invM.m10) + abs(invM.m11),
  );
  // 2x2 下 ||A||inf * ||A^-1||inf 是条件数的可靠估计（上界的紧凑近似）。
  let cond = normInf * invNormInf;
  if (!Number.isFinite(cond)) cond = Number.MAX_VALUE;
  return { inv: invM, det: d, normInf, cond, exactSingular: false };
}

export function invert(a: M2): M2 {
  return invertInfo(a).inv;
}

/** A*b，b 为 2 维复向量。 */
export function mv(a: M2, b: [C, C]): [C, C] {
  return [
    add(mul(a.m00, b[0]), mul(a.m01, b[1])),
    add(mul(a.m10, b[0]), mul(a.m11, b[1])),
  ];
}

/** Frobenius 范数。 */
export function frob(a: M2): number {
  return Math.sqrt(
    abs2s(a.m00) + abs2s(a.m01) + abs2s(a.m10) + abs2s(a.m11),
  );
}
function abs2s(x: C): number {
  return x.re * x.re + x.im * x.im;
}

/** 元素级线性插值（直角分量）。 */
export function lerpM(a: M2, b: M2, t: number): M2 {
  return {
    m00: { re: a.m00.re + (b.m00.re - a.m00.re) * t, im: a.m00.im + (b.m00.im - a.m00.im) * t },
    m01: { re: a.m01.re + (b.m01.re - a.m01.re) * t, im: a.m01.im + (b.m01.im - a.m01.im) * t },
    m10: { re: a.m10.re + (b.m10.re - a.m10.re) * t, im: a.m10.im + (b.m10.im - a.m10.im) * t },
    m11: { re: a.m11.re + (b.m11.re - a.m11.re) * t, im: a.m11.im + (b.m11.im - a.m11.im) * t },
  };
}

export function isFiniteM(a: M2): boolean {
  return [a.m00, a.m01, a.m10, a.m11].every(isFiniteC);
}

export function fromReIm(v: number[]): M2 {
  // [re00, im00, re01, im01, re10, im10, re11, im11]
  return m(
    c(v[0]!, v[1]),
    c(v[2]!, v[3]),
    c(v[4]!, v[5]),
    c(v[6]!, v[7]),
  );
}
export function toReIm(a: M2): number[] {
  return [a.m00.re, a.m00.im, a.m01.re, a.m01.im, a.m10.re, a.m10.im, a.m11.re, a.m11.im];
}
