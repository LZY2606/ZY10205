import { describe, expect, it } from 'vitest';
import { c, mMul, mSolve2 } from '../src/common/complex.js';
import {
  cascadeS,
  interpolatePoint,
  renormalizeS,
  sToT,
  swapPorts,
  tToS,
} from '../src/common/network.js';
import type { Matrix2, TwoPortNetwork } from '../src/common/types.js';

const identityS: TwoPortNetwork['points'][number]['s'] = [c(), c(), c(1), c()];
const makeNetwork = (frequencies: number[], s: TwoPortNetwork['points'][number]['s']): TwoPortNetwork => ({
  name: 'test-network',
  type: 'measurement',
  frequencyUnit: 'hz',
  format: 'ri',
  referenceOhm: [c(50), c(50)],
  waveDefinition: 'power-wave',
  portOrder: '1-2',
  points: frequencies.map((frequencyHz) => ({ frequencyHz, s })),
});

describe('complex matrix operations', () => {
  it('solves a complex two-port matrix equation with column pivot', () => {
    const matrix: Matrix2 = [c(0, 1), c(2), c(1), c(0, 1)];
    const right: Matrix2 = [c(1), c(0), c(0), c(1)];
    const solved = mSolve2([...matrix], [...right]).x;
    const reconstructed = mMul([...matrix], solved);
    for (const index of [0, 1, 2, 3] as const) {
      expect(reconstructed[index].re).toBeCloseTo(right[index].re, 12);
      expect(reconstructed[index].im).toBeCloseTo(right[index].im, 12);
    }
  });

  it('round-trips S through transfer T and reconstructs identity cascade', () => {
    const s: TwoPortNetwork['points'][number]['s'] = [c(0.1), c(0, 0.9), c(0, 0.9), c(0.2)];
    const roundTrip = tToS(sToT(s).t).s;
    for (const index of [0, 1, 2, 3] as const) {
      expect(roundTrip[index].re).toBeCloseTo(s[index].re, 12);
      expect(roundTrip[index].im).toBeCloseTo(s[index].im, 12);
    }
    expect(cascadeS(identityS, s)[3].re).toBeCloseTo(0.2, 12);
    expect(cascadeS(s, identityS)[0].re).toBeCloseTo(0.1, 12);
  });

  it('renormalizes a matched 75 ohm two-port to zero at 50 ohm', () => {
    const s75: TwoPortNetwork['points'][number]['s'] = [c(-0.2), c(), c(), c(-0.2)];
    const s50 = renormalizeS(s75, [c(75), c(75)], [c(50), c(50)]);
    expect(s50[0].re).toBeCloseTo(0, 12);
    expect(s50[3].re).toBeCloseTo(0, 12);
  });

  it('swaps incident and reflected definitions with both ports', () => {
    const s: TwoPortNetwork['points'][number]['s'] = [c(0.1), c(0.2), c(0.3), c(0.4)];
    expect(swapPorts(s)).toEqual([s[3], s[2], s[1], s[0]]);
  });
});

describe('complex Cartesian interpolation', () => {
  it('interpolates real and imaginary components independently and records extrapolation', () => {
    const s0: TwoPortNetwork['points'][number]['s'] = [c(1, 2), c(), c(), c()];
    const s1: TwoPortNetwork['points'][number]['s'] = [c(3, 6), c(), c(), c()];
    const network = makeNetwork([100, 200], s0);
    network.points[1] = { frequencyHz: 200, s: s1 };
    const interior = interpolatePoint(network, 150);
    expect(interior.extrapolated).toBe(false);
    expect(interior.point.s[0]).toEqual({ re: 2, im: 4 });
    const outside = interpolatePoint(network, 250);
    expect(outside.extrapolated).toBe(true);
    expect(outside.point.s[0]).toEqual({ re: 4, im: 8 });
  });
});
