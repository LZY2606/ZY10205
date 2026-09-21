import type { Complex, Matrix2 } from './types.js';

export const c = (re = 0, im = 0): Complex => ({ re, im });

export const add = (a: Complex, b: Complex): Complex => ({ re: a.re + b.re, im: a.im + b.im });
export const sub = (a: Complex, b: Complex): Complex => ({ re: a.re - b.re, im: a.im - b.im });
export const mul = (a: Complex, b: Complex): Complex => ({
  re: a.re * b.re - a.im * b.im,
  im: a.re * b.im + a.im * b.re,
});
export const scale = (a: Complex, scalar: number): Complex => ({ re: a.re * scalar, im: a.im * scalar });
export const neg = (a: Complex): Complex => ({ re: -a.re, im: -a.im });
export const conj = (a: Complex): Complex => ({ re: a.re, im: -a.im });

export const div = (a: Complex, b: Complex): Complex => {
  const denominator = b.re * b.re + b.im * b.im;
  if (!Number.isFinite(denominator) || denominator === 0) {
    return { re: Number.NaN, im: Number.NaN };
  }
  return {
    re: (a.re * b.re + a.im * b.im) / denominator,
    im: (a.im * b.re - a.re * b.im) / denominator,
  };
};

export const abs2 = (a: Complex): number => a.re * a.re + a.im * a.im;
export const abs = (a: Complex): number => Math.hypot(a.re, a.im);
export const arg = (a: Complex): number => Math.atan2(a.im, a.re);

export const isFiniteComplex = (a: Complex): boolean => Number.isFinite(a.re) && Number.isFinite(a.im);

export const matrix = (a: Complex, b: Complex, cc: Complex, d: Complex): Matrix2 => [a, b, cc, d];

export const mZero = (): Matrix2 => [c(), c(), c(), c()];
export const mIdentity = (): Matrix2 => [c(1), c(), c(), c(1)];

export const mScale = (m: Matrix2, scalar: Complex): Matrix2 =>
  [mul(m[0], scalar), mul(m[1], scalar), mul(m[2], scalar), mul(m[3], scalar)];

export const mAdd = (a: Matrix2, b: Matrix2): Matrix2 =>
  [add(a[0], b[0]), add(a[1], b[1]), add(a[2], b[2]), add(a[3], b[3])];

export const mSub = (a: Matrix2, b: Matrix2): Matrix2 =>
  [sub(a[0], b[0]), sub(a[1], b[1]), sub(a[2], b[2]), sub(a[3], b[3])];

export const mMul = (a: Matrix2, b: Matrix2): Matrix2 => [
  add(mul(a[0], b[0]), mul(a[1], b[2])),
  add(mul(a[0], b[1]), mul(a[1], b[3])),
  add(mul(a[2], b[0]), mul(a[3], b[2])),
  add(mul(a[2], b[1]), mul(a[3], b[3])),
];

export const mDet = (m: Matrix2): Complex => sub(mul(m[0], m[3]), mul(m[1], m[2]));

export const mConj = (m: Matrix2): Matrix2 => [conj(m[0]), conj(m[1]), conj(m[2]), conj(m[3])];

export const mTranspose = (m: Matrix2): Matrix2 => [m[0], m[2], m[1], m[3]];

export const mMaxAbs = (m: Matrix2): number => Math.max(abs(m[0]), abs(m[1]), abs(m[2]), abs(m[3]));

export const mIsFinite = (m: Matrix2): boolean => m.every(isFiniteComplex);

export const mFrobenius = (m: Matrix2): number =>
  Math.sqrt(abs2(m[0]) + abs2(m[1]) + abs2(m[2]) + abs2(m[3]));

export const sqrtComplex = (z: Complex): Complex => {
  const modulus = abs(z);
  return {
    re: Math.sqrt(Math.max(0, (modulus + z.re) / 2)),
    im: Math.sign(z.im || 0) * Math.sqrt(Math.max(0, (modulus - z.re) / 2)),
  };
};

export const mSolve2 = (a: Matrix2, b: Matrix2): { x: Matrix2; pivot: number } => {
  const p00 = abs(a[0]);
  const p10 = abs(a[2]);
  const swapped = p10 > p00;
  const a00 = swapped ? a[2] : a[0];
  const a01 = swapped ? a[3] : a[1];
  const a10 = swapped ? a[0] : a[2];
  const a11 = swapped ? a[1] : a[3];
  const b00 = swapped ? b[2] : b[0];
  const b01 = swapped ? b[3] : b[1];
  const b10 = swapped ? b[0] : b[2];
  const b11 = swapped ? b[1] : b[3];
  const firstPivot = abs(a00);
  if (firstPivot === 0 || !Number.isFinite(firstPivot)) {
    return { x: [c(Number.NaN), c(Number.NaN), c(Number.NaN), c(Number.NaN)], pivot: firstPivot || 0 };
  }

  const elimination = div(a10, a00);
  const upper11 = sub(a11, mul(elimination, a01));
  const upperPivot = abs(upper11);
  if (upperPivot === 0 || !Number.isFinite(upperPivot)) {
    return {
      x: [c(Number.NaN), c(Number.NaN), c(Number.NaN), c(Number.NaN)],
      pivot: Math.min(firstPivot, upperPivot || 0),
    };
  }

  const rhs10 = sub(b10, mul(elimination, b00));
  const rhs11 = sub(b11, mul(elimination, b01));
  const y10 = div(rhs10, upper11);
  const y11 = div(rhs11, upper11);
  const y00 = div(sub(b00, mul(a01, y10)), a00);
  const y01 = div(sub(b01, mul(a01, y11)), a00);
  return swapped
    ? { x: [y10, y11, y00, y01], pivot: Math.min(firstPivot, upperPivot) }
    : { x: [y00, y01, y10, y11], pivot: Math.min(firstPivot, upperPivot) };
};

export const mInverse2 = (a: Matrix2): { inverse: Matrix2; pivot: number } => {
  const solved = mSolve2(a, mIdentity());
  return { inverse: solved.x, pivot: solved.pivot };
};

export const mSolveRight2 = (matrix: Matrix2, rightMultiplier: Matrix2): Matrix2 => {
  const determinant = mDet(matrix);
  const inverse: Matrix2 = [
    div(matrix[3], determinant),
    div(neg(matrix[1]), determinant),
    div(neg(matrix[2]), determinant),
    div(matrix[0], determinant),
  ];
  return mMul(rightMultiplier, inverse);
};

export const eigen2x2Hermitian = (m: Matrix2): [number, number] => {
  const a = Math.max(0, m[0].re);
  const d = Math.max(0, m[3].re);
  const off = Math.hypot(m[1].re, m[1].im);
  const half = (a + d) / 2;
  const discriminant = Math.sqrt(Math.max(0, ((a - d) / 2) ** 2 + off * off));
  return [Math.max(0, half - discriminant), Math.max(0, half + discriminant)];
};

export const singularValues = (m: Matrix2): [number, number] => {
  const product = mMul(m, mConj(mTranspose(m)));
  const eigenvalues = eigen2x2Hermitian(product);
  return [Math.sqrt(eigenvalues[0]), Math.sqrt(eigenvalues[1])];
};

export const conditionNumber = (m: Matrix2): number => {
  const [minimum, maximum] = singularValues(m);
  if (!mIsFinite(m) || !Number.isFinite(minimum) || !Number.isFinite(maximum)) return Number.POSITIVE_INFINITY;
  if (minimum === 0) return Number.POSITIVE_INFINITY;
  return maximum / minimum;
};

export const wrapPhase = (phase: number): number => {
  let result = phase;
  while (result <= -Math.PI) result += 2 * Math.PI;
  while (result > Math.PI) result -= 2 * Math.PI;
  return result;
};
