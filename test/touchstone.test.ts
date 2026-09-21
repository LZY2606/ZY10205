import { describe, expect, it } from 'vitest';
import { parseTouchstone, toTouchstone } from '../src/common/touchstone.js';

const touchstone = `# MHz S RI R 50
40 0.1 0.2 0.3 0.4 0.5 0.6 0.7 0.8
`;

describe('Touchstone boundary', () => {
  it('maps the S11 S21 S12 S22 column order to internal S11 S12 S21 S22', () => {
    const network = parseTouchstone(touchstone, 's2p');
    expect(network.points[0]?.s).toEqual([
      { re: 0.1, im: 0.2 },
      { re: 0.5, im: 0.6 },
      { re: 0.3, im: 0.4 },
      { re: 0.7, im: 0.8 },
    ]);
  });

  it('round-trips rectangular complex data without index drift', () => {
    const network = parseTouchstone(touchstone, 's2p');
    const reparsed = parseTouchstone(toTouchstone(network), 's2p');
    expect(reparsed.points[0]?.s).toEqual(network.points[0]?.s);
  });

  it('parses magnitude-angle and decibel-angle rows', () => {
    const ma = parseTouchstone('# GHz S MA R 75\n1 1 90 0 0 0 0 0 0\n', 'ma');
    expect(ma.referenceOhm[0]?.re).toBe(75);
    expect(ma.points[0]?.s[0].re).toBeCloseTo(0, 12);
    expect(ma.points[0]?.s[0].im).toBeCloseTo(1, 12);
  });
});
