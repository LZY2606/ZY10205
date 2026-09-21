import { describe, expect, it } from "vitest";
import { c } from "../src/complex.js";
import { frob, m, mulM, subM, ident } from "../src/cmat.js";
import {
  cascade,
  invertNetwork,
  renormalize,
  sToT,
  sToTInfo,
  swapPorts,
  tToS,
  physicalDiagnostics,
  Network,
} from "../src/rf.js";

const thru = m(c(0), c(1), c(1), c(0));

function relErr(a: ReturnType<typeof m>, b: ReturnType<typeof m>): number {
  return frob(subM(a, b)) / Math.max(1, frob(a));
}

describe("S<->T 转换", () => {
  it("直通 thru 的 T 为单位阵", () => {
    expect(sToT(thru)).toEqual(ident);
  });

  it("随机 S 的 S->T->S 往返到机器精度", () => {
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff - 0.5;
    };
    let worst = 0;
    for (let k = 0; k < 5000; k++) {
      const s = m(
        c(rand() * 0.6, rand() * 0.6),
        c(rand() * 0.4, rand() * 0.4),
        c(0.3 + rand() * 0.5, rand() * 0.4),
        c(rand() * 0.6, rand() * 0.6),
      );
      worst = Math.max(worst, relErr(s, tToS(sToT(s))));
    }
    expect(worst).toBeLessThan(1e-12);
  });

  it("S21=0 报严格奇异，t=null 而非零矩阵", () => {
    const s = m(c(-0.5), c(0.2), c(0), c(0.5));
    const r = sToTInfo(s);
    expect(r.exactSingular).toBe(true);
    expect(r.t).toBeNull();
  });
});

describe("级联与反演", () => {
  const N = (s: ReturnType<typeof m>): Network => ({ freq: [1e9], sParam: [s], z0: [50, 50] });
  const shunt = m(c(-0.2), c(0.8), c(0.8), c(-0.2));

  it("thru 级联 N 等于 N", () => {
    const out = cascade(N(thru), N(shunt));
    expect(relErr(out.sParam[0]!, shunt)).toBeLessThan(1e-14);
  });

  it("N * N^-1 = thru", () => {
    const inv = invertNetwork(N(shunt));
    expect(inv.singularIdx).toEqual([]);
    const back = cascade(N(shunt), inv.network);
    expect(relErr(back.sParam[0]!, thru)).toBeLessThan(1e-12);
  });

  it("级联结合律（T 顺序：左*右）", () => {
    const a = m(c(0.1, 0.2), c(0.9, 0), c(0.9, 0), c(-0.1, 0.1));
    const b = m(c(-0.2, 0.1), c(0.7, 0.1), c(0.7, 0.1), c(0.2, -0.1));
    const ab = cascade(cascade(N(a), N(b)), N(shunt));
    const bc = cascade(N(a), cascade(N(b), N(shunt)));
    expect(relErr(ab.sParam[0]!, bc.sParam[0]!).valueOf()).toBeLessThan(1e-12);
  });
});

describe("端口交换", () => {
  it("同时交换入射与反射定义：PSP = [[S22,S21],[S12,S11]]，z0 对调", () => {
    const s = m(c(0.1, 0.1), c(0.2, 0), c(0.3, 0), c(0.4, -0.1));
    const n: Network = { freq: [1e9, 2e9], sParam: [s, s], z0: [50, 75] };
    const sw = swapPorts(n);
    expect(sw.z0).toEqual([75, 50]);
    expect(sw.sParam[0]).toEqual(m(c(0.4, -0.1), c(0.3, 0), c(0.2, 0), c(0.1, 0.1)));
    // 交换两次恢复
    const back = swapPorts(sw);
    expect(relErr(back.sParam[0]!, s)).toBeLessThan(1e-15);
    expect(back.z0).toEqual([50, 75]);
  });
});

describe("参考阻抗重归一化", () => {
  it("50Ω 直通在任意新阻抗下仍是该阻抗下的匹配直通", () => {
    const matched: Network = { freq: [1e9], sParam: [m(c(0), c(1), c(1), c(0))], z0: [50, 50] };
    const rn = renormalize(matched, [75, 75]);
    // 归一化不变的事实：直通网络 b1=a2, b2=a1 与阻抗无关
    expect(relErr(rn.sParam[0]!, thru)).toBeLessThan(1e-14);
  });

  it("z0 不变时重归一化是恒等", () => {
    const s = m(c(0.2), c(0.8), c(0.8), c(-0.2));
    const n: Network = { freq: [1e9], sParam: [s], z0: [50, 50] };
    const rn = renormalize(n, [50, 50]);
    expect(relErr(rn.sParam[0]!, s)).toBeLessThan(1e-14);
  });

  it("逐端口不同阻抗（50,50)->(60,80)：保持无源、互易，等阻抗退化与教科书一致", () => {
    // 50Ω 并联：S=[-1/3,2/3;2/3,-1/3]
    const s = m(c(-1 / 3), c(2 / 3), c(2 / 3), c(-1 / 3));
    const n: Network = { freq: [1e9], sParam: [s], z0: [50, 50] };
    const rn = renormalize(n, [60, 80]);
    const d = physicalDiagnostics(rn, 0, 1e-12);
    expect(d.passive).toBe(true);
    expect(d.reciprocal).toBe(true);
    // 等阻抗重归一化数值（50->75，r=0.2）
    const rn2 = renormalize(n, [75, 75]);
    expect(rn2.sParam[0]!.m00.re).toBeCloseTo(-3 / 7, 12);
    expect(rn2.sParam[0]!.m10.re).toBeCloseTo(4 / 7, 12);
    expect(rn2.sParam[0]!.m11.re).toBeCloseTo(-3 / 7, 12);
    expect(physicalDiagnostics(rn2).passive).toBe(true);
  });

  it("逐端口不同阻抗：50Ω 匹配负载在 75Ω 端口看到 r=-0.2 反射", () => {
    // 单端口思想：右侧接 50Ω 器件，以 75Ω 量 -> Γ=(50-75)/(50+75)=-0.2
    const s = m(c(0), c(0), c(0), c(0)); // 两端都匹配 50Ω（理想隔离/匹配垫）
    const n: Network = { freq: [1e9], sParam: [s], z0: [50, 50] };
    const rn = renormalize(n, [50, 75]);
    expect(rn.sParam[0]!.m11.re).toBeCloseTo(-0.2, 12);
    expect(Math.abs(rn.sParam[0]!.m11.im)).toBeLessThan(1e-14);
    // 无源性保持
    expect(physicalDiagnostics(rn).passive).toBe(true);
  });
});
