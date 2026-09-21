import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db.js";
import { BenchService } from "./service.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const dbPath = process.env.DEEMBED_DB ?? resolve(root, "data", "deembed.db");
const dataDir = resolve(root, "data");

const db = openDb(dbPath);
const service = new BenchService(db, dataDir);
service.seedBuiltins();

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = Buffer.concat(chunks).toString("utf8");
  if (!body) return {};
  return JSON.parse(body);
}

function sendJson(res: ServerResponse, code: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(code, { "content-type": MIME[".json"]!, "cache-control": "no-store" });
  res.end(body);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const path = url.pathname;
  try {
    if (path === "/api/health" && req.method === "GET") {
      return sendJson(res, 200, { ok: true, app: "参数面去嵌台", dbPath });
    }
    if (path === "/api/fixtures" && req.method === "GET") {
      return sendJson(res, 200, service.listFixtures());
    }
    if (path.startsWith("/api/fixtures/") && req.method === "GET") {
      const name = decodeURIComponent(path.slice("/api/fixtures/".length));
      const detail = service.fixtureDetail(name);
      if (!detail) return sendJson(res, 404, { error: "fixture not found" });
      return sendJson(res, 200, detail);
    }
    if (path === "/api/fixtures" && req.method === "POST") {
      const body = (await readJson(req)) as { name: string; role: string; touchstone: string };
      if (!body?.name || !body?.touchstone) return sendJson(res, 400, { error: "name 与 touchstone 必填" });
      const out = service.importTouchstone(body.name, (body.role as never) ?? "unknown", body.touchstone);
      return sendJson(res, 201, out);
    }
    if (path === "/api/runs" && req.method === "POST") {
      const body = (await readJson(req)) as never;
      const out = service.run(body);
      return sendJson(res, 201, out);
    }
    if (path === "/api/runs" && req.method === "GET") {
      return sendJson(res, 200, service.listRuns());
    }
    const runMatch = path.match(/^\/api\/runs\/(\d+)$/);
    if (runMatch && req.method === "GET") {
      const detail = service.runDetail(Number(runMatch[1]));
      if (!detail) return sendJson(res, 404, { error: "run not found" });
      return sendJson(res, 200, detail);
    }
    const cmpMatch = path.match(/^\/api\/compare\/(\d+)\/(\d+)$/);
    if (cmpMatch && req.method === "GET") {
      return sendJson(res, 200, service.compare(Number(cmpMatch[1]), Number(cmpMatch[2])));
    }
    if (path === "/api/export" && req.method === "GET") {
      res.writeHead(200, {
        "content-type": MIME[".json"]!,
        "content-disposition": 'attachment; filename="deembed-runs-export.json"',
      });
      return res.end(JSON.stringify(service.export()));
    }
    if (path === "/api/reimport" && req.method === "POST") {
      const body = (await readJson(req)) as { bundle?: unknown; wipe?: boolean };
      const result = service.clearAndReimport(body.bundle ?? (await readJson(req)), { wipe: body.wipe !== false });
      return sendJson(res, 200, result);
    }

    // 静态页面
    let rel = path === "/" ? "/index.html" : path;
    const file = resolve(root, "web", rel.replace(/^\/+/, ""));
    if (!file.startsWith(resolve(root, "web"))) return sendJson(res, 403, { error: "forbidden" });
    const body = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    return res.end(body);
  } catch (err) {
    return sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
  }
});

function parseArgs(argv: string[]): { host: string; port: number } {
  let host = process.env.HOST ?? "127.0.0.1";
  let port = Number(process.env.PORT ?? 5545);
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const eqVal = (key: string): string | undefined => {
      if (a === key) return argv[++i];
      if (a?.startsWith(key + "=")) return a.slice(key.length + 1);
      return undefined;
    };
    const h = eqVal("--host");
    if (h !== undefined) host = h;
    const p2 = eqVal("--port");
    if (p2 !== undefined) port = Number(p2);
  }
  return { host, port };
}
const { host, port } = parseArgs(process.argv);
server.listen(port, host, () => {
  console.log(`参数面去嵌台 已启动: http://${host}:${port}`);
  console.log(`SQLite: ${dbPath}`);
});
