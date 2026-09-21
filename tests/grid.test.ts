import { describe, expect, it } from "vitest";
import { alignToGrid, buildTargetGrid } from "../src/grid.js";
import { c } from "../src/complex.js";
import { m } from "../src/cmat.js";
import { Network } from "../src/rf.js";

function net(freq: number[], vals: Array<[number, number]>): Network {
  return {
    freq,
    z0: [50, 50],
    sParam: vals.map(([a, b]) =>
      m(c(a, b), c(0, 0), c(1, 0), c(0, 0)),
    ),
  };
}

describe("复直角分量插值", () => {
  const n = net([0, 100], [[0, 0], [10, -4]]);

  it("在中点严格按 re/im 线性（不按数组下标对极坐标相乘）", () => {
    const al = alignToGrid(n, [50]);
    expect(al.points[0]!.mat.m00.re).toBeCloseTo(5, 12);
    expect(al.points[0]!.mat.m00.im).toBeCloseTo(-2, 12);
    expect(al.points[0]!.extrapolated).toBe(false);
  });

  it("记录端部外推而不是静默钳制", () => {
    const al = alignToGrid(n, [-50, 0, 150]);
    expect(al.points[0]!.extrapolated).toBe(true);
    expect(al.points[0]!.mat.m00.re).toBeCloseTo(-5, 12);
    expect(al.points[1]!.extrapolated).toBe(false);
    expect(al.points[2]!.extrapolated).toBe(true);
    expect(al.points[2]!.mat.m00.im).toBeCloseTo(-6, 12);
    expect(al.points[0]!.extrapolationSpan).toBe(50);
  });

  it("非均匀目标网格按频率值（非下标）定位", () => {
    const n2 = net([0, 100, 300], [[0, 0], [1, 0], [3, 0]]);
    const al = alignToGrid(n2, [200]);
    // 200 位于 100..300 中点
    expect(al.points[0]!.loIdx).toBe(1);
    expect(al.points[0]!.hiIdx).toBe(2);
    expect(al.points[0]!.mat.m00.re).toBeCloseTo(2, 12);
  });

  it("union 策略合并并排序所有网格", () => {
    const g = buildTargetGrid([10, 20], [0, 15], [20, 30], "union");
    expect(g).toEqual([0, 10, 15, 20, 30]);
  });
});
