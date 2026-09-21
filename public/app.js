const state = { networks: [], runs: [], currentRun: null };

const $ = (id) => document.getElementById(id);
const api = async (path, options = {}) => {
  const response = await fetch(path, {
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    ...options,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? response.statusText);
  return data;
};
const fmt = (value, digits = 3) => (value === null || value === undefined || !Number.isFinite(value) ? '—' : Number(value).toExponential(digits));
const mhz = (value) => (value / 1e6).toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
const cabs = (value) => Math.hypot(value.re, value.im);

function setSelectOptions(select, items, selectedValue, labeler) {
  const previous = selectedValue ?? select.value;
  select.innerHTML = '';
  for (const item of items) {
    const option = document.createElement('option');
    option.value = item.name ?? item.runId;
    option.textContent = labeler(item);
    select.append(option);
  }
  if (previous && [...select.options].some((option) => option.value === previous)) select.value = previous;
}

async function refresh() {
  const [{ networks }, { runs }] = await Promise.all([api('/api/networks'), api('/api/runs')]);
  state.networks = networks;
  state.runs = runs;
  const measurements = networks.filter((network) => network.type === 'measurement');
  const left = networks.filter((network) => network.type === 'fixture-left');
  const right = networks.filter((network) => network.type === 'fixture-right');
  setSelectOptions($('measurementSelect'), measurements, 'measurement-cascaded', (item) => `${item.name} [${item.type}] Z0=${item.referenceOhm.map((z) => `${z.re}+${z.im}j`).join(', ')}`);
  setSelectOptions($('leftSelect'), left, 'left-fixture-75ohm', (item) => `${item.name} [${item.points.length}点]`);
  setSelectOptions($('rightSelect'), right, 'right-fixture-50ohm', (item) => `${item.name} [${item.points.length}点]`);
  setSelectOptions($('swapSelect'), networks, undefined, (item) => `${item.name} [${item.type}]`);
  for (const select of [$('baselineRun'), $('comparisonRun')]) {
    setSelectOptions(select, runs, undefined, (item) => `${item.runId} ${item.summary}`);
  }
  if (runs.length >= 2) {
    $('baselineRun').value = runs[runs.length - 1]?.runId ?? runs[0].runId;
    $('comparisonRun').value = runs[runs.length - 2]?.runId ?? runs[0].runId;
  }
  await loadLogs();
  if (state.currentRun) state.currentRun = runs.find((run) => run.runId === state.currentRun.runId) ?? runs[0] ?? null;
  if (!state.currentRun && runs.length > 0) state.currentRun = runs[0];
  renderRun();
}

async function loadLogs() {
  const data = await api('/api/export');
  $('logs').textContent = data.logs.map((log) => `${log.createdAt} ${log.action} ${log.detail}`).join('\n');
}

function runPayload() {
  return {
    measurementNetworkName: $('measurementSelect').value,
    leftNetworkName: $('leftSelect').value,
    rightNetworkName: $('rightSelect').value,
    gridStrategy: $('gridSelect').value,
    targetReferenceOhm: [
      { re: Number($('z01Re').value), im: Number($('z01Im').value) },
      { re: Number($('z02Re').value), im: Number($('z02Im').value) },
    ],
    tolerance: Number($('tolerance').value),
    nearSingularCondition: Number($('threshold').value),
  };
}

async function executeRun() {
  const record = await api('/api/runs', { method: 'POST', body: JSON.stringify(runPayload()) });
  state.currentRun = record;
  await refresh();
  state.currentRun = state.runs.find((run) => run.runId === record.runId) ?? record;
  renderRun();
}

function renderRun() {
  const run = state.currentRun;
  const summary = $('runSummary');
  if (!run) {
    summary.className = 'summary empty';
    summary.textContent = '尚未选择方案。';
    document.querySelector('#diagnosticTable tbody').innerHTML = '';
    drawPlaceholders();
    return;
  }
  summary.className = 'summary';
  summary.innerHTML = `<strong>${run.runId}</strong> · ${run.config.gridStrategy} 网格 · Z0=${run.config.targetReferenceOhm.map((z) => `${z.re}+${z.im}j`).join(', ')} Ω
    <span class="${run.allResidualsWithinTolerance ? 'good' : 'bad'}">最大残差 ${fmt(run.maxResidual)}</span>
    ｜近奇异 ${run.nearSingularCount}，硬奇异 ${run.singularCount}，物理不可行 ${run.infeasibleCount}，外推 ${run.extrapolationCount}`;
  renderDiagnostics(run);
  drawAll(run);
}

function renderDiagnostics(run) {
  const tbody = document.querySelector('#diagnosticTable tbody');
  tbody.innerHTML = '';
  for (const point of run.points) {
    const tr = document.createElement('tr');
    const messages = [...point.numericalMessages, ...point.physicalMessages].join('；') || '通过';
    tr.innerHTML = `
      <td>${mhz(point.frequencyHz)}</td>
      <td class="status-${point.numericalStatus}">${point.numericalStatus}</td>
      <td class="status-${point.physicalStatus}">${point.physicalStatus}</td>
      <td>${point.conditionNumber === null ? 'null' : fmt(point.conditionNumber)}</td>
      <td class="${point.residualWithinTolerance === false ? 'bad' : ''}">${fmt(point.residual)}</td>
      <td>${fmt(point.passivityMargin)}</td>
      <td>${point.extrapolated.join(',') || '—'}</td>
      <td>${messages}</td>`;
    tbody.append(tr);
  }
}

function prepareCanvas(canvas) {
  const ctx = canvas.getContext('2d');
  const ratio = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * ratio;
  canvas.height = rect.height * ratio;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { ctx, width: rect.width, height: rect.height };
}
const drawAxes = (ctx, x, y, width, height) => {
  ctx.strokeStyle = '#d6dce6';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, y); ctx.lineTo(x, y + height); ctx.lineTo(x + width, y + height);
  ctx.stroke();
};
const yScale = (values, height, padding = 4) => {
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 1e-15);
  const span = max - min || 1;
  return (value) => padding + height - ((value - min) / span) * (height - padding * 2);
};
const drawSeries = (ctx, points, x0, y0, width, height, color) => {
  const xs = points.map((point) => point.x);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const ys = points.map((point) => point.y);
  const y = yScale(ys, height);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  points.forEach((point, index) => {
    const px = x0 + ((point.x - minX) / ((maxX - minX) || 1)) * width;
    const py = y0 + y(point.y);
    if (index === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  });
  ctx.stroke();
};

function drawSmith(run) {
  const canvas = $('smithCanvas');
  const { ctx, width, height } = prepareCanvas(canvas);
  ctx.clearRect(0, 0, width, height);
  const centerX = width / 2, centerY = height / 2, radius = Math.min(width, height) * 0.38;
  ctx.strokeStyle = '#aeb9c8';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(centerX, centerY, radius, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(centerX - radius, centerY); ctx.lineTo(centerX + radius, centerY); ctx.stroke();
  const toSmith = (s) => ({ x: centerX + s.re * radius, y: centerY - s.im * radius });
  for (const [index, color] of [[0, '#1d5fd1'], [3, '#d97706']]) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    run.points.forEach((point, frequencyIndex) => {
      if (!point.estimatedDut) return;
      const position = toSmith(point.estimatedDut[index]);
      if (frequencyIndex === 0) ctx.moveTo(position.x, position.y); else ctx.lineTo(position.x, position.y);
    });
    ctx.stroke();
  }
  ctx.fillStyle = '#1d5fd1'; ctx.fillText('S11', 14, 18);
  ctx.fillStyle = '#d97706'; ctx.fillText('S22', 60, 18);
}

function drawMagPhase(run) {
  const canvas = $('magPhaseCanvas');
  const { ctx, width, height } = prepareCanvas(canvas);
  ctx.clearRect(0, 0, width, height);
  drawAxes(ctx, 42, 18, width - 58, height * 0.42);
  drawAxes(ctx, 42, height * 0.53, width - 58, height * 0.37);
  let phase = 0;
  let previousFrequency = null;
  let previousPhase = null;
  const magnitudes = [];
  const phases = [];
  run.points.forEach((point) => {
    const s21 = point.estimatedDut?.[2];
    if (!s21) return;
    const current = Math.atan2(s21.im, s21.re);
    if (previousPhase !== null) {
      let difference = current - previousPhase;
      while (difference > Math.PI) difference -= 2 * Math.PI;
      while (difference < -Math.PI) difference += 2 * Math.PI;
      phase += difference;
    }
    magnitudes.push({ x: point.frequencyHz / 1e6, y: 20 * Math.log10(Math.max(cabs(s21), 1e-15)) });
    phases.push({ x: point.frequencyHz / 1e6, y: phase });
    previousPhase = current;
    previousFrequency = point.frequencyHz;
  });
  drawSeries(ctx, magnitudes, 42, 18, width - 58, height * 0.42, '#1d5fd1');
  drawSeries(ctx, phases, 42, height * 0.53, width - 58, height * 0.37, '#0f766e');
  ctx.fillStyle = '#1d5fd1'; ctx.fillText('|S21| dB', 48, 16);
  ctx.fillStyle = '#0f766e'; ctx.fillText('unwrap phase rad', 48, height * 0.52);
}

function drawDelay(run) {
  const canvas = $('delayCanvas');
  const { ctx, width, height } = prepareCanvas(canvas);
  ctx.clearRect(0, 0, width, height);
  drawAxes(ctx, 48, 18, width - 64, height - 42);
  const points = [];
  let unwrapped = 0;
  let previous = null;
  run.points.forEach((point) => {
    const s21 = point.estimatedDut?.[2];
    if (!s21) return;
    const phase = Math.atan2(s21.im, s21.re);
    if (previous !== null) {
      let difference = phase - previous.phase;
      while (difference > Math.PI) difference -= 2 * Math.PI;
      while (difference < -Math.PI) difference += 2 * Math.PI;
      unwrapped += difference;
      const delay = -difference / (2 * Math.PI * (point.frequencyHz - previous.frequency));
      points.push({ x: point.frequencyHz / 1e6, y: delay * 1e9 });
    }
    previous = { phase, frequency: point.frequencyHz };
  });
  drawSeries(ctx, points, 48, 18, width - 64, height - 42, '#7c3aed');
  ctx.fillStyle = '#7c3aed'; ctx.fillText('group delay ns', 54, 16);
}

function drawResidual(run) {
  const canvas = $('residualCanvas');
  const { ctx, width, height } = prepareCanvas(canvas);
  ctx.clearRect(0, 0, width, height);
  drawAxes(ctx, 54, 18, width - 70, height - 42);
  const points = run.points
    .filter((point) => typeof point.residual === 'number')
    .map((point) => ({ x: point.frequencyHz / 1e6, y: Math.log10(Math.max(point.residual, 1e-18)) }));
  drawSeries(ctx, points, 54, 18, width - 70, height - 42, '#be123c');
  ctx.fillStyle = '#be123c';
  ctx.fillText(`log10 residual; tolerance ${run.config.tolerance.toExponential()}`, 60, 16);
}

function drawAll(run) { drawSmith(run); drawMagPhase(run); drawDelay(run); drawResidual(run); }
function drawPlaceholders() {
  for (const id of ['smithCanvas', 'magPhaseCanvas', 'delayCanvas', 'residualCanvas']) {
    const canvas = $(id);
    const { ctx, width, height } = prepareCanvas(canvas);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#7b8797';
    ctx.fillText('等待方案', width / 2 - 24, height / 2);
  }
}

async function compareRuns() {
  const data = await api(`/api/compare?baseline=${encodeURIComponent($('baselineRun').value)}&comparison=${encodeURIComponent($('comparisonRun').value)}`);
  const summary = $('comparisonSummary');
  summary.className = 'summary';
  summary.textContent = `共享频点 ${data.sharedFrequencyCount}；最大复差 ${data.maxAbsDifference === null ? 'n/a' : data.maxAbsDifference.toExponential(6)}。只按完全相同的频率比较，不按数组下标配对。`;
  const tbody = document.querySelector('#comparisonTable tbody');
  tbody.innerHTML = '';
  for (const point of data.points) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${mhz(point.frequencyHz)}</td><td>${fmt(point.maxAbsDifference)}</td><td>${fmt(point.rmsDifference)}</td>${point.perParameter.map((value) => `<td>${fmt(value)}</td>`).join('')}`;
    tbody.append(tr);
  }
}

$('runForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  try { await executeRun(); } catch (error) { alert(error.message); }
});
$('refreshButton').addEventListener('click', () => refresh().catch((error) => alert(error.message)));
$('importButton').addEventListener('click', async () => {
  try {
    await api('/api/networks/import', {
      method: 'POST',
      body: JSON.stringify({
        name: $('importName').value,
        type: $('importType').value,
        touchstone: $('touchstoneText').value,
      }),
    });
    await refresh();
  } catch (error) { alert(error.message); }
});
$('swapButton').addEventListener('click', async () => {
  try {
    const result = await api('/api/ports-swap', { method: 'POST', body: JSON.stringify({ name: $('swapSelect').value }) });
    alert(`已生成 ${result.network.name}`);
    await refresh();
  } catch (error) { alert(error.message); }
});
$('replayButton').addEventListener('click', async () => {
  try {
    const result = await api('/api/reset-and-replay', { method: 'POST' });
    state.currentRun = null;
    alert(result.message);
    await refresh();
  } catch (error) { alert(error.message); }
});
$('exportButton').addEventListener('click', () => {
  api('/api/export')
    .then((data) => {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `deembed-run-record-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    })
    .catch((error) => alert(error.message));
});
$('compareButton').addEventListener('click', () => compareRuns().catch((error) => alert(error.message)));
window.addEventListener('resize', () => { if (state.currentRun) drawAll(state.currentRun); });
refresh().catch((error) => alert(error.message));
