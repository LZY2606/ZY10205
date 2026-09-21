import { c, C } from "./complex.js";
import { m } from "./cmat.js";
import { Network } from "./rf.js";

/**
 * 解析模型：用真实物理结构生成“无噪声真值”，
 * 既用于内置固定夹具，也用于验收用的窄频段近奇异被测网络。
 * 所有网络在构造上保证无源、互易（S12=S21）、实数参考阻抗。
 *
 * 两端口对称结构闭式（参考阻抗 z0）：
 *   串联阻抗 Z：S = [S11,S21;S21,S11]
 *     S11 = Z/(Z+2z0), S21 = 2z0/(Z+2z0)
 *   并联导纳 Y：S = [S11,S21;S21,-S11]
 *     S11 = -Yz0/(2+Yz0), S21 = 2/(2+Yz0)
 */
export interface SeriesZParams {
  z0: number;
  /** 频率 -> 串联阻抗（复数）。 */
  z: (f: number) => C;
}

function seriesNetwork(freq: number[], p: SeriesZParams, name?: string): Network {
  const sParam = freq.map((f) => {
    const z = p.z(f);
    const den: C = { re: z.re + 2 * p.z0, im: z.im };
    const s11 = cdiv(z, den);
    const s21 = cdiv(c(2 * p.z0), den);
    return m(s11, s21, s21, s11);
  });
  return { freq: freq.slice(), sParam, z0: [p.z0, p.z0], name };
}

function shuntNetwork(freq: number[], z0: number, y: (f: number) => C, name?: string): Network {
  const sParam = freq.map((f) => {
    const yz: C = { re: y(f).re * z0, im: y(f).im * z0 };
    const den: C = { re: 2 + yz.re, im: yz.im };
    // 对称并联网络：S11=S22=-Yz/(2+Yz)，S21=2/(2+Yz)
    const s11 = cdiv(c(-yz.re, -yz.im), den);
    const s21 = cdiv(c(2), den);
    return m(s11, s21, s21, s11);
  });
  return { freq: freq.slice(), sParam, z0: [z0, z0], name };
}

function cdiv(a: C, b: C): C {
  const d = b.re * b.re + b.im * b.im;
  return { re: (a.re * b.re + a.im * b.im) / d, im: (a.im * b.re - a.re * b.im) / d };
}

/** 有耗均匀传输线段（特性阻抗 zLine，时延 tDelay，幅值损耗 alpha0 (Np)）。 */
export interface LineParams {
  z0: number;
  zLine: number;
  tDelay: number;
  alpha0: number;
}

/**
 * 传输线 S（端接 z0，特性阻抗 zLine）。
 * 以反射系数 r=(zLine-z0)/(zLine+z0)、传播因子 P=e^{-(alpha+j w t)} 表示：
 *   S11=S22 = r(1-P^2)/(1-r^2 P^2)
 *   S21=S12 = (1-r^2) P /(1-r^2 P^2)
 */
export function transmissionLine(freq: number[], p: LineParams, name?: string): Network {
  const r = (p.zLine - p.z0) / (p.zLine + p.z0);
  const sParam = freq.map((f) => {
    const w = 2 * Math.PI * f;
    const e = Math.exp(-p.alpha0);
    const pre = e * Math.cos(w * p.tDelay);
    const pim = -e * Math.sin(w * p.tDelay);
    // P^2
    const p2re = pre * pre - pim * pim;
    const p2im = 2 * pre * pim;
    const denRe = 1 - r * r * p2re;
    const denIm = -r * r * p2im;
    const den = denRe * denRe + denIm * denIm;
    // r(1-P2)/den
    const n11re = r * (1 - p2re);
    const n11im = -r * p2im;
    const s11re = (n11re * denRe + n11im * denIm) / den;
    const s11im = (n11im * denRe - n11re * denIm) / den;
    // (1-r^2)P/den
    const k = 1 - r * r;
    const n21re = k * pre;
    const n21im = k * pim;
    const s21re = (n21re * denRe + n21im * denIm) / den;
    const s21im = (n21im * denRe - n21re * denIm) / den;
    return m(c(s11re, s11im), c(s21re, s21im), c(s21re, s21im), c(s11re, s11im));
  });
  return { freq: freq.slice(), sParam, z0: [p.z0, p.z0], name };
}

/**
 * 被测件：串联 RLC 串联在主线中的“窄带陷波”。
 *   Z(f) = R + j(wL - 1/wC)，谐振 f0=1/(2π√LC) 处 Z=R（纯小电阻），
 *   |S21| = 2z0/|2z0+R| ≈ 1（串联小电阻不产生零点）——
 * 因此验收零点改用“并联 RLC 串联支路接地”：见 shuntRLCNotch。
 */
export interface ShuntRLCParams {
  z0: number;
  r: number;
  l: number;
  cap: number;
}

/**
 * 并联到地的串联 RLC 支路：Zs=R+j(wL-1/wC)，Y=1/Zs。
 * 谐振处 Zs=R 很小 => |S21|≈2R/(2R+z0)≈0，S->T 近奇异。
 */
export function shuntRLCNotch(freq: number[], p: ShuntRLCParams, name?: string): Network {
  return shuntNetwork(
    freq,
    p.z0,
    (f) => {
      const w = 2 * Math.PI * f;
      const zre = p.r;
      const zim = w * p.l - 1 / (w * p.cap);
      const d = zre * zre + zim * zim;
      return c(zre / d, -zim / d);
    },
    name,
  );
}

/** 串联 RLC（对照模型，谐振处近全透，不会奇异）。 */
export function seriesRLC(freq: number[], p: ShuntRLCParams, name?: string): Network {
  return seriesNetwork(
    freq,
    {
      z0: p.z0,
      z: (f) => {
        const w = 2 * Math.PI * f;
        return c(p.r, w * p.l - 1 / (w * p.cap));
      },
    },
    name,
  );
}

/** 等距频率网格（含两端）。 */
export function linGrid(fStart: number, fStop: number, step: number): number[] {
  const n = Math.round((fStop - fStart) / step);
  const out: number[] = [];
  for (let i = 0; i <= n; i++) out.push(fStart + i * step);
  return out;
}
