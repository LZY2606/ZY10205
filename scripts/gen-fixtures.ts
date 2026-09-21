/**
 * 生成固定 fixture（随仓库交付，保证可重放）：
 *   data/fixtures/left-fixture-3mhz.s2p
 *   data/fixtures/right-fixture-7mhz.s2p
 *   data/dut/dut-shunt-notch-10mhz.s2p
 *   data/measured/measured-10mhz.s2p  = L * DUT * R
 *
 * 左右夹具频率网格刻意不同（3 MHz / 7 MHz，覆盖区间也不同），
 * 测量面 10 MHz 网格用于验收插值/外推与回级联残差。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { linGrid, transmissionLine, shuntRLCNotch } from "../src/models.js";
import { cascade } from "../src/rf.js";
import { alignToGrid } from "../src/grid.js";
import { parseTouchstone, writeTouchstone } from "../src/touchstone.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const F0 = 1e9;
const L_COIL = 1e-9; // 1 nH
const CAP = 1 / ((2 * Math.PI * F0) ** 2 * L_COIL); // 谐振于 1 GHz
const R_SERIES = 0.02; // 毫欧级：陷波中心 |S21|≈8e-4，S->T 近奇异

const gLeft = linGrid(0.08e9, 4.2e9, 3e6);
const gRight = linGrid(0.05e9, 4.5e9, 7e6);
const gMeas = linGrid(0.1e9, 4e9, 1e7);

const left = transmissionLine(
  gLeft,
  { z0: 50, zLine: 50, tDelay: 0.4e-9, alpha0: 0.02 },
  "left-fixture",
);
const right = transmissionLine(
  gRight,
  { z0: 50, zLine: 52, tDelay: 0.25e-9, alpha0: 0.03 },
  "right-fixture",
);
const dut = shuntRLCNotch(
  gMeas,
  { z0: 50, r: R_SERIES, l: L_COIL, cap: CAP },
  "shunt-rlc-notch",
);

// 把夹具对齐到测量网格后级联（此处的插值仅用于“合成测量数据”；
// 实际去嵌仍由引擎对原始 3/7 MHz 夹具重新对齐）。
const la = alignToGrid(left, gMeas);
const ra = alignToGrid(right, gMeas);
const leftOnMeas = {
  freq: gMeas,
  sParam: la.points.map((p) => p.mat),
  z0: [50, 50],
  name: "left-on-meas-grid",
};
const rightOnMeas = {
  freq: gMeas,
  sParam: ra.points.map((p) => p.mat),
  z0: [50, 50],
  name: "right-on-meas-grid",
};
const measured = cascade(cascade(leftOnMeas, dut), rightOnMeas);
measured.name = "measured";

const files: Array<[string, string]> = [
  ["data/fixtures/left-fixture-3mhz.s2p", writeTouchstone(left)],
  ["data/fixtures/right-fixture-7mhz.s2p", writeTouchstone(right)],
  ["data/dut/dut-shunt-notch-10mhz.s2p", writeTouchstone(dut)],
  ["data/measured/measured-10mhz.s2p", writeTouchstone(measured)],
];
for (const [rel, body] of files) {
  const path = resolve(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  const back = parseTouchstone(body).network;
  if (back.freq.length !== (rel.includes("3mhz") ? gLeft.length : rel.includes("7mhz") ? gRight.length : gMeas.length)) {
    throw new Error(`round-trip length mismatch for ${rel}`);
  }
  console.log(`wrote ${rel} (${back.freq.length} pts)`);
}

console.log("notch params: f0=1GHz, R=0.02ohm, L=1nH, C=", CAP.toExponential(6), "F");
