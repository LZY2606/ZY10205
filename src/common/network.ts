import type { Complex, Matrix2, TwoPortNetwork, SParameterPoint } from './types.js';
import {
  abs,
  add,
  c,
  conditionNumber,
  div,
  mAdd,
  mConj,
  mMul,
  mScale,
  mSolve2,
  mSolveRight2,
  mSub,
  mTranspose,
  mul,
  neg,
  singularValues,
  sub,
} from './complex.js';

const diagonal = (a: Complex, b: Complex): Matrix2 => [a, c(), c(), b];
const realDiagonal = (a: number, b: number): Matrix2 => diagonal(c(a), c(b));

const complexDiagonal = (values: [Complex, Complex]): Matrix2 => diagonal(values[0], values[1]);

export const positiveReferenceResistance = (referenceOhm: [Complex, Complex]): boolean =>
  referenceOhm.every((z) => Number.isFinite(z.re) && z.re > 0);

export const resistanceRootMatrix = (referenceOhm: [Complex, Complex]): Matrix2 =>
  realDiagonal(Math.sqrt(referenceOhm[0].re), Math.sqrt(referenceOhm[1].re));

export const resistanceMatrix = (referenceOhm: [Complex, Complex]): Matrix2 =>
  realDiagonal(referenceOhm[0].re, referenceOhm[1].re);

export const sToZ = (s: Matrix2, referenceOhm: [Complex, Complex]): Matrix2 => {
  if (!positiveReferenceResistance(referenceOhm)) {
    return [c(Number.NaN), c(Number.NaN), c(Number.NaN), c(Number.NaN)];
  }
  const identity = realDiagonal(1, 1);
  const d = resistanceRootMatrix(referenceOhm);
  const z0 = complexDiagonal(referenceOhm);
  const normalized = mSolveRight2(mSub(identity, s), mAdd(identity, s));
  const first = mMul(mMul(d, normalized), d);
  return first;
};

export const zToS = (z: Matrix2, referenceOhm: [Complex, Complex]): Matrix2 => {
  if (!positiveReferenceResistance(referenceOhm)) {
    return [c(Number.NaN), c(Number.NaN), c(Number.NaN), c(Number.NaN)];
  }
  const identity = realDiagonal(1, 1);
  const d = resistanceRootMatrix(referenceOhm);
  const dInverse = realDiagonal(1 / Math.sqrt(referenceOhm[0].re), 1 / Math.sqrt(referenceOhm[1].re));
  const z0 = complexDiagonal(referenceOhm);
  const numerator = mSub(z, z0);
  const denominator = mAdd(z, z0);
  const normalizedS = mSolveRight2(denominator, numerator);
  return mMul(mMul(dInverse, normalizedS), d);
};

const conjDiag = (value: Complex): Complex => ({ re: value.re, im: -value.im });

export const renormalizeS = (
  s: Matrix2,
  fromReferenceOhm: [Complex, Complex],
  toReferenceOhm: [Complex, Complex],
): Matrix2 => zToS(sToZ(s, fromReferenceOhm), toReferenceOhm);

export const swapPorts = (s: Matrix2): Matrix2 => [s[3], s[2], s[1], s[0]];

export const swapNetworkPorts = (network: TwoPortNetwork): TwoPortNetwork => ({
  ...network,
  name: `${network.name}-swapped`,
  referenceOhm: [network.referenceOhm[1], network.referenceOhm[0]],
  points: network.points.map((point) => ({
    frequencyHz: point.frequencyHz,
    s: swapPorts(point.s),
  })),
});

export const sToT = (s: Matrix2): { t: Matrix2; pivot: number } => {
  const s21 = s[2];
  if (abs(s21) === 0 || !Number.isFinite(abs(s21))) {
    return {
      t: [c(Number.NaN), c(Number.NaN), c(Number.NaN), c(Number.NaN)],
      pivot: 0,
    };
  }
  const determinant = sub(mul(s[0], s[3]), mul(s[1], s[2]));
  return {
    t: [div(c(1), s21), neg(div(s[3], s21)), div(s[0], s21), neg(div(determinant, s21))],
    pivot: abs(s21),
  };
};

export const tToS = (t: Matrix2): { s: Matrix2; pivot: number } => {
  const t00 = t[0];
  if (abs(t00) === 0 || !Number.isFinite(abs(t00))) {
    return {
      s: [c(Number.NaN), c(Number.NaN), c(Number.NaN), c(Number.NaN)],
      pivot: 0,
    };
  }
  const s21 = div(c(1), t00);
  const s22 = neg(mul(t[1], s21));
  const s11 = mul(t[2], s21);
  const s12 = sub(t[3], div(mul(t[2], t[1]), t00));
  return { s: [s11, s12, s21, s22], pivot: abs(t00) };
};

export const cascadeS = (left: Matrix2, right: Matrix2): Matrix2 => {
  const leftT = sToT(left).t;
  const rightT = sToT(right).t;
  return tToS(mMul(leftT, rightT)).s;
};

export const inverseT = (t: Matrix2): { inverse: Matrix2; pivot: number } => {
  const determinant = sub(mul(t[0], t[3]), mul(t[1], t[2]));
  const pivot = Math.min(
    Math.hypot(t[0].re, t[0].im),
    Math.hypot(t[1].re, t[1].im),
    Math.hypot(t[2].re, t[2].im),
    Math.hypot(t[3].re, t[3].im),
  );
  if (Math.hypot(determinant.re, determinant.im) === 0) {
    return {
      inverse: [c(Number.NaN), c(Number.NaN), c(Number.NaN), c(Number.NaN)],
      pivot: 0,
    };
  }
  return {
    inverse: [
      div(t[3], determinant),
      div(neg(t[1]), determinant),
      div(neg(t[2]), determinant),
      div(t[0], determinant),
    ],
    pivot,
  };
};

export const passivityMargin = (s: Matrix2): number => {
  const values = singularValues(s);
  const maximum = Math.max(values[0], values[1]);
  if (!Number.isFinite(maximum)) return Number.NaN;
  return 1 - maximum;
};

export const reciprocityError = (s: Matrix2): number => abs(sub(s[1], s[2]));

export const matrixConditionNumber = conditionNumber;

export const networkFrequencies = (network: TwoPortNetwork): number[] =>
  network.points.map((point) => point.frequencyHz);

export const sortedUnique = (values: number[]): number[] =>
  [...new Set(values.map((value) => Math.round(value * 1e6)))]
    .map((value) => value / 1e6)
    .sort((a, b) => a - b);

const sameFrequency = (a: number, b: number): boolean => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

const interpolateComplex = (a: Complex, b: Complex, ratio: number): Complex => ({
  re: a.re + (b.re - a.re) * ratio,
  im: a.im + (b.im - a.im) * ratio,
});

export const interpolatePoint = (
  network: TwoPortNetwork,
  frequencyHz: number,
): { point: SParameterPoint; extrapolated: boolean } => {
  const points = network.points;
  if (points.length === 0) throw new Error(`Network ${network.name} has no frequency points`);

  const first = points[0]!;
  const last = points[points.length - 1]!;
  if (sameFrequency(frequencyHz, first.frequencyHz)) return { point: first, extrapolated: false };
  if (sameFrequency(frequencyHz, last.frequencyHz)) return { point: last, extrapolated: false };

  if (frequencyHz < first.frequencyHz) {
    if (points.length < 2) return { point: first, extrapolated: true };
    const second = points[1]!;
    const ratio = (frequencyHz - first.frequencyHz) / (second.frequencyHz - first.frequencyHz);
    return { point: pointAt(first, second, ratio, frequencyHz), extrapolated: true };
  }

  if (frequencyHz > last.frequencyHz) {
    if (points.length < 2) return { point: last, extrapolated: true };
    const previous = points[points.length - 2]!;
    const ratio = 1 + (frequencyHz - last.frequencyHz) / (last.frequencyHz - previous.frequencyHz);
    return { point: pointAt(previous, last, ratio, frequencyHz), extrapolated: true };
  }

  for (let index = 0; index < points.length - 1; index += 1) {
    const lower = points[index]!;
    const upper = points[index + 1]!;
    if (frequencyHz >= lower.frequencyHz && frequencyHz <= upper.frequencyHz) {
      const ratio = (frequencyHz - lower.frequencyHz) / (upper.frequencyHz - lower.frequencyHz);
      return { point: pointAt(lower, upper, ratio, frequencyHz), extrapolated: false };
    }
  }

  return { point: last, extrapolated: false };
};

const pointAt = (lower: SParameterPoint, upper: SParameterPoint, ratio: number, frequencyHz: number): SParameterPoint => ({
  frequencyHz,
  s: [
    interpolateComplex(lower.s[0], upper.s[0], ratio),
    interpolateComplex(lower.s[1], upper.s[1], ratio),
    interpolateComplex(lower.s[2], upper.s[2], ratio),
    interpolateComplex(lower.s[3], upper.s[3], ratio),
  ] as Matrix2,
});

export const chooseGrid = (
  measurement: TwoPortNetwork,
  left: TwoPortNetwork,
  right: TwoPortNetwork,
  strategy: 'measurement' | 'union' | 'left' | 'right',
): number[] => {
  if (strategy === 'measurement') return networkFrequencies(measurement);
  if (strategy === 'left') return networkFrequencies(left);
  if (strategy === 'right') return networkFrequencies(right);
  return sortedUnique([
    ...networkFrequencies(measurement),
    ...networkFrequencies(left),
    ...networkFrequencies(right),
  ]);
};
