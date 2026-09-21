export type Complex = {
  re: number;
  im: number;
};

export type Matrix2 = [Complex, Complex, Complex, Complex];

export type TouchstoneFormat = 'ma' | 'db' | 'ri';
export type FrequencyUnit = 'hz' | 'khz' | 'mhz' | 'ghz';

export type NetworkType = 'fixture-left' | 'fixture-right' | 'measurement' | 'dut';

export type WaveDefinition = 'power-wave';

export type PortOrder = '1-2';

export type GridStrategy = 'measurement' | 'union' | 'left' | 'right';

export type PointStatus = 'stable' | 'near-singular' | 'singular';
export type PhysicalStatus = 'feasible' | 'infeasible' | 'not-evaluated';

export type SParameterPoint = {
  frequencyHz: number;
  s: Matrix2;
};

export type TwoPortNetwork = {
  name: string;
  type: NetworkType;
  frequencyUnit: FrequencyUnit;
  format: TouchstoneFormat;
  referenceOhm: [Complex, Complex];
  waveDefinition: WaveDefinition;
  portOrder: PortOrder;
  points: SParameterPoint[];
  sourceText?: string;
  createdAt?: string;
};

export type DensePointResult = {
  frequencyHz: number;
  source: {
    measurementFrequencyHz: number;
    leftFrequencyHz: number;
    rightFrequencyHz: number;
  };
  extrapolated: Array<'measurement' | 'left' | 'right'>;
  conditionNumber: number | null;
  numericalStatus: PointStatus;
  physicalStatus: PhysicalStatus;
  numericalMessages: string[];
  physicalMessages: string[];
  passivityMargin: number | null;
  reciprocityError: number | null;
  residual: number | null;
  residualWithinTolerance: boolean | null;
  estimatedDut: Matrix2 | null;
};

export type RunConfig = {
  measurementNetworkName: string;
  leftNetworkName: string;
  rightNetworkName: string;
  gridStrategy: GridStrategy;
  targetReferenceOhm: [Complex, Complex];
  tolerance: number;
  nearSingularCondition: number;
  waveDefinition: WaveDefinition;
  portOrder: PortOrder;
};

export type RunResult = {
  runId: string;
  createdAt: string;
  config: RunConfig;
  gridFrequencyHz: number[];
  points: DensePointResult[];
  extrapolationCount: number;
  singularCount: number;
  nearSingularCount: number;
  infeasibleCount: number;
  maxResidual: number | null;
  allResidualsWithinTolerance: boolean;
  summary: string;
};

export type RunRecord = RunResult & {
  measurementNetwork: TwoPortNetwork;
  leftNetwork: TwoPortNetwork;
  rightNetwork: TwoPortNetwork;
};

export type ComparisonPoint = {
  frequencyHz: number;
  maxAbsDifference: number;
  rmsDifference: number;
  perParameter: number[];
  baseline: Matrix2 | null;
  comparison: Matrix2 | null;
};

export type ComparisonResult = {
  baselineRunId: string;
  comparisonRunId: string;
  points: ComparisonPoint[];
  sharedFrequencyCount: number;
  maxAbsDifference: number | null;
};
