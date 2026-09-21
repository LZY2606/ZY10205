import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NetworkType, RunRecord, TwoPortNetwork } from '../common/types.js';
import { deembedRun } from '../common/deembed.js';
import { parseTouchstone } from '../common/touchstone.js';
import type { AppDatabase } from './database.js';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const fixtureDirectory = resolve(currentDirectory, '../../fixtures');

const fixtureFiles: Array<{ file: string; name: string; type: NetworkType }> = [
  { file: 'left-fixture-75ohm.s2p', name: 'left-fixture-75ohm', type: 'fixture-left' },
  { file: 'right-fixture-50ohm.s2p', type: 'fixture-right', name: 'right-fixture-50ohm' },
  { file: 'measurement-cascaded.s2p', name: 'measurement-cascaded', type: 'measurement' },
  { file: 'dut-narrow-notch.s2p', name: 'dut-narrow-notch-reference', type: 'dut' },
];

export const loadFixedFixtures = async (): Promise<TwoPortNetwork[]> =>
  Promise.all(
    fixtureFiles.map(async ({ file, name, type }) => {
      const text = await readFile(resolve(fixtureDirectory, file), 'utf8');
      return parseTouchstone(text, name, type);
    }),
  );

export const seedDatabase = async (database: AppDatabase): Promise<{ runs: RunRecord[]; networks: TwoPortNetwork[] }> => {
  const networks = await loadFixedFixtures();
  for (const network of networks) database.upsertNetwork(network);

  const byName = new Map(networks.map((network) => [network.name, network]));
  const measurement = byName.get('measurement-cascaded');
  const left = byName.get('left-fixture-75ohm');
  const right = byName.get('right-fixture-50ohm');
  if (!measurement || !left || !right) throw new Error('Required fixed fixtures are missing');

  const standard = deembedRun(measurement, left, right, {
    gridStrategy: 'measurement',
    targetReferenceOhm: [{ re: 50, im: 0 }, { re: 50, im: 0 }],
  });
  const highImpedance = deembedRun(measurement, left, right, {
    gridStrategy: 'measurement',
    targetReferenceOhm: [{ re: 75, im: 0 }, { re: 75, im: 0 }],
  });

  const records: RunRecord[] = [
    { ...standard, measurementNetwork: measurement, leftNetwork: left, rightNetwork: right },
    { ...highImpedance, measurementNetwork: measurement, leftNetwork: left, rightNetwork: right },
  ];
  for (const record of records) database.saveRun(record);
  database.log('seed-database', `imported ${networks.length} fixed networks and ${records.length} replay runs`);
  return { networks, runs: records };
};
