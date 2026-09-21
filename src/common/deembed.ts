import type {
  ComparisonPoint,
  ComparisonResult,
  DensePointResult,
  Matrix2,
  RunConfig,
  RunResult,
  TwoPortNetwork,
} from './types.js';
import { conditionNumber, mFrobenius, mIsFinite, mMaxAbs, mSub, mMul } from './complex.js';
import {
  cascadeS,
  chooseGrid,
  interpolatePoint,
  inverseT,
  passivityMargin,
  reciprocityError,
  renormalizeS,
  sToT,
  tToS,
} from './network.js';

const DEFAULT_TOLERANCE = 1e-8;
const DEFAULT_NEAR_SINGULAR_CONDITION = 1e6;

export const defaultRunConfig = (
  measurement: TwoPortNetwork,
  left: TwoPortNetwork,
  right: TwoPortNetwork,
): RunConfig => ({
  measurementNetworkName: measurement.name,
  leftNetworkName: left.name,
  rightNetworkName: right.name,
  gridStrategy: 'measurement',
  targetReferenceOhm: [{ re: 50, im: 0 }, { re: 50, im: 0 }],
  tolerance: DEFAULT_TOLERANCE,
  nearSingularCondition: DEFAULT_NEAR_SINGULAR_CONDITION,
  waveDefinition: 'power-wave',
  portOrder: '1-2',
});

const numericalLabel = (condition: number | null, threshold: number, finite: boolean): DensePointResult['numericalStatus'] => {
  if (!finite || condition === null || !Number.isFinite(condition)) return 'singular';
  if (condition >= threshold) return 'near-singular';
  return 'stable';
};

const normalizedPoint = (
  network: TwoPortNetwork,
  frequencyHz: number,
  targetReferenceOhm: RunConfig['targetReferenceOhm'],
): { s: Matrix2; extrapolated: boolean; sourceFrequencyHz: number } => {
  const sampled = interpolatePoint(network, frequencyHz);
  return {
    s: renormalizeS(sampled.point.s, network.referenceOhm, targetReferenceOhm),
    extrapolated: sampled.extrapolated,
    sourceFrequencyHz: sampled.point.frequencyHz,
  };
};

export function deembedRun(
  measurement: TwoPortNetwork,
  left: TwoPortNetwork,
  right: TwoPortNetwork,
  overrides: Partial<RunConfig> = {},
): RunResult {
  const base = defaultRunConfig(measurement, left, right);
  const config: RunConfig = {
    ...base,
    ...overrides,
    measurementNetworkName: measurement.name,
    leftNetworkName: left.name,
    rightNetworkName: right.name,
    waveDefinition: 'power-wave',
    portOrder: '1-2',
    targetReferenceOhm:
      overrides.targetReferenceOhm === undefined
        ? base.targetReferenceOhm
        : [
            { ...overrides.targetReferenceOhm[0] },
            { ...overrides.targetReferenceOhm[1] },
          ],
  };

  validateNetwork(measurement, 'measurement');
  validateNetwork(left, 'left fixture');
  validateNetwork(right, 'right fixture');
  if (config.tolerance <= 0 || !Number.isFinite(config.tolerance)) {
    throw new Error('Cascade tolerance must be a positive finite number');
  }

  const grid = chooseGrid(measurement, left, right, config.gridStrategy);
  const points = grid.map((frequencyHz) =>
    deembedFrequency(measurement, left, right, config, frequencyHz),
  );

  const residuals = points.map((point) => point.residual).filter((value): value is number => value !== null);
  const maxResidual = residuals.length === 0 ? null : Math.max(...residuals);
  const extrapolationCount = points.filter((point) => point.extrapolated.length > 0).length;
  const singularCount = points.filter((point) => point.numericalStatus === 'singular').length;
  const nearSingularCount = points.filter((point) => point.numericalStatus === 'near-singular').length;
  const infeasibleCount = points.filter((point) => point.physicalStatus === 'infeasible').length;
  const allResidualsWithinTolerance =
    points.length > 0 && points.every((point) => point.residualWithinTolerance === true);

  return {
    runId: createRunId(config),
    createdAt: new Date().toISOString(),
    config,
    gridFrequencyHz: grid,
    points,
    extrapolationCount,
    singularCount,
    nearSingularCount,
    infeasibleCount,
    maxResidual,
    allResidualsWithinTolerance,
    summary: `${points.length} points; ${nearSingularCount} near-singular, ${singularCount} singular, ${extrapolationCount} extrapolated, max residual ${maxResidual ?? 'n/a'}`,
  };
}

const validateNetwork = (network: TwoPortNetwork, label: string): void => {
  if (network.points.length === 0) throw new Error(`${label} network ${network.name} is empty`);
  const frequencies = network.points.map((point) => point.frequencyHz);
  if (frequencies.some((frequency, index) => index > 0 && frequency <= (frequencies[index - 1] ?? -Infinity))) {
    throw new Error(`${label} network ${network.name} must use strictly increasing frequencies`);
  }
  const badReference = network.referenceOhm.some((z) => !(z.re > 0) || !Number.isFinite(z.re) || !Number.isFinite(z.im));
  if (badReference) throw new Error(`${label} network ${network.name} must use finite reference impedance with Re(Z)>0`);
};

const deembedFrequency = (
  measurementNetwork: TwoPortNetwork,
  leftNetwork: TwoPortNetwork,
  rightNetwork: TwoPortNetwork,
  config: RunConfig,
  frequencyHz: number,
): DensePointResult => {
  const numericalMessages: string[] = [];
  const physicalMessages: string[] = [];
  const extrapolated: DensePointResult['extrapolated'] = [];

  const measuredSample = normalizedPoint(measurementNetwork, frequencyHz, config.targetReferenceOhm);
  const leftSample = normalizedPoint(leftNetwork, frequencyHz, config.targetReferenceOhm);
  const rightSample = normalizedPoint(rightNetwork, frequencyHz, config.targetReferenceOhm);

  if (measuredSample.extrapolated) extrapolated.push('measurement');
  if (leftSample.extrapolated) extrapolated.push('left');
  if (rightSample.extrapolated) extrapolated.push('right');

  const measuredT = sToT(measuredSample.s);
  const leftT = sToT(leftSample.s);
  const rightT = sToT(rightSample.s);

  const measuredCondition = conditionNumber(measuredT.t);
  const leftCondition = conditionNumber(leftT.t);
  const rightCondition = conditionNumber(rightT.t);
  const conditions = [measuredCondition, leftCondition, rightCondition].filter(Number.isFinite);
  const conditionNumberValue = conditions.length === 0 ? null : Math.max(...conditions);
  const finite = mIsFinite(measuredT.t) && mIsFinite(leftT.t) && mIsFinite(rightT.t);

  if (measuredT.pivot === 0) numericalMessages.push('measured S21 makes conversion to T singular');
  if (leftT.pivot === 0) numericalMessages.push('left fixture S21 makes conversion to T singular');
  if (rightT.pivot === 0) numericalMessages.push('right fixture S21 makes conversion to T singular');
  if (!Number.isFinite(leftCondition)) numericalMessages.push('left fixture T matrix is singular');
  if (!Number.isFinite(rightCondition)) numericalMessages.push('right fixture T matrix is singular');
  if (!Number.isFinite(measuredCondition)) numericalMessages.push('measured T matrix is singular');
  if (Number.isFinite(leftCondition) && leftCondition >= config.nearSingularCondition) {
    numericalMessages.push(`left fixture T condition ${leftCondition.toExponential(3)} exceeds threshold`);
  }
  if (Number.isFinite(rightCondition) && rightCondition >= config.nearSingularCondition) {
    numericalMessages.push(`right fixture T condition ${rightCondition.toExponential(3)} exceeds threshold`);
  }
  if (Number.isFinite(measuredCondition) && measuredCondition >= config.nearSingularCondition) {
    numericalMessages.push(`measured cascade T condition ${measuredCondition.toExponential(3)} exceeds threshold`);
  }

  let estimatedDut: Matrix2 | null = null;
  let residual: number | null = null;
  let residualWithinTolerance: boolean | null = null;

  if (finite) {
    const leftInverse = inverseT(leftT.t);
    const rightInverse = inverseT(rightT.t);
    const dutT = mMul(mMul(leftInverse.inverse, measuredT.t), rightInverse.inverse);
    const converted = tToS(dutT);
    const dutFinite = mIsFinite(dutT) && mIsFinite(converted.s) && converted.pivot > 0;

    if (dutFinite) {
      estimatedDut = converted.s;
      const recombined = cascadeS(cascadeS(leftSample.s, estimatedDut), rightSample.s);
      residual = mMaxAbs(mSub(recombined, measuredSample.s));
      residualWithinTolerance = residual <= config.tolerance;
      if (!residualWithinTolerance) {
        numericalMessages.push(`back-cascade residual ${residual.toExponential(3)} exceeds tolerance ${config.tolerance.toExponential(3)}`);
      }
    } else {
      numericalMessages.push('de-embedded DUT conversion produced non-finite values; point retained as null');
    }
  } else {
    numericalMessages.push('skipped de-embedding at singular point; no zero matrix was inserted');
  }

  const measuredMargin = passivityMargin(measuredSample.s);
  const margin = estimatedDut === null ? measuredMargin : passivityMargin(estimatedDut);
  const reciprocity = estimatedDut === null ? reciprocityError(measuredSample.s) : reciprocityError(estimatedDut);

  let physicalStatus: DensePointResult['physicalStatus'] = 'feasible';
  if (Number.isFinite(margin) && margin < -config.tolerance) {
    physicalMessages.push(`passive margin ${margin.toExponential(3)} is negative`);
    physicalStatus = 'infeasible';
  }
  if (Number.isFinite(reciprocity) && reciprocity > Math.max(1e-10, config.tolerance)) {
    physicalMessages.push(`non-reciprocal S12/S21 error ${reciprocity.toExponential(3)} exceeds reciprocal tolerance`);
  }

  return {
    frequencyHz,
    source: {
      measurementFrequencyHz: measuredSample.sourceFrequencyHz,
      leftFrequencyHz: leftSample.sourceFrequencyHz,
      rightFrequencyHz: rightSample.sourceFrequencyHz,
    },
    extrapolated,
    conditionNumber: conditionNumberValue === null ? null : sanitizeNumber(conditionNumberValue),
    numericalStatus:
      estimatedDut === null
        ? 'singular'
        : numericalLabel(conditionNumberValue, config.nearSingularCondition, finite),
    physicalStatus,
    numericalMessages,
    physicalMessages,
    passivityMargin: Number.isFinite(margin) ? margin : null,
    reciprocityError: Number.isFinite(reciprocity) ? reciprocity : null,
    residual,
    residualWithinTolerance,
    estimatedDut,
  };
};

const sanitizeNumber = (value: number): number => (Number.isFinite(value) ? value : Number.POSITIVE_INFINITY);

const createRunId = (config: RunConfig): string => {
  const body = JSON.stringify(config);
  let hash = 2166136261;
  for (let index = 0; index < body.length; index += 1) {
    hash ^= body.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `run_${(hash >>> 0).toString(16).padStart(8, '0')}`;
};

export const compareRuns = (
  baseline: RunResult,
  comparison: RunResult,
): ComparisonResult => {
  const baselineByFrequency = new Map(baseline.points.map((point) => [point.frequencyHz, point]));
  const comparisonByFrequency = new Map(comparison.points.map((point) => [point.frequencyHz, point]));
  const shared = baseline.gridFrequencyHz.filter((frequency) => comparisonByFrequency.has(frequency));

  const points: ComparisonPoint[] = shared.map((frequencyHz) => {
    const baselinePoint = baselineByFrequency.get(frequencyHz);
    const comparisonPoint = comparisonByFrequency.get(frequencyHz);
    const baselineS = baselinePoint?.estimatedDut ?? null;
    const comparisonS = comparisonPoint?.estimatedDut ?? null;
    if (baselineS === null || comparisonS === null) {
      return {
        frequencyHz,
        maxAbsDifference: Number.POSITIVE_INFINITY,
        rmsDifference: Number.POSITIVE_INFINITY,
        perParameter: [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
        baseline: baselineS,
        comparison: comparisonS,
      };
    }
    const difference = mSub(baselineS, comparisonS);
    const perParameter = difference.map((value) => Math.hypot(value.re, value.im));
    return {
      frequencyHz,
      maxAbsDifference: Math.max(...perParameter),
      rmsDifference: mFrobenius(difference) / 2,
      perParameter,
      baseline: baselineS,
      comparison: comparisonS,
    };
  });

  const finiteDifferences = points.map((point) => point.maxAbsDifference).filter(Number.isFinite);
  return {
    baselineRunId: baseline.runId,
    comparisonRunId: comparison.runId,
    points,
    sharedFrequencyCount: points.length,
    maxAbsDifference: finiteDifferences.length === 0 ? null : Math.max(...finiteDifferences),
  };
};
