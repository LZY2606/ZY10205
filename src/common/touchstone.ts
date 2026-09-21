import type { Complex, FrequencyUnit, TouchstoneFormat, TwoPortNetwork, NetworkType } from './types.js';

const frequencyMultipliers: Record<FrequencyUnit, number> = {
  hz: 1,
  khz: 1e3,
  mhz: 1e6,
  ghz: 1e9,
};

const parseComplexDirective = (value: string): Complex => {
  const normalized = value.replace(/[()\s]/g, '').replace(/j(?=[-+])/gi, 'j+');
  const match = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(?:([+-](?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)j)?$/i.exec(normalized);
  if (!match) throw new Error(`Invalid complex reference impedance: ${value}`);
  return {
    re: Number(match[1]),
    im: match[2] === undefined ? 0 : Number(match[2]),
  };
};

const polar = (magnitude: number, phaseDegrees: number): Complex => {
  const phase = (phaseDegrees * Math.PI) / 180;
  return { re: magnitude * Math.cos(phase), im: magnitude * Math.sin(phase) };
};

const toRectangular = (a: number, b: number, format: TouchstoneFormat): Complex => {
  if (format === 'ri') return { re: a, im: b };
  if (format === 'db') {
    const magnitude = 10 ** (a / 20);
    return polar(magnitude, b);
  }
  return polar(a, b);
};

const referenceFromDirective = (line: string, fallback: number): [Complex, Complex] | null => {
  const match = /^!\s*portz0\s*:\s*(.+?)(?:\s+(.+?))?\s*$/i.exec(line);
  if (!match) {
    if (/^!\s*reference\s+impedance/i.test(line)) {
      const values = line.split(/\s+/).slice(2).map(parseComplexDirective);
      if (values[0] !== undefined && values[1] !== undefined && values.length === 2) return [values[0], values[1]];
    }
    return null;
  }
  if (match[2] !== undefined && match[1] !== undefined) return [parseComplexDirective(match[1]), parseComplexDirective(match[2])];
  const value = parseComplexDirective(match[1] ?? '');
  return [value, { ...value }];
};

export const parseTouchstone = (
  text: string,
  name: string,
  type: NetworkType = 'measurement',
): TwoPortNetwork => {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let frequencyUnit: FrequencyUnit = 'mhz';
  let format: TouchstoneFormat = 'ma';
  let scalarReference = 50;
  let referenceOhm: [Complex, Complex] | null = null;
  const numericRows: number[][] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('!')) {
      const directed = referenceFromDirective(line, scalarReference);
      if (directed) referenceOhm = directed;
      continue;
    }
    if (line.startsWith('#')) {
      const upper = line.toLowerCase();
      if (/\sghz\s/.test(upper)) frequencyUnit = 'ghz';
      else if (/\smhz\s/.test(upper)) frequencyUnit = 'mhz';
      else if (/\skhz\s/.test(upper)) frequencyUnit = 'khz';
      else if (/\shz\s/.test(upper)) frequencyUnit = 'hz';
      if (/\bs\s+ri\b/.test(upper) || /\bs\s+ri\s*$/.test(upper)) format = 'ri';
      else if (/\bs\s+db\b/.test(upper)) format = 'db';
      else if (/\bs\s+ma\b/.test(upper)) format = 'ma';
      const referenceMatch = /\br\s+([+-]?(?:\d+(?:\.\d*)?|\.\d+))/.exec(upper);
      if (referenceMatch) scalarReference = Number(referenceMatch[1]);
      continue;
    }
    const values = line.split(/[\s,]+/).filter(Boolean).map(Number);
    if (values.length !== 9) {
      throw new Error(`Touchstone two-port row must contain 9 values, received ${values.length}: ${line}`);
    }
    if (values.some((value) => !Number.isFinite(value))) throw new Error(`Touchstone row contains invalid number: ${line}`);
    numericRows.push(values);
  }

  if (numericRows.length === 0) throw new Error(`Touchstone file ${name} contains no data rows`);
  const multiplier = frequencyMultipliers[frequencyUnit];
  const points = numericRows.map((row) => {
    const s: TwoPortNetwork['points'][number]['s'] = [
      toRectangular(row[1]!, row[2]!, format),
      toRectangular(row[5]!, row[6]!, format),
      toRectangular(row[3]!, row[4]!, format),
      toRectangular(row[7]!, row[8]!, format),
    ];
    return { frequencyHz: (row[0] ?? 0) * multiplier, s };
  });

  const z0: [Complex, Complex] = referenceOhm ?? [{ re: scalarReference, im: 0 }, { re: scalarReference, im: 0 }];
  if (z0.some((z) => !(z.re > 0) || !Number.isFinite(z.re) || !Number.isFinite(z.im))) {
    throw new Error(`Touchstone file ${name} requires finite reference impedance with positive real part`);
  }

  return {
    name,
    type,
    frequencyUnit,
    format: 'ri',
    referenceOhm: z0,
    waveDefinition: 'power-wave',
    portOrder: '1-2',
    points,
    sourceText: text,
  };
};

const formatComplex = (value: Complex): string => {
  const imag = value.im >= 0 ? `+${value.im}` : `${value.im}`;
  return `${value.re}${imag}j`;
};

export const toTouchstone = (network: TwoPortNetwork): string => {
  const equalRealReference =
    network.referenceOhm[0].im === 0 &&
    network.referenceOhm[1].im === 0 &&
    network.referenceOhm[0].re === network.referenceOhm[1].re;
  const optionReference = equalRealReference ? network.referenceOhm[0].re : 50;
  const lines = [
    `! Parameter plane de-embed bench export`,
    `! Network: ${network.name}`,
    `! PortZ0: ${formatComplex(network.referenceOhm[0])} ${formatComplex(network.referenceOhm[1])}`,
    `# ${network.frequencyUnit} S RI R ${optionReference}`,
  ];
  for (const point of network.points) {
    const frequency = point.frequencyHz / frequencyMultipliers[network.frequencyUnit];
    lines.push(
      [
        frequency.toPrecision(15),
        ...[point.s[0], point.s[2], point.s[1], point.s[3]].flatMap((value) => [
          value.re.toPrecision(15),
          value.im.toPrecision(15),
        ]),
      ].join(' '),
    );
  }
  return `${lines.join('\n')}\n`;
};
