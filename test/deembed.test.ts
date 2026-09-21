import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { deembedRun } from '../src/common/deembed.js';
import { parseTouchstone } from '../src/common/touchstone.js';
import type { TwoPortNetwork } from '../src/common/types.js';
import { c } from '../src/common/complex.js';

const fixturePath = (name: string) => resolve('fixtures', name);
const load = (name: string, type: TwoPortNetwork['type']) =>
  parseTouchstone(readFileSync(fixturePath(name), 'utf8'), name.replace('.s2p', ''), type);

const fixedNetworks = () => ({
  measurement: load('measurement-cascaded.s2p', 'measurement'),
  left: load('left-fixture-75ohm.s2p', 'fixture-left'),
  right: load('right-fixture-50ohm.s2p', 'fixture-right'),
  dut: load('dut-narrow-notch.s2p', 'dut'),
});

const passiveThrough: TwoPortNetwork['points'][number]['s'] = [c(), c(), c(1), c()];
const singlePointNetwork = (name: string, type: TwoPortNetwork['type'], s: TwoPortNetwork['points'][number]['s']): TwoPortNetwork => ({
  name,
  type,
  frequencyUnit: 'hz',
  format: 'ri',
  referenceOhm: [c(50), c(50)],
  waveDefinition: 'power-wave',
  portOrder: '1-2',
  points: [{ frequencyHz: 100, s }],
});

describe('fixture de-embedding', () => {
  it('recovers the fixed DUT and back-cascades within tolerance', () => {
    const { measurement, left, right, dut } = fixedNetworks();
    const run = deembedRun(measurement, left, right);
    expect(run.allResidualsWithinTolerance).toBe(true);
    expect(run.maxResidual).toBeLessThan(1e-10);
    expect(run.points).toHaveLength(dut.points.length);
    run.points.forEach((point, index) => {
      const expected = dut.points[index]!.s;
      expect(point.estimatedDut).not.toBeNull();
      for (const parameter of [0, 1, 2, 3] as const) {
        expect(point.estimatedDut![parameter].re).toBeCloseTo(expected[parameter].re, 9);
        expect(point.estimatedDut![parameter].im).toBeCloseTo(expected[parameter].im, 9);
      }
    });
  });

  it('reports exactly one finite near-singular narrow-band frequency', () => {
    const { measurement, left, right } = fixedNetworks();
    const run = deembedRun(measurement, left, right);
    const nearSingular = run.points.filter((point) => point.numericalStatus === 'near-singular');
    expect(nearSingular).toHaveLength(1);
    expect(nearSingular[0]!.frequencyHz).toBeCloseTo(45e6, 6);
    expect(Number.isFinite(nearSingular[0]!.conditionNumber)).toBe(true);
    expect(nearSingular[0]!.conditionNumber).toBeGreaterThanOrEqual(1e6);
    expect(nearSingular[0]!.estimatedDut).not.toBeNull();
    expect(nearSingular[0]!.residual).toBeLessThan(1e-10);
  });

  it('records Cartesian interpolation extrapolation on union grid and never index-pairing', () => {
    const { measurement, left, right } = fixedNetworks();
    const run = deembedRun(measurement, left, right, { gridStrategy: 'union' });
    expect(run.gridFrequencyHz).toHaveLength(
      new Set([
        ...measurement.points.map((point) => point.frequencyHz),
        ...left.points.map((point) => point.frequencyHz),
        ...right.points.map((point) => point.frequencyHz),
      ]).size,
    );
    expect(run.points[0]!.extrapolated).toContain('measurement');
    expect(run.points[0]!.extrapolated).toContain('right');
    expect(run.points.at(-1)!.extrapolated).toContain('measurement');
    expect(run.points.at(-1)!.extrapolated).toContain('left');
    expect(run.extrapolationCount).toBeGreaterThan(0);
  });

  it('keeps a hard singular frequency as null instead of a zero matrix fill', () => {
    const blocked: TwoPortNetwork['points'][number]['s'] = [c(), c(), c(), c()];
    const measurement = singlePointNetwork('blocked', 'measurement', blocked);
  const through = singlePointNetwork('left-through', 'fixture-left', passiveThrough);
  const right = singlePointNetwork('right-through', 'fixture-right', passiveThrough);
    const run = deembedRun(measurement, through, right);
    expect(run.points[0]!.numericalStatus).toBe('singular');
    expect(run.points[0]!.estimatedDut).toBeNull();
    expect(run.points[0]!.residual).toBeNull();
    expect(JSON.stringify(run.points[0])).not.toContain('"re":0,"im":0');
  });

  it('separates numerical stability from physical infeasibility for an active network', () => {
    const active: TwoPortNetwork['points'][number]['s'] = [c(0.2), c(0, 0.1), c(0, 1.8), c(0.4)];
    const measurement = singlePointNetwork('active', 'measurement', active);
    const through = singlePointNetwork('left-through', 'fixture-left', passiveThrough);
    const right = singlePointNetwork('right-through', 'fixture-right', passiveThrough);
    const run = deembedRun(measurement, through, right);
    expect(run.points[0]!.numericalStatus).toBe('stable');
    expect(run.points[0]!.physicalStatus).toBe('infeasible');
    expect(run.points[0]!.passivityMargin).toBeLessThan(0);
  });
});
