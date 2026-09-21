import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import type { GridStrategy, NetworkType, RunConfig, RunRecord, TwoPortNetwork } from '../common/types.js';
import { compareRuns, deembedRun } from '../common/deembed.js';
import { swapNetworkPorts } from '../common/network.js';
import { parseTouchstone, toTouchstone } from '../common/touchstone.js';
import type { AppDatabase } from './database.js';
import { seedDatabase } from './seed.js';

const json = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
};

const readJson = async (request: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const body = Buffer.concat(chunks).toString('utf8');
  if (!body) return {};
  return JSON.parse(body) as Record<string, unknown>;
};

const asString = (value: unknown, fallback: string): string => (typeof value === 'string' && value.trim() ? value : fallback);
const asNumber = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
const asComplex = (value: unknown, fallback: { re: number; im: number }): { re: number; im: number } => {
  if (!value || typeof value !== 'object' || !('re' in value)) return fallback;
  const candidate = value as { re?: unknown; im?: unknown };
  return {
    re: typeof candidate.re === 'number' && Number.isFinite(candidate.re) ? candidate.re : fallback.re,
    im: typeof candidate.im === 'number' && Number.isFinite(candidate.im) ? candidate.im : fallback.im,
  };
};

const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

export type AppServerOptions = {
  database: AppDatabase;
  publicDirectory: string;
};

export const createAppServer = ({ database, publicDirectory }: AppServerOptions): Server =>
  createServer(async (request, response) => {
    try {
      await routeRequest(request, response, database, publicDirectory);
    } catch (error) {
      json(response, 500, {
        error: error instanceof Error ? error.message : 'Unknown server error',
      });
    }
  });

const routeRequest = async (
  request: IncomingMessage,
  response: ServerResponse,
  database: AppDatabase,
  publicDirectory: string,
): Promise<void> => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const method = request.method ?? 'GET';

  if (method === 'GET' && url.pathname === '/api/health') {
    json(response, 200, { ok: true, service: '参数面去嵌台', networkCount: database.countNetworks() });
    return;
  }

  if (method === 'GET' && url.pathname === '/api/networks') {
    json(response, 200, { networks: database.listNetworks().map(stripSource) });
    return;
  }

  if (method === 'GET' && url.pathname === '/api/runs') {
    json(response, 200, { runs: database.listRuns().map(({ measurementNetwork: _measurement, leftNetwork: _left, rightNetwork: _right, ...run }) => run) });
    return;
  }

  if (method === 'GET' && url.pathname.startsWith('/api/runs/')) {
    const runId = decodeURIComponent(url.pathname.split('/').pop() ?? '');
    const record = database.getRun(runId);
    if (!record) {
      json(response, 404, { error: `Run ${runId} was not found` });
      return;
    }
    json(response, 200, stripNetworks(record));
    return;
  }

  if (method === 'POST' && url.pathname === '/api/networks/import') {
    const body = await readJson(request);
    const name = asString(body.name, 'imported-network');
    const type = asString(body.type, 'measurement') as NetworkType;
    const text = asString(body.touchstone, '');
    const network = parseTouchstone(text, name, type);
    database.upsertNetwork(network);
    database.log('import-touchstone', `${type}:${name}`);
    json(response, 201, { network: stripSource(network) });
    return;
  }

  if (method === 'POST' && url.pathname === '/api/networks/swap-ports') {
    const body = await readJson(request);
    const name = asString(body.name, '');
    const source = database.getNetwork(name);
    if (!source) {
      json(response, 404, { error: `Network ${name} was not found` });
      return;
    }
    const swapped = swapNetworkPorts(source);
    database.upsertNetwork(swapped);
    database.log('swap-ports', `${source.name} -> ${swapped.name}; incident and reflected waves swapped with ports`);
    json(response, 201, { network: stripSource(swapped) });
    return;
  }

  if (method === 'POST' && url.pathname === '/api/ports-swap') {
    const body = await readJson(request);
    const name = asString(body.name, '');
    const source = database.getNetwork(name);
    if (!source) {
      json(response, 404, { error: `Network ${name} was not found` });
      return;
    }
    const swapped = swapNetworkPorts(source);
    database.upsertNetwork(swapped);
    json(response, 201, { network: stripSource(swapped) });
    return;
  }

  if (method === 'POST' && url.pathname === '/api/runs') {
    const record = createRun(database, await readJson(request));
    database.saveRun(record);
    json(response, 201, stripNetworks(record));
    return;
  }

  if (method === 'GET' && url.pathname === '/api/compare') {
    const baselineId = url.searchParams.get('baseline') ?? '';
    const comparisonId = url.searchParams.get('comparison') ?? '';
    const baseline = database.getRun(baselineId);
    const comparison = database.getRun(comparisonId);
    if (!baseline || !comparison) {
      json(response, 404, { error: 'Both run IDs must refer to stored runs' });
      return;
    }
    json(response, 200, compareRuns(baseline, comparison));
    return;
  }

  if (method === 'GET' && url.pathname === '/api/export') {
    json(response, 200, database.exportAll());
    return;
  }

  if (method === 'POST' && url.pathname === '/api/reset-and-replay') {
    database.clearAll();
    const seeded = await seedDatabase(database);
    json(response, 200, {
      networkCount: seeded.networks.length,
      runCount: seeded.runs.length,
      message: 'database cleared and fixed fixtures re-imported',
    });
    return;
  }

  if (method === 'GET' && url.pathname.startsWith('/api/export/touchstone/')) {
    const name = decodeURIComponent(url.pathname.split('/').pop() ?? '');
    const network = database.getNetwork(name);
    if (!network) {
      json(response, 404, { error: `Network ${name} was not found` });
      return;
    }
    response.writeHead(200, {
      'content-type': 'text/plain; charset=utf-8',
      'content-disposition': `attachment; filename="${name}.s2p"`,
    });
    response.end(toTouchstone({ ...network, format: 'ri' }));
    return;
  }

  serveStatic(request, response, publicDirectory);
};

const createRun = (database: AppDatabase, body: Record<string, unknown>): RunRecord => {
  const measurementName = asString(body.measurementNetworkName, 'measurement-cascaded');
  const leftName = asString(body.leftNetworkName, 'left-fixture-75ohm');
  const rightName = asString(body.rightNetworkName, 'right-fixture-50ohm');
  const measurement = database.getNetwork(measurementName);
  const left = database.getNetwork(leftName);
  const right = database.getNetwork(rightName);
  if (!measurement || !left || !right) {
    throw new Error('Measurement, left fixture, and right fixture networks must all be stored');
  }

  const targetBody = body.targetReferenceOhm;
  const targetReference: RunConfig['targetReferenceOhm'] = Array.isArray(targetBody)
    ? [asComplex(targetBody[0], { re: 50, im: 0 }), asComplex(targetBody[1], { re: 50, im: 0 })]
    : [{ re: 50, im: 0 }, { re: 50, im: 0 }];
  const gridStrategy = asString(body.gridStrategy, 'measurement') as GridStrategy;
  const result = deembedRun(measurement, left, right, {
    gridStrategy,
    targetReferenceOhm: targetReference,
    tolerance: asNumber(body.tolerance, 1e-8),
    nearSingularCondition: asNumber(body.nearSingularCondition, 1e6),
  });
  return { ...result, measurementNetwork: measurement, leftNetwork: left, rightNetwork: right };
};

const stripSource = (network: TwoPortNetwork): TwoPortNetwork => {
  const { sourceText: _sourceText, ...withoutSource } = network;
  return withoutSource;
};
const stripNetworks = (record: RunRecord): RunRecord => ({
  ...record,
  measurementNetwork: stripSource(record.measurementNetwork),
  leftNetwork: stripSource(record.leftNetwork),
  rightNetwork: stripSource(record.rightNetwork),
});

const serveStatic = (request: IncomingMessage, response: ServerResponse, publicDirectory: string): void => {
  const requestPath = normalize(decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname));
  const relativePath = requestPath === '/' ? '/index.html' : requestPath;
  const filePath = resolve(join(publicDirectory, relativePath));
  if (!filePath.startsWith(resolve(publicDirectory)) || !existsSync(filePath) || !statSync(filePath).isFile()) {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }
  response.writeHead(200, { 'content-type': contentTypes[extname(filePath)] ?? 'application/octet-stream' });
  createReadStream(filePath).pipe(response);
};
