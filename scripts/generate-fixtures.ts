import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Complex, Matrix2, TwoPortNetwork } from '../src/common/types.js';
import { c, div, mul } from '../src/common/complex.js';
import { cascadeS, interpolatePoint, renormalizeS, zToS } from '../src/common/network.js';
import { parseTouchstone, toTouchstone } from '../src/common/touchstone.js';

const currentDir = dirname(fileURLToPath(import.meta.url));
const fixtureDirectory = resolve(currentDir, '../fixtures');
const target50: [Complex, Complex] = [c(50), c(50)];

const linspace = (startMHz: number, stopMHz: number, count: number): number[] =>
  Array.from({ length: count }, (_, index) => startMHz + ((stopMHz - startMHz) * index) / (count - 1));

const transmissionLineS = (
  frequencyMHz: number,
  characteristicOhm: number,
  lengthMeter: number,
  alphaNpPerMeter: number,
  velocityFactor: number,
): Matrix2 => {
  const omega = 2 * Math.PI * frequencyMHz * 1e6;
  const gamma = {
    re: alphaNpPerMeter * lengthMeter,
    im: (omega / (299792458 * velocityFactor)) * lengthMeter,
  };
  const hyperbolic = (z: Complex) => ({
    re: Math.cosh(z.re) * Math.cos(z.im),
    im: Math.sinh(z.re) * Math.sin(z.im),
  });
  const sinh = (z: Complex) => ({
    re: Math.sinh(z.re) * Math.cos(z.im),
    im: Math.cosh(z.re) * Math.sin(z.im),
  });
  const coshGamma = hyperbolic(gamma);
  const sinhGamma = sinh(gamma);
  const zc = c(characteristicOhm);
  const cothGamma = div(coshGamma, sinhGamma);
  const oneOverSinh = div(c(1), sinhGamma);
  const z: Matrix2 = [
    mul(zc, cothGamma),
    mul(zc, oneOverSinh),
    mul(zc, oneOverSinh),
    mul(zc, cothGamma),
  ];
  return zToS(z, [zc, zc]);
};

const notchDutS = (frequencyMHz: number): Matrix2 => {
  const omega = 2 * Math.PI * frequencyMHz * 1e6;
  const inductance = 22e-9;
  const capacitance = 1 / (((2 * Math.PI * 45e6) ** 2) * inductance);
  const seriesImpedance = c(0.05, omega * inductance - 1 / (omega * capacitance));
  const normalizedAdmittance: Complex = {
    re: (50 * seriesImpedance.re) / (seriesImpedance.re ** 2 + seriesImpedance.im ** 2),
    im: (-50 * seriesImpedance.im) / (seriesImpedance.re ** 2 + seriesImpedance.im ** 2),
  };
  const denominatorRe = 2 + normalizedAdmittance.re;
  const denominatorIm = normalizedAdmittance.im;
  const denomMagnitude2 = denominatorRe ** 2 + denominatorIm ** 2;
  const s11: Complex = {
    re: (-normalizedAdmittance.re * denominatorRe - normalizedAdmittance.im * denominatorIm) / denomMagnitude2,
    im: (-normalizedAdmittance.im * denominatorRe + normalizedAdmittance.re * denominatorIm) / denomMagnitude2,
  };
  const s21: Complex = {
    re: (2 * denominatorRe) / denomMagnitude2,
    im: (-2 * denominatorIm) / denomMagnitude2,
  };
  return [s11, s21, s21, s11];
};

const makeNetwork = (
  name: string,
  type: TwoPortNetwork['type'],
  frequenciesMHz: number[],
  makeS: (frequencyMHz: number) => Matrix2,
  referenceOhm: [Complex, Complex] = target50,
): TwoPortNetwork => ({
  name,
  type,
  frequencyUnit: 'mhz',
  format: 'ri',
  referenceOhm,
  waveDefinition: 'power-wave',
  portOrder: '1-2',
  points: frequenciesMHz.map((frequencyMHz) => ({ frequencyHz: frequencyMHz * 1e6, s: makeS(frequencyMHz) })),
});

const leftFrequencies = linspace(8, 116, 15);
const rightFrequencies = linspace(11, 121, 12);
const dutFrequencies = linspace(40, 50, 21);

const left = makeNetwork(
  'left-fixture-75ohm',
  'fixture-left',
  leftFrequencies,
  (frequency) => transmissionLineS(frequency, 75, 0.18, 0.025, 0.78),
  [c(75), c(75)],
);
const right = makeNetwork(
  'right-fixture-50ohm',
  'fixture-right',
  rightFrequencies,
  (frequency) => transmissionLineS(frequency, 50, 0.23, 0.018, 0.82),
);
const dut = makeNetwork('dut-narrow-notch', 'dut', dutFrequencies, notchDutS);

const leftFile = toTouchstone(left);
const rightFile = toTouchstone(right);
const leftFromFile = parseTouchstone(leftFile, left.name, 'fixture-left');
const rightFromFile = parseTouchstone(rightFile, right.name, 'fixture-right');

const measurement = makeNetwork('measurement-cascaded', 'measurement', dutFrequencies, (frequencyMHz) => {
  const frequencyHz = frequencyMHz * 1e6;
  const leftSample = interpolatePoint(leftFromFile, frequencyHz).point;
  const rightSample = interpolatePoint(rightFromFile, frequencyHz).point;
  const left50 = renormalizeS(leftSample.s, [c(75), c(75)], target50);
  const right50 = rightSample.s;
  return cascadeS(cascadeS(left50, notchDutS(frequencyMHz)), right50);
});

await mkdir(fixtureDirectory, { recursive: true });
await writeFile(resolve(fixtureDirectory, 'left-fixture-75ohm.s2p'), toTouchstone(left));
await writeFile(resolve(fixtureDirectory, 'right-fixture-50ohm.s2p'), toTouchstone(right));
await writeFile(resolve(fixtureDirectory, 'dut-narrow-notch.s2p'), toTouchstone(dut));
await writeFile(resolve(fixtureDirectory, 'measurement-cascaded.s2p'), toTouchstone(measurement));
console.log(`Generated fixed Touchstone files in ${fixtureDirectory}`);
