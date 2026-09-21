import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { AppDatabase } from '../src/server/database.js';
import { createAppServer } from '../src/server/app.js';
import { seedDatabase } from '../src/server/seed.js';
import type { Server } from 'node:http';
import { resolve } from 'node:path';

let server: Server;
let database: AppDatabase;
let baseUrl: string;
let databasePath: string;

beforeAll(async () => {
  const directory = await mkdtemp(join(tmpdir(), 'deembed-'));
  databasePath = join(directory, 'test.sqlite');
  database = new AppDatabase(databasePath);
  await seedDatabase(database);
  server = createAppServer({ database, publicDirectory: resolve('public') });
  await new Promise<void>((listenResolve) => server.listen(0, '127.0.0.1', listenResolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((closeResolve) => server.close(() => closeResolve()));
  database.close();
  await rm(databasePath, { force: true });
});

const requestJson = async <T = Record<string, unknown>>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(`${baseUrl}${path}`, init);
  const data = await response.json();
  expect(response.ok, JSON.stringify(data)).toBe(true);
  return data as T;
};

type RunSummary = { runId: string };

describe('SQLite-backed local service', () => {
  it('seeds fixed networks and persisted runs', async () => {
    const health = await requestJson<{ service: string }>('/api/health');
    expect(health.service).toBe('参数面去嵌台');
    const networks = await requestJson<{ networks: unknown[] }>('/api/networks');
    expect(networks.networks.length).toBeGreaterThanOrEqual(4);
    const runs = await requestJson<{ runs: RunSummary[] }>('/api/runs');
    expect(runs.runs.length).toBe(2);
  });

  it('creates a deterministic run and compares two stored plans by frequency', async () => {
    const created = await requestJson<{ allResidualsWithinTolerance: boolean }>('/api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        measurementNetworkName: 'measurement-cascaded',
        leftNetworkName: 'left-fixture-75ohm',
        rightNetworkName: 'right-fixture-50ohm',
        gridStrategy: 'measurement',
        targetReferenceOhm: [{ re: 50, im: 0 }, { re: 50, im: 0 }],
      }),
    });
    expect(created.allResidualsWithinTolerance).toBe(true);
    const runs = await requestJson<{ runs: RunSummary[] }>('/api/runs');
    const [firstRun, secondRun] = runs.runs;
    expect(firstRun).toBeDefined();
    expect(secondRun).toBeDefined();
    const comparison = await requestJson<{ sharedFrequencyCount: number; maxAbsDifference: number }>(
      `/api/compare?baseline=${firstRun!.runId}&comparison=${secondRun!.runId}`,
    );
    expect(comparison.sharedFrequencyCount).toBe(21);
    expect(comparison.maxAbsDifference).toBeGreaterThan(0);
  });

  it('clears and re-imports the fixed replay set', async () => {
    const reset = await requestJson<{ networkCount: number; runCount: number }>('/api/reset-and-replay', { method: 'POST' });
    expect(reset.networkCount).toBe(4);
    expect(reset.runCount).toBe(2);
    const exported = await requestJson<{ networks: unknown[]; runs: unknown[]; logs: Array<{ action: string }> }>('/api/export');
    expect(exported.networks).toHaveLength(4);
    expect(exported.runs).toHaveLength(2);
    expect(exported.logs.some((log: { action: string }) => log.action === 'clear-database')).toBe(true);
  });
});
