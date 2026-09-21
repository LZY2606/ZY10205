/**
 * 复数运算：全程以 { re, im } 直角分量表示。
 * 任何插值/比较都基于直角分量，避免极坐标绕圈导致的伪影。
 */
export interface C {
  re: number;
  im: number;
}

export const c = (re: number, im = 0): C => ({ re, im });
export const ZERO: C = { re: 0, im: 0 };
export const ONE: C = { re: 1, im: 0 };
export const I: C = { re: 0, im: 1 };

export const add = (a: C, b: C): C => ({ re: a.re + b.re, im: a.im + b.im });
export const sub = (a: C, b: C): C => ({ re: a.re - b.re, im: a.im - b.im });
export const mul = (a: C, b: C): C => ({
  re: a.re * b.re - a.im * b.im,
  im: a.re * b.im + a.im * b.re,
});
export const scale = (a: C, k: number): C => ({ re: a.re * k, im: a.im * k });
export const neg = (a: C): C => ({ re: -a.re, im: -a.im });
export const conj = (a: C): C => ({ re: a.re, im: -a.im });
export const abs = (a: C): number => Math.hypot(a.re, a.im);
export const abs2 = (a: C): number => a.re * a.re + a.im * a.im;
export const phase = (a: C): number => Math.atan2(a.im, a.re);
export const inv = (a: C): C => {
  const d = a.re * a.re + a.im * a.im;
  return { re: a.re / d, im: -a.im / d };
};
export const div = (a: C, b: C): C => nz(mul(a, inv(b)));

/** 规范化 -0 -> 0，便于结构相等比较与稳定序列化。 */
export const nz = (a: C): C => ({
  re: Object.is(a.re, -0) ? 0 : a.re,
  im: Object.is(a.im, -0) ? 0 : a.im,
});
export const isFiniteC = (a: C): boolean =>
  Number.isFinite(a.re) && Number.isFinite(a.im);

/** dB（幅度），|0| -> -Infinity。 */
export const magDb = (a: C): number => 20 * Math.log10(abs(a));

export const eqC = (a: C, b: C, tol = 1e-12): boolean =>
  abs(sub(a, b)) <= tol;

export const fmt = (a: C, digits = 4): string =>
  `${a.re.toFixed(digits)}${a.im >= 0 ? "+" : ""}${a.im.toFixed(digits)}j`;
