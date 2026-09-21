"use strict";

const $ = (id) => document.getElementById(id);
const api = async (path, opts = {}) => {
  const res = await fetch(path, {
    headers: opts.body ? { "content-type": "application/json" } : undefined,
    ...opts,
  });
  const text = await res.text();
  const value = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(value?.error ?? res.statusText);
  return value;
};

const state = {
  fixtures: [],
  runs: [],
  detail: null,
  compare: null,
};

const STATUS_LABEL = {
  ok: ["正常", "ok"],
  interpolated: ["插值", "neutral"],
  extrapolated: ["外推", "warn"],
  near_singular: ["近奇异", "warn"],
  unstable: ["不稳定", "fail"],
  exact_singular: ["严格奇异", "fail"],
};

async function init() {
  try {
    const health = await api("/api/health");
    $("health").textContent = `${health.app} · 已连接 · ${health.dbPath.split("/").pop()}`;
    $("health").classList.add("ok");
  } catch {
    $("health").textContent = "服务未连接";
    return;
  }
  await refreshFixtures();
  await refreshRuns();
  bind();
}

function bind() {
  $("runBtn").onclick = doRun;
  $("swapBtn").onclick = () => {
    const l = $("leftSel").value;
    $("leftSel").value = $("rightSel").value;
    $("rightSel").value = l;
  };
  $("impBtn").onclick = doImport;
  $("impFile").onchange = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    $("impName").value = f.name;
    $("impText").value = await f.text();
  };
  $("exportBtn").onclick = doExport;
  $("reimpFile").onchange = () => {};
  $("reimpBtn").onclick = doReimport;
  $("cmpBtn").onclick = doCompare;
  for (const id of ["viewSel", "viewObj", "viewKey"]) {
    $(id).onchange = () => renderPlots();
  }
}

async function refreshFixtures() {
  state.fixtures = await api("/api/fixtures");
  const sels = ["measuredSel", "leftSel", "rightSel"];
  const prefer = { measuredSel: "measured", leftSel: "left", rightSel: "right" };
  for (const id of sels) {
    const sel = $(id);
    const prev = sel.value;
    sel.innerHTML = "";
    for (const f of state.fixtures) {
      const o = document.createElement("option");
      o.value = f.name;
      o.textContent = `${f.name} · ${f.role} · ${f.points}pt · ${(f.fStartHz / 1e9).toFixed(2)}-${(f.fStopHz / 1e9).toFixed(2)}GHz · ${f.source}`;
      sel.appendChild(o);
    }
    const want =
      state.fixtures.find((f) => f.name === prev) ??
      state.fixtures.find((f) => f.role.startsWith(prefer[id]));
    if (want) sel.value = want.name;
  }
  $("fixtureChips").innerHTML = state.fixtures
    .map(
      (f) =>
        `<span class="chip"><b>${f.name}</b> · ${f.role} · ${f.points} 点 · z0=${f.z0}Ω · ${f.source}</span>`,
    )
    .join("");
}

async function refreshRuns(selectId) {
  state.runs = await api("/api/runs");
  const pills = $("runList");
  pills.innerHTML = "";
  for (const r of state.runs) {
    const d = document.createElement("div");
    d.className = "run-pill";
    d.dataset.id = r.id;
    const bad = r.counts.near_singular + r.counts.unstable + r.counts.exact_singular;
    d.innerHTML = `
      <div class="t">#${r.id} ${r.name}</div>
      <div class="meta">${r.strategy} · ${r.nPoints} 点 · 回验 ${r.maxRoundtripRel.toExponential(2)}
      ${r.roundtripPass ? "✓" : "✗"}</div>
      <div class="meta">奇异/不稳 ${bad} · 无源 ${r.physical.passive ? "是" : "否"}</div>`;
    d.onclick = () => loadRun(r.id);
    pills.appendChild(d);
  }
  for (const id of ["cmpA", "cmpB", "viewSel"]) {
    const sel = $(id);
    const prev = sel.value;
    sel.innerHTML = state.runs
      .map((r) => `<option value="${r.id}">#${r.id} ${r.name}</option>`)
      .join("");
    if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
    else if (id === "cmpB" && state.runs.length > 1) sel.value = String(state.runs[1].id);
    else if (state.runs.length) sel.value = String(state.runs[0].id);
  }
  if (selectId) {
    $("viewSel").value = String(selectId);
    [...pills.children].forEach((c) => c.classList.toggle("active", Number(c.dataset.id) === selectId));
  }
  if (state.runs.length) {
    const active = Number($("viewSel").value) || state.runs[0].id;
    await loadRun(active, false);
  }
}

async function loadRun(id, switchSel = true) {
  state.detail = await api(`/api/runs/${id}`);
  document.querySelectorAll(".run-pill").forEach((c) =>
    c.classList.toggle("active", Number(c.dataset.id) === id),
  );
  if (switchSel) $("viewSel").value = String(id);
  renderTable();
  renderPlots();
}

async function doRun() {
  const msg = $("runMsg");
  msg.textContent = "计算中…";
  try {
    const tzRaw = $("targetZ0").value.trim();
    const targetZ0 = tzRaw
      ? tzRaw.split(",").map((x) => Number(x.trim()))
      : undefined;
    const body = {
      name: $("runName").value || `run-${Date.now()}`,
      measuredName: $("measuredSel").value,
      leftName: $("leftSel").value,
      rightName: $("rightSel").value,
      strategy: $("strategySel").value,
      condWarn: Number($("condWarn").value),
      condFail: Number($("condFail").value),
      roundtripTol: Number($("roundtripTol").value),
      targetZ0,
    };
    const out = await api("/api/runs", { method: "POST", body: JSON.stringify(body) });
    msg.textContent = `已保存方案 #${out.id}；最大回验相对残差 ${out.report.maxRoundtripRel.toExponential(3)}`;
    await refreshRuns(out.id);
  } catch (err) {
    msg.textContent = err.message;
  }
}

async function doImport() {
  const msg = $("impMsg");
  try {
    const out = await api("/api/fixtures", {
      method: "POST",
      body: JSON.stringify({
        name: $("impName").value.trim(),
        role: $("impRole").value,
        touchstone: $("impText").value,
      }),
    });
    msg.textContent = `已导入 ${out.points} 点${out.warnings.length ? "；" + out.warnings.join(";") : ""}`;
    await refreshFixtures();
  } catch (err) {
    msg.textContent = err.message;
  }
}

async function doExport() {
  const res = await fetch("/api/export");
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "deembed-runs-export.json";
  a.click();
  URL.revokeObjectURL(url);
  $("ioOut").textContent = "已导出（含 fixtures 原文与 runs 请求/报告）。";
}

async function doReimport() {
  const file = $("reimpFile").files?.[0];
  if (!file) {
    $("ioOut").textContent = "请先选择导出的 JSON 文件";
    return;
  }
  const bundle = JSON.parse(await file.text());
  const out = await api("/api/reimport", {
    method: "POST",
    body: JSON.stringify({ bundle, wipe: $("reimpWipe").checked }),
  });
  $("ioOut").textContent = JSON.stringify(out, null, 2);
  await refreshFixtures();
  await refreshRuns();
}

async function doCompare() {
  const a = $("cmpA").value;
  const b = $("cmpB").value;
  const f = Number($("cmpFreq").value);
  const data = await api(`/api/compare/${a}/${b}`);
  const p = data.points.find((x) => x.freq === f);
  const out = $("cmpOut");
  if (!p) {
    out.textContent = `两方案在 ${(f / 1e9).toFixed(3)} GHz 无共同频点（按频率值内连接，非按下标）`;
    return;
  }
  const fmtC = (x) => (x ? `${x.re.toExponential(4)} ${x.im >= 0 ? "+" : ""}${x.im.toExponential(4)}j` : "null（严格奇异）");
  const keys = [
    ["S11", "m00"], ["S12", "m01"], ["S21", "m10"], ["S22", "m11"],
  ];
  const lines = [
    `频点 ${(f / 1e9).toFixed(4)} GHz`,
    `状态 A=${p.left.status}（${p.left.statusLevel}）  B=${p.right.status}（${p.right.statusLevel}）`,
  ];
  if (p.dS) {
    for (const [label, k] of keys) {
      lines.push(`Δ${label} = ${fmtC(p.dS[k])}`);
    }
    lines.push(`Frobenius 绝对差 ${p.abs.toExponential(4)}，相对差 ${p.rel.toExponential(4)}`);
  } else {
    lines.push("至少一方该频点为严格奇异（dutS=null），差值不可计算，不做零矩阵替代。");
  }
  lines.push(
    `全网格汇总：共同频点 ${data.summary.count}，最大绝对差 ${data.summary.maxAbs.toExponential(4)} @ ${(data.summary.freqMaxAbs / 1e9 || 0).toFixed(4)} GHz`,
  );
  out.textContent = lines.join("\n");
}

/* ---------------- Canvas 绘图 ---------------- */

function setupCanvas(cv) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = cv.clientWidth || cv.width;
  const cssH = cv.clientHeight || cv.height;
  cv.width = cssW * dpr;
  cv.height = cssH * dpr;
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: cssW, h: cssH };
}

function drawAxes(ctx, w, h, pad, xLabel, yLabel) {
  ctx.strokeStyle = "#2a3550";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad.l, pad.t);
  ctx.lineTo(pad.l, h - pad.b);
  ctx.lineTo(w - pad.r, h - pad.b);
  ctx.stroke();
  ctx.fillStyle = "#98a3ba";
  ctx.font = "11px ui-monospace, Menlo, monospace";
  ctx.fillText(yLabel, pad.l - 4, pad.t - 6);
  ctx.fillText(xLabel, w - pad.r - 10, h - pad.b + 16);
}

function plotXY(cv, series, opts) {
  const { ctx, w, h } = setupCanvas(cv);
  ctx.clearRect(0, 0, w, h);
  const pad = { l: 56, r: 14, t: 18, b: 30 };
  const xs = series[0].data.map((d) => d.x);
  const allY = series.flatMap((s) => s.data.map((d) => d.y)).filter(Number.isFinite);
  let yMin = Math.min(...allY);
  let yMax = Math.max(...allY);
  if (!(yMax > yMin)) { yMax += 1; yMin -= 1; }
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const X = (x) => pad.l + ((x - xMin) / (xMax - xMin)) * (w - pad.l - pad.r);
  const Y = (y) => h - pad.b - ((y - yMin) / (yMax - yMin)) * (h - pad.t - pad.b);
  // grid
  ctx.strokeStyle = "#222c44";
  for (let i = 0; i <= 5; i++) {
    const yy = pad.t + (i / 5) * (h - pad.t - pad.b);
    ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(w - pad.r, yy); ctx.stroke();
  }
  drawAxes(ctx, w, h, pad, "GHz", opts.yLabel);
  ctx.fillStyle = "#98a3ba";
  ctx.fillText(yMax.toExponential(2), 4, pad.t + 4);
  ctx.fillText(yMin.toExponential(2), 4, h - pad.b);
  series.forEach((s) => {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    let pen = false;
    s.data.forEach((d) => {
      if (!Number.isFinite(d.y)) { pen = false; return; }
      const px = X(d.x);
      const py = Y(d.y);
      if (!pen) { ctx.moveTo(px, py); pen = true; } else ctx.lineTo(px, py);
    });
    ctx.stroke();
    if (s.points) {
      ctx.fillStyle = s.color;
      for (const d of s.data) {
        if (Number.isFinite(d.y)) {
          ctx.beginPath(); ctx.arc(X(d.x), Y(d.y), 2.2, 0, Math.PI * 2); ctx.fill();
        }
      }
    }
  });
  return { X, Y, xMin, xMax, yMin, yMax };
}

function drawSmith(cv, points, badFreqs) {
  const { ctx, w, h } = setupCanvas(cv);
  ctx.clearRect(0, 0, w, h);
  const cx = w / 2;
  const cy = h / 2;
  const R = Math.min(w, h) / 2 - 24;
  ctx.strokeStyle = "#3a4767";
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy); ctx.stroke();
  // 简单等电阻圆 r=0.5/1/2（画示意网格即可）
  for (const rr of [0.5, 1, 2]) {
    const rho = rr / (rr + 1);
    const rad = R * (1 / (rr + 1));
    ctx.beginPath();
    ctx.arc(cx + R * rho, cy, rad, 0, Math.PI * 2);
    ctx.stroke();
  }
  // 等电抗弧 ±1
  for (const sign of [1, -1]) {
    ctx.beginPath();
    const xc = cx + R;
    const yc = cy - sign * R;
    ctx.arc(xc, yc, R, sign === 1 ? Math.PI : 0, sign === 1 ? Math.PI * 1.5 : Math.PI * 0.5);
    ctx.stroke();
  }
  // 轨迹
  ctx.strokeStyle = "#5cc8ff";
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  points.forEach((p, i) => {
    const px = cx + p.x * R;
    const py = cy - p.y * R;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.stroke();
  const bad = new Set(badFreqs ?? []);
  // 点
  points.forEach((p) => {
    ctx.fillStyle = bad.has(p.f) ? "#ef6b6b" : "#5cc8ff";
    ctx.beginPath();
    ctx.arc(cx + p.x * R, cy - p.y * R, bad.has(p.f) ? 3 : 1.4, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.fillStyle = "#98a3ba";
  ctx.font = "11px ui-monospace, Menlo, monospace";
  ctx.fillText("0", cx - 3, cy + 12);
  ctx.fillText("∞", cx + R - 8, cy + 12);
}

function renderPlots() {
  const d = state.detail;
  if (!d) return;
  const rep = d.report;
  const obj = $("viewObj").value;
  const key = $("viewKey").value;
  const mats = rep.points.map((p) => (obj === "dut" ? p.dutS : p.rebuiltS));
  const freqs = rep.targetGrid;
  const mag = [];
  const phase = [];
  const smith = [];
  const gd = [];
  let prevPhase = null;
  mats.forEach((s, i) => {
    const fGHz = freqs[i] / 1e9;
    if (!s) {
      mag.push({ x: fGHz, y: NaN });
      phase.push({ x: fGHz, y: NaN });
      gd.push({ x: fGHz, y: NaN });
      return;
    }
    const v = s[key];
    const amp = Math.hypot(v.re, v.im);
    mag.push({ x: fGHz, y: 20 * Math.log10(Math.max(amp, 1e-300)) });
    let ph = Math.atan2(v.im, v.re);
    if (prevPhase !== null) {
      while (ph - prevPhase > Math.PI) ph -= 2 * Math.PI;
      while (ph - prevPhase < -Math.PI) ph += 2 * Math.PI;
    }
    prevPhase = ph;
    phase.push({ x: fGHz, y: ph });
    if (i > 0 && i < freqs.length - 1 && mats[i - 1] && mats[i + 1]) {
      const v0 = mats[i - 1][key];
      const v1 = mats[i + 1][key];
      const p0 = Math.atan2(v0.im, v0.re);
      let p1 = Math.atan2(v1.im, v1.re);
      let pp = ph;
      while (pp - p0 > Math.PI) pp -= 2 * Math.PI;
      while (pp - p0 < -Math.PI) pp += 2 * Math.PI;
      while (p1 - pp > Math.PI) p1 -= 2 * Math.PI;
      while (p1 - pp < -Math.PI) p1 += 2 * Math.PI;
      const dw = 2 * Math.PI * (freqs[i + 1] - freqs[i - 1]);
      gd.push({ x: fGHz, y: (-(p1 - p0) / dw) * 1e9 });
    } else gd.push({ x: fGHz, y: NaN });
    smith.push({ x: s.m00.re, y: s.m00.im, f: freqs[i] });
  });
  plotXY($("magph"), [
    { data: mag, color: "#5cc8ff" },
    { data: phase, color: "#f2c14e" },
  ], { yLabel: "dB / rad" });
  plotXY($("gd"), [{ data: gd, color: "#4fd08a" }], { yLabel: "ns" });
  const resid = rep.points.map((p) => ({
    x: p.freq / 1e9,
    y: p.roundtripRel === null ? NaN : Math.max(-16, Math.log10(Math.max(p.roundtripRel, 1e-18))),
  }));
  plotXY($("resid"), [{ data: resid, color: "#b98cff", points: true }], { yLabel: "log10 rel err" });
  const bad = rep.points.filter((p) => p.statusLevel !== "ok").map((p) => p.freq);
  drawSmith($("smith"), smith, bad);
  $("cursor").textContent = `严格奇异 ${rep.counts.exact_singular} · 不稳定 ${rep.counts.unstable} · 近奇异 ${rep.counts.near_singular} · 外推 ${rep.counts.extrapolated}`;
}

function renderTable() {
  const rep = state.detail.report;
  const tb = $("diagTable").querySelector("tbody");
  const rows = rep.points
    .filter((p) => p.statusLevel !== "ok" || (p.roundtripRel !== null && p.roundtripRel > 1e-11))
    .map((p) => {
      const [label, cls] = STATUS_LABEL[p.status];
      const s21 = p.dutS ? Math.hypot(p.dutS.m10.re, p.dutS.m10.im).toExponential(3) : "null";
      return `<tr>
        <td>${(p.freq / 1e9).toFixed(4)}</td>
        <td><span class="badge ${cls}">${label}</span></td>
        <td>${fmtCond(p.measuredCond)}</td>
        <td>${fmtCond(p.leftCond)}</td>
        <td>${fmtCond(p.rightCond)}</td>
        <td>${p.leftExtrapolated ? "L" : ""}${p.rightExtrapolated ? "R" : ""}${!p.leftExtrapolated && !p.rightExtrapolated ? "—" : ""}</td>
        <td>${s21}</td>
        <td>${p.roundtripRel === null ? "null" : p.roundtripRel.toExponential(2)}</td>
        <td>${p.passivityExcess === null ? "null" : p.passivityExcess.toExponential(2)}</td>
        <td style="text-align:left">${p.messages.join(" / ")}</td>
      </tr>`;
    });
  tb.innerHTML = rows.join("");
}

function fmtCond(x) {
  if (!Number.isFinite(x)) return "∞";
  if (x >= 1e4 || x < 1e-2) return x.toExponential(2);
  return x.toFixed(2);
}

init();
