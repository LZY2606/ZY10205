import { C, ONE, ZERO, abs, add, c, div, mul, neg, nz, sub } from "./complex.js";
import { M2, addM, det, frob, ident, invertInfo, m, mulM, subM } from "./cmat.js";

/**
 * 两端口网络。
 *
 * 固定口径（每次去嵌均显式记录）：
 * - 端口顺序：端口 1 在左（输入），端口 2 在右（输出）；
 * - 波定义：功率波 a/b，a 为入射、b 为出射（参考阻抗 z0 可为逐端口实数）；
 * - S 排列：S = [[S11,S12],[S21,S22]]；
 * - T（传输/ABCD 波级联）约定：[a1;b1] = T [b2;a2]，
 *   于是 N1 级联 N2（信号自左向右）时 T_total = T1 * T2。
 */
export interface Network {
  /** Hz，严格递增。 */
  freq: number[];
  sParam: M2[];
  /** 逐端口参考阻抗（实数，单位欧姆）；长度恒为 2。 */
  z0: number[];
  name?: string;
}

/** S -> T。返回逐矩阵诊断；s21==0 时为严格奇异（exactSingular）。 */
export interface S2TResult {
  t: M2 | null;
  cond: number;
  det: C;
  exactSingular: boolean;
  /** |S21|，主判据。 */
  s21Abs: number;
}

export function sToTInfo(s: M2): S2TResult {
  const s21 = s.m10;
  const s21Abs = abs(s21);
  // 用伴随式表达，避免先除法再放大噪声：
  // T11=(detS)/S21, T12=S11/S21, T21=-S22/S21, T22=1/S21
  const ds = det(s);
  if (s21Abs === 0) {
    return { t: null, cond: Infinity, det: ds, exactSingular: true, s21Abs };
  }
  // 标准传输（T/ABCD 波）约定：[a1;b1] = T [b2;a2]，
  // T11=-detS/S21, T12=S11/S21, T21=-S22/S21, T22=1/S21。
  const t = m(
    nz(neg(div(ds, s21))),
    nz(div(s.m00, s21)),
    nz(neg(div(s.m11, s21))),
    nz(div(ONE, s21)),
  );
  // 条件数直接在逆变换相关量上估计：T 各元素与 1/|S21| 同阶
  // cond_inf(T) 的紧凑估计：||T||inf ≈ (1+|S11|+|S12|+|S22|+|detS|)/|S21|，
  // T^-1 与 T 同阶（伴随型互逆），故 cond ≈ ||T||inf^2。
  const tNormApprox =
    (1 + abs(s.m00) + abs(s.m01) + abs(s.m11) + abs(ds)) / s21Abs;
  const cond = tNormApprox * tNormApprox;
  return { t, cond: Number.isFinite(cond) ? cond : Infinity, det: ds, exactSingular: false, s21Abs };
}

export function sToT(s: M2): M2 {
  const r = sToTInfo(s);
  if (!r.t) throw new Error("S21=0，S->T 严格奇异，无法级联");
  return r.t;
}

/** T -> S（伴随式回代，归一到 1/T22）。t22==0 为严格奇异。 */
export interface T2SResult {
  s: M2 | null;
  exactSingular: boolean;
  cond: number;
}

export function tToSInfo(t: M2): T2SResult {
  const t22Abs = abs(t.m11);
  if (t22Abs === 0) {
    return { s: null, exactSingular: true, cond: Infinity };
  }
  const detT = det(t);
  // 逆映射：S11=T12/T22, S12=detT/T22, S21=1/T22, S22=-T21/T22。
  const s: M2 = m(
    nz(div(t.m01, t.m11)),
    nz(div(detT, t.m11)),
    nz(div(ONE, t.m11)),
    nz(neg(div(t.m10, t.m11))),
  );
  const sNorm = Math.max(
    abs(s.m00) + abs(s.m01),
    abs(s.m10) + abs(s.m11),
  );
  return { s, exactSingular: false, cond: sNorm * t22Abs > 0 ? 1 / (sNorm * t22Abs) : Infinity };
}

export function tToS(t: M2): M2 {
  const r = tToSInfo(t);
  if (!r.s) throw new Error("T22=0，T->S 严格奇异");
  return r.s;
}

/** 级联两个同频网格网络（左 * 右）。 */
export function cascade(a: Network, b: Network): Network {
  if (a.freq.length !== b.freq.length) {
    throw new Error("级联要求频率网格一致（请先对齐）");
  }
  a.freq.forEach((f, i) => {
    if (f !== b.freq[i]) throw new Error(`级联频点不一致 @ ${f}`);
  });
  const out: M2[] = [];
  for (let i = 0; i < a.freq.length; i++) {
    const ta = sToT(a.sParam[i]!);
    const tb = sToT(b.sParam[i]!);
    out.push(tToS(mulM(ta, tb)));
  }
  return { freq: a.freq.slice(), sParam: out, z0: a.z0.slice() };
}

/**
 * 参考阻抗重归一化（功率波口径），支持逐端口不同阻抗。
 *
 * 严格按功率波定义推导（a=(V+zI)/(2√z), b=(V-zI)/(2√z)）：
 *   令 g_i=√(Z_i/z0_i)，A_i=(g_i+1/g_i)/2，B_i=(1/g_i-g_i)/2，
 *   则 a' = A a + B b，b' = B a + A b（A、B 为对角阵）。
 *   b = S a 给出
 *     S' = (B + A S)(A + B S)^{-1}。
 * 该式对逐端口不同实阻抗严格成立，保持无源/互易；
 * 等阻抗时退化为教科书式 (S-R)(I-RS)^{-1}，R=(Z-z0)/(Z+z0)。
 */
export function renormalize(n: Network, newZ0: number[]): Network {
  if (newZ0.length !== 2) throw new Error("需要两个新参考阻抗");
  const av: number[] = [];
  const bv: number[] = [];
  for (let i = 0; i < 2; i++) {
    const g = Math.sqrt(newZ0[i]! / n.z0[i]!);
    av.push((g + 1 / g) / 2);
    bv.push((1 / g - g) / 2);
  }
  const A = m(c(av[0]!), ZERO, ZERO, c(av[1]!));
  const B = m(c(bv[0]!), ZERO, ZERO, c(bv[1]!));
  const sOut = n.sParam.map((s) => {
    const numer = addM(B, mulM(A, s));
    const denom = addM(A, mulM(B, s));
    const info = invertInfo(denom);
    if (info.exactSingular) throw new Error("重归一化矩阵严格奇异");
    return mulM(numer, info.inv);
  });
  return { freq: n.freq.slice(), sParam: sOut, z0: newZ0.slice() };
}

/**
 * 端口交换（1<->2）。必须同时交换入射与反射波定义，
 * 等价于 S' = P S P，P=[[0,1],[1,0]]，即
 * [[S22,S21],[S12,S11]]，频点不变、参考阻抗随端口对调。
 */
export function swapPorts(n: Network): Network {
  return {
    freq: n.freq.slice(),
    z0: [n.z0[1]!, n.z0[0]!],
    sParam: n.sParam.map((s) =>
      m(s.m11, s.m10, s.m01, s.m00),
    ),
  };
}

/** 网络反演（T^-1）：若 N 代表左夹具，其“右侧看入”的去嵌入二端口。 */
export function invertNetwork(n: Network): { network: Network; conds: number[]; singularIdx: number[] } {
  const conds: number[] = [];
  const singularIdx: number[] = [];
  const sOut: M2[] = [];
  n.sParam.forEach((s, i) => {
    const t = sToTInfo(s);
    if (!t.t || t.exactSingular) {
      singularIdx.push(i);
      conds.push(Infinity);
      sOut.push(ident); // 占位但不写零；诊断中标记，调用方不得使用
      return;
    }
    const info = invertInfo(t.t);
    conds.push(info.cond);
    if (info.exactSingular) {
      singularIdx.push(i);
      sOut.push(ident);
      return;
    }
    const back = tToSInfo(info.inv);
    if (!back.s) {
      singularIdx.push(i);
      sOut.push(ident);
      return;
    }
    sOut.push(back.s);
  });
  return {
    network: { freq: n.freq.slice(), sParam: sOut, z0: n.z0.slice() },
    conds,
    singularIdx,
  };
}

/* ---------------- 物理可行性诊断 ---------------- */

export interface PhysicalDiagnostics {
  /** max_i( s^H s 的最大特征值 - 1 )，>tol 表示有源/非无源。 */
  passivityExcess: number;
  /** |S12-S21| 最大值。 */
  reciprocityResidual: number;
  passive: boolean;
  reciprocal: boolean;
}

/** 2x2 厄米矩阵 H=s^H s 最大特征值。 */
function maxEigenSHS(s: M2): number {
  // s = [[a,b],[c,d]]
  const a = s.m00, b = s.m01, cc = s.m10, d = s.m11;
  const h00 = add(mul(conjC(a), a), mul(conjC(cc), cc));
  const h01 = add(mul(conjC(a), b), mul(conjC(cc), d));
  const h11 = add(mul(conjC(b), b), mul(conjC(d), d));
  const tr = h00.re + h11.re;
  const diff = (h00.re - h11.re) / 2;
  const off = Math.hypot(h01.re, h01.im);
  return tr / 2 + Math.sqrt(diff * diff + off * off);
}
function conjC(x: C): C {
  return { re: x.re, im: -x.im };
}

export function physicalDiagnostics(n: Network, passivityTol = 1e-9, reciprocityTol = 1e-9): PhysicalDiagnostics {
  let excess = 0;
  let rec = 0;
  for (const s of n.sParam) {
    const eig = maxEigenSHS(s);
    if (eig - 1 > excess) excess = eig - 1;
    const r = abs(sub(s.m01, s.m10));
    if (r > rec) rec = r;
  }
  return {
    passivityExcess: excess,
    reciprocityResidual: rec,
    passive: excess <= passivityTol,
    reciprocal: rec <= reciprocityTol,
  };
}

/** 两网络逐频 Frobenius 残差 ||A-B||F / max(1,||A||F)。 */
export function residualMatrix(a: M2, b: M2): { abs: number; rel: number } {
  const absErr = frob(subM(a, b));
  const denom = Math.max(1, frob(a));
  return { abs: absErr, rel: absErr / denom };
}

export { frob };
