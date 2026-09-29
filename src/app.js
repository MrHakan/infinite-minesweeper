import {
  WorldState, isMine, neighborCount, computeScore, makeResult, encodeActions, decodeActions,
  createShareCode, verifyShareCode, randomSeed
} from './core.js';
import { PlayClock, dailyWorld, parseSeed, sanitizeCamera } from './session.js';

const GIST_ID = '02990dee7192a0419aeb0b208b54b02d';
const GIST_URL = `https://gist.github.com/MrHakan/${GIST_ID}`;
const COMMENTS_API = `https://api.github.com/gists/${GIST_ID}/comments`;
const SAVE_KEY = 'infinite-minesweeper.active.v1';
const HISTORY_KEY = 'infinite-minesweeper.history.v1';
const SETTINGS_KEY = 'infinite-minesweeper.settings.v1';
const LB_CACHE_KEY = 'infinite-minesweeper.leaderboard-cache.v1';
const $ = s => document.querySelector(s);
const canvas = $('#game');
const ctx = canvas.getContext('2d', { alpha: false });
const menu = $('#menu');
const gameHud = $('#gameHud');
const controls = $('#boardControls');
const deathPanel = $('#deathPanel');
const statsPanel = $('#statsPanel');
const continueBtn = $('#continueBtn');
const toast = $('#toast');
const colors = ['', '#255e94', '#46702f', '#b4452c', '#684491', '#923e3e', '#207478', '#5e5527', '#333b30'];
let screen = 'menu';
let run = null, world = null, clock = null;
let actions = [], recordedElapsed = 0;
let camera = { x: 0, y: 0, zoom: 36 };
let lastCleared = { x: 0, y: 0 }, selection = null;
let view = { width: 0, height: 0 };
let raf = 0, saveTimer = 0, pendingWorld = null;
let endedResult = null, endedCode = '', endingId = 0;
let inputMode = 'reveal', pinch = null;
let leaderboardEntries = [], leaderboardLoading = false;
let audioContext;
const pointers = new Map();
const storedSettings = loadJson(SETTINGS_KEY, {});
const settings = { grid: storedSettings?.grid !== false, sound: storedSettings?.sound === true };

function loadJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function historyData() { const data = loadJson(HISTORY_KEY, []); return Array.isArray(data) ? data : []; }
function saveJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch { return false; }
}
function removeSave() { try { localStorage.removeItem(SAVE_KEY); } catch { /* Storage may be disabled. */ } }
function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 3200);
}
function sound(kind) {
  if (!settings.sound) return;
  try {
    audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
    void audioContext.resume().catch(() => {});
    const osc = audioContext.createOscillator(), gain = audioContext.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(kind === 'mine' ? 150 : kind === 'flag' ? 530 : 760, audioContext.currentTime);
    gain.gain.setValueAtTime(.035, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(.001, audioContext.currentTime + .11);
    osc.connect(gain); gain.connect(audioContext.destination);
    osc.start(); osc.stop(audioContext.currentTime + .12);
  } catch { /* Audio is optional. */ }
}
function resumeClock() {
  if (screen === 'game' && run && !run.dead && !document.hidden && !$('#helpDialog').open && !$('#replaceDialog').open) clock.resume();
}
function activeSave() {
  const data = loadJson(SAVE_KEY, null);
  return data && !data.dead && data.world ? data : null;
}
function requestRun(options = {}) {
  pendingWorld = options;
  if (activeSave() || (run && !run.dead)) {
    clock?.pause();
    $('#replaceDialog').showModal();
  } else newRun(options);
}
function newRun({ seed = randomSeed(), mode = 'random', day = '' } = {}) {
  endingId++;
  run = { seed, mode, day, dead: false };
  world = new WorldState(seed);
  actions = [{ t: 'r', x: 0, y: 0, dt: 0 }];
  recordedElapsed = 0;
  clock = new PlayClock();
  camera = { x: 0, y: 0, zoom: 36 };
  lastCleared = { x: 0, y: 0 };
  selection = null;
  endedResult = null; endedCode = '';
  $('#shareCodeWrap').classList.add('hidden');
  world.reveal(0, 0);
  setInputMode('reveal');
  openGame();
  queueSave(true);
}
function restoreRun() {
  if (run && !run.dead) { openGame(); return true; }
  const data = activeSave();
  if (!data || (!Array.isArray(data.actions) && typeof data.actionLog !== 'string')) return false;
  try {
    const seed = parseSeed(data.seed);
    if (seed === null) throw new Error('Invalid seed');
    const restored = typeof data.actionLog === 'string' ? decodeActions(data.actionLog, Infinity) : data.actions.filter(a => a && ['r', 'f', 'c'].includes(a.t));
    if (!restored.length) throw new Error('Empty action log');
    world = new WorldState(seed, data.world);
    actions = restored;
    recordedElapsed = actions.reduce((sum, a) => sum + a.dt, 0);
    clock = new PlayClock(Math.max(recordedElapsed, Number(data.elapsedMs) || 0));
    run = { seed, mode: ['random', 'daily', 'seed'].includes(data.mode) ? data.mode : 'random', day: String(data.day || ''), dead: false };
    camera = sanitizeCamera(data.camera);
    const last = [...actions].reverse().find(a => a.t === 'r' || a.t === 'c');
    lastCleared = last ? { x: last.x, y: last.y } : { x: 0, y: 0 };
    selection = null;
    openGame();
    return true;
  } catch {
    run = null; world = null; clock = null;
    removeSave();
    showToast('This save could not be restored. Start a new expedition.');
    refreshContinue();
    return false;
  }
}
function elapsedMs() { return clock?.elapsed() || 0; }
function queueSave(immediate = false) {
  clearTimeout(saveTimer);
  $('#saveStatus').textContent = 'Saving…';
  if (immediate) persistRun();
  else saveTimer = setTimeout(persistRun, 650);
}
function persistRun() {
  clearTimeout(saveTimer); saveTimer = 0;
  if (!run || run.dead || !world) return;
  const ok = saveJson(SAVE_KEY, {
    ...run, elapsedMs: Math.floor(elapsedMs()), camera,
    world: world.serialize(), actionLog: encodeActions(actions)
  });
  $('#saveStatus').textContent = ok ? 'Saved locally' : 'Save unavailable';
  if (!ok && !persistRun.warned) {
    persistRun.warned = true;
    showToast('Device storage is unavailable or full. Keep this tab open to preserve your run.');
  }
}
function setScreen(next) {
  clock?.pause();
  screen = next;
  pointers.clear(); pinch = null;
  menu.classList.toggle('hidden', next !== 'menu');
  statsPanel.classList.toggle('hidden', next !== 'stats');
  gameHud.classList.toggle('hidden', next !== 'game');
  controls.classList.toggle('hidden', next !== 'game');
  canvas.classList.toggle('hidden', next !== 'game');
  $('#boardSettings').classList.add('hidden');
  closeResults();
  $('#resultsBtn').classList.toggle('hidden', next !== 'game' || !run?.dead);
  if (next === 'game') {
    $('#hudSeed').textContent = `SEED ${run.seed}`;
    $('#hudMode').textContent = run.mode === 'daily' ? `DAILY / ${run.day}` : run.mode === 'seed' ? 'SHARED WORLD' : 'RANDOM WORLD';
    resumeClock(); resize(); updateHud(); canvas.focus({ preventScroll: true });
  }
}
function openGame() { setScreen('game'); }
function openMenu() {
  clock?.pause();
  if (run && !run.dead) persistRun();
  setScreen('menu'); refreshContinue(); refreshDaily();
  continueBtn.disabled ? $('#newBtn').focus() : continueBtn.focus();
}
function refreshContinue() {
  const data = activeSave();
  continueBtn.disabled = !(data || (run && !run.dead));
  continueBtn.textContent = continueBtn.disabled ? 'Continue run' : 'Continue →';
  $('#continueSummary').textContent = data
    ? `${Number(data.world.revealedCount || 0).toLocaleString()} cells cleared · ${formatTime(data.elapsedMs || 0)} · seed ${data.seed}`
    : 'Your progress stays on this device.';
}
function refreshDaily() {
  const { day } = dailyWorld();
  $('#dailyDate').textContent = new Date(`${day}T12:00:00Z`).toLocaleDateString('en', { day: 'numeric', month: 'long', timeZone: 'UTC' });
  $('#dailyBtn').title = `Shared daily world for ${day}. Resets at midnight UTC.`;
}
function recordAction(t, x, y) {
  const total = Math.max(recordedElapsed, Math.floor(elapsedMs()));
  actions.push({ t, x, y, dt: total - recordedElapsed });
  recordedElapsed = total;
}
function revealCell(x, y) {
  if (!run || run.dead) return;
  if (!world.canInteract(x, y)) { showToast('Reveal a cell on the green edge to expand your field.'); return; }
  const chord = world.isRevealed(x, y);
  const result = chord ? world.chord(x, y) : world.reveal(x, y);
  if (!result.accepted) {
    if (chord && neighborCount(x, y, world.seed)) showToast('Quick open needs the matching number of neighboring flags.');
    return;
  }
  recordAction(chord ? 'c' : 'r', x, y);
  if (result.mine) { sound('mine'); endRun(result.hit?.x ?? x, result.hit?.y ?? y); }
  else {
    lastCleared = { x, y }; sound('reveal'); queueSave(); updateHud(); markDirty();
    if (selection) describeCell();
  }
}
function flagCell(x, y) {
  if (!run || run.dead || !world.toggleFlag(x, y)) return;
  recordAction('f', x, y); sound('flag'); queueSave(); updateHud(); markDirty();
  if (selection) describeCell();
}
async function endRun(hitX, hitY) {
  clock.pause(); run.dead = true; run.hit = { x: hitX, y: hitY };
  clearTimeout(saveTimer); removeSave();
  endedResult = makeResult(world, recordedElapsed, actions.length);
  const history = historyData();
  history.unshift({ ...endedResult, seed: run.seed, mode: run.mode, day: run.day, at: new Date().toISOString() });
  saveJson(HISTORY_KEY, history.slice(0, 100));
  $('#saveStatus').textContent = 'Run complete';
  $('#deathScore').textContent = endedResult.score.toLocaleString();
  $('#deathNote').textContent = `Mine at (${hitX}, ${hitY}) · seed ${run.seed}${run.mode === 'daily' ? ` · daily ${run.day}` : ''}`;
  $('#deathGrid').innerHTML = [
    ['Cells cleared', endedResult.revealed.toLocaleString()], ['Active time', formatTime(endedResult.elapsedMs)],
    ['Farthest reach', `${endedResult.maxDistance} cells`], ['Flags placed', endedResult.flags.toLocaleString()],
    ['Flag accuracy', `${endedResult.flagAccuracy}%`], ['Inputs', endedResult.actions.toLocaleString()]
  ].map(([k, v]) => `<div><span>${k}</span><strong>${v}</strong></div>`).join('');
  $('#shareBtn').disabled = true;
  $('#shareBtn').textContent = 'Preparing replay…';
  openResults(); markDirty(); updateHud();
  const id = endingId;
  try {
    const code = await createShareCode(run.seed, actions, endedResult);
    if (id !== endingId) return;
    endedCode = code;
    $('#shareBtn').disabled = false;
    $('#shareBtn').textContent = 'Share verified replay ↗';
  } catch {
    if (id === endingId) $('#shareBtn').textContent = 'Replay unavailable';
  }
}
function openResults() {
  deathPanel.classList.remove('hidden');
  canvas.inert = gameHud.inert = controls.inert = true;
  $('#resultsBtn').classList.add('hidden');
  $('#retryBtn').focus();
}
function closeResults() {
  deathPanel.classList.add('hidden');
  canvas.inert = gameHud.inert = controls.inert = false;
}
async function shareRun() {
  if (!endedCode) return;
  // Keep a manual copy available even if clipboard access is denied.
  $('#shareCode').value = endedCode;
  $('#shareCodeWrap').classList.remove('hidden');
  window.open(GIST_URL, '_blank', 'noopener,noreferrer');
  try { await navigator.clipboard.writeText(endedCode); showToast('Replay copied. Paste it as a Gist comment.'); }
  catch { $('#shareCode').select(); showToast('Copy this replay and paste it as a Gist comment.'); }
}
function formatTime(ms) {
  const s = Math.floor(Math.max(0, ms) / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${h ? `${h}:` : ''}${h ? String(m).padStart(2, '0') : m}:${String(sec).padStart(2, '0')}`;
}
function updateHud() {
  if (!world || !run) return;
  // Final flag accuracy scans all chunks; live counters must stay constant-cost.
  $('#hudScore').textContent = (run.dead ? endedResult.score : computeScore(world, elapsedMs())).toLocaleString();
  $('#hudCells').textContent = world.revealedCount.toLocaleString();
  $('#hudFlags').textContent = world.flagCount.toLocaleString();
  $('#hudDistance').textContent = world.maxDistance.toLocaleString();
  $('#hudTime').textContent = formatTime(run.dead ? endedResult.elapsedMs : elapsedMs());
  $('#zoomValue').textContent = `${Math.round(camera.zoom / 36 * 100)}%`;
  const selected = selection || { x: Math.round(camera.x), y: Math.round(camera.y) };
  $('#coordinates').textContent = `X ${selected.x} / Y ${selected.y}`;
}
function resize() {
  if (screen !== 'game') return;
  const dpr = Math.min(2, devicePixelRatio || 1), rect = canvas.getBoundingClientRect();
  view = { width: rect.width, height: rect.height };
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); markDirty();
}
function markDirty() { if (!raf) raf = requestAnimationFrame(render); }
function exactWorld(px, py) {
  const rect = canvas.getBoundingClientRect();
  return { x: camera.x + (px - rect.left - view.width / 2) / camera.zoom, y: camera.y + (py - rect.top - view.height / 2) / camera.zoom };
}
function screenToWorld(px, py) {
  const p = exactWorld(px, py);
  return { x: Math.floor(p.x + .5), y: Math.floor(p.y + .5) };
}
function zoomAt(zoom, px = view.width / 2, py = view.height / 2) {
  const before = exactWorld(px, py);
  camera.zoom = Math.max(18, Math.min(64, zoom));
  const after = exactWorld(px, py);
  camera.x += before.x - after.x; camera.y += before.y - after.y;
  markDirty(); if (!run?.dead) queueSave();
}
function render() {
  raf = 0;
  if (!world || screen !== 'game') return;
  const { width, height } = view;
  ctx.fillStyle = '#dce2cf'; ctx.fillRect(0, 0, width, height);
  const halfX = Math.ceil(width / camera.zoom / 2) + 1, halfY = Math.ceil(height / camera.zoom / 2) + 1;
  for (let y = Math.floor(camera.y) - halfY; y <= Math.floor(camera.y) + halfY; y++) {
    for (let x = Math.floor(camera.x) - halfX; x <= Math.floor(camera.x) + halfX; x++) drawCell(x, y);
  }
  updateHud();
}
function drawFlag(context, x, y, size, color = '#ba421e') {
  context.strokeStyle = color; context.lineWidth = Math.max(1.5, size * .045);
  context.beginPath(); context.moveTo(x - size * .14, y + size * .22); context.lineTo(x - size * .14, y - size * .22); context.stroke();
  context.fillStyle = color; context.beginPath(); context.moveTo(x - size * .14, y - size * .22); context.lineTo(x + size * .22, y - size * .1); context.lineTo(x - size * .14, y + size * .01); context.fill();
}
function drawCell(x, y) {
  const z = camera.zoom, px = view.width / 2 + (x - camera.x) * z, py = view.height / 2 + (y - camera.y) * z;
  const left = px - z / 2, top = py - z / 2;
  const revealed = world.isRevealed(x, y), flagged = world.isFlagged(x, y);
  const frontier = !revealed && world.canInteract(x, y);
  const mine = run.dead && isMine(x, y, world.seed);
  const hit = run.hit?.x === x && run.hit?.y === y;
  ctx.fillStyle = hit ? '#c74320' : mine ? '#e5b9a2' : flagged ? '#f0d8b7' : revealed ? '#f4f1e9' : frontier ? '#b8c7a0' : '#dce2cf';
  const gap = settings.grid ? 1 : 0;
  ctx.fillRect(left + gap, top + gap, z - gap * 2, z - gap * 2);
  if (settings.grid) {
    ctx.strokeStyle = revealed ? '#d4d7c8' : '#cbd3be';
    ctx.lineWidth = 1; ctx.strokeRect(left + .5, top + .5, z - 1, z - 1);
  }
  if (flagged) {
    drawFlag(ctx, px, py, z);
    if (run.dead && !mine) { ctx.strokeStyle = '#b73525'; ctx.beginPath(); ctx.moveTo(left + 5, top + 5); ctx.lineTo(left + z - 5, top + z - 5); ctx.stroke(); }
  } else if (mine) {
    ctx.fillStyle = hit ? '#fff5df' : '#b4452c'; ctx.beginPath(); ctx.arc(px, py, z * .13, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = 1.6;
    for (let i = 0; i < 4; i++) { const a = i * Math.PI / 4; ctx.beginPath(); ctx.moveTo(px - Math.cos(a) * z * .22, py - Math.sin(a) * z * .22); ctx.lineTo(px + Math.cos(a) * z * .22, py + Math.sin(a) * z * .22); ctx.stroke(); }
  } else if (revealed) {
    const n = neighborCount(x, y, world.seed);
    if (n) {
      ctx.fillStyle = colors[n]; ctx.font = `600 ${Math.max(11, z * .46)}px ui-monospace, monospace`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(n), px, py + 1);
    }
  } else if (!frontier && z >= 26) {
    ctx.fillStyle = '#b9c3ab'; ctx.fillRect(px - 1, py - 1, 2, 2);
  }
  if (selection?.x === x && selection?.y === y) {
    ctx.strokeStyle = '#222c28'; ctx.lineWidth = 2.5; ctx.strokeRect(left + 3, top + 3, z - 6, z - 6);
  }
}
function drawPreview() {
  const preview = $('#preview'), c = preview.getContext('2d');
  const demo = new WorldState(20383); demo.reveal(0, 0);
  c.fillStyle = '#dfe4d3'; c.fillRect(0, 0, 480, 360);
  const size = 44, ox = 42, oy = 26;
  for (let row = 0; row < 7; row++) for (let col = 0; col < 9; col++) {
    const x = col - 4, y = row - 3, px = ox + col * size, py = oy + row * size;
    const open = demo.isRevealed(x, y), edge = demo.canInteract(x, y);
    c.fillStyle = open ? '#f4f1e9' : edge ? '#b8c7a0' : '#d3dcc5'; c.fillRect(px, py, size - 2, size - 2);
    if (open) {
      const n = neighborCount(x, y, demo.seed);
      if (n) { c.fillStyle = colors[n]; c.font = '600 22px monospace'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(String(n), px + 21, py + 22); }
    } else if (edge && isMine(x, y, demo.seed)) drawFlag(c, px + 21, py + 21, size);
  }
}
function setInputMode(mode) {
  inputMode = mode;
  for (const [id, value] of [['revealModeBtn', 'reveal'], ['flagModeBtn', 'flag']]) {
    $(`#${id}`).classList.toggle('selected', mode === value); $(`#${id}`).setAttribute('aria-pressed', mode === value);
  }
  $('#boardHint').textContent = mode === 'flag' ? 'Tap covered cells to flag. Tap an open number to quick open.' : 'Read the numbers. Expand from the green edge.';
}
function recenter(cell) {
  camera.x = cell.x; camera.y = cell.y; selection = { ...cell };
  markDirty(); if (!run.dead) queueSave();
}
function describeCell() {
  if (!selection || !world) return;
  const { x, y } = selection;
  const status = world.isFlagged(x, y) ? 'flagged' : world.isRevealed(x, y) ? `${neighborCount(x, y, world.seed)} neighboring mines` : world.canInteract(x, y) ? 'covered frontier cell' : 'unexplored, outside the frontier';
  $('#cellStatus').textContent = `Cell ${x}, ${y}: ${status}`;
}
// Every touch belongs to a gesture. Ending a pinch never reveals a cell.
canvas.addEventListener('contextmenu', e => e.preventDefault());
canvas.addEventListener('pointerdown', e => {
  if (screen !== 'game') return;
  canvas.focus({ preventScroll: true }); canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { sx: e.clientX, sy: e.clientY, x: e.clientX, y: e.clientY, cx: camera.x, cy: camera.y, zoom: camera.zoom, moved: false, time: performance.now(), button: e.button });
  if (pointers.size >= 2) {
    const [a, b] = [...pointers.values()];
    for (const p of pointers.values()) p.moved = true;
    pinch = { distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), zoom: camera.zoom, anchor: exactWorld((a.x + b.x) / 2, (a.y + b.y) / 2) };
  }
});
canvas.addEventListener('pointermove', e => {
  const p = pointers.get(e.pointerId);
  if (!p) return;
  p.x = e.clientX; p.y = e.clientY;
  if (pinch && pointers.size >= 2) {
    const [a, b] = [...pointers.values()];
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    camera.zoom = Math.max(18, Math.min(64, pinch.zoom * Math.hypot(a.x - b.x, a.y - b.y) / pinch.distance));
    const current = exactWorld(mx, my);
    camera.x += pinch.anchor.x - current.x; camera.y += pinch.anchor.y - current.y;
    markDirty(); return;
  }
  const dx = e.clientX - p.sx, dy = e.clientY - p.sy;
  if (Math.hypot(dx, dy) > 6) p.moved = true;
  if (p.moved) { camera.x = p.cx - dx / p.zoom; camera.y = p.cy - dy / p.zoom; markDirty(); }
});
function releasePointer(e, cancelled = false) {
  const p = pointers.get(e.pointerId); if (!p) return;
  pointers.delete(e.pointerId); pinch = null;
  for (const other of pointers.values()) {
    Object.assign(other, { sx: other.x, sy: other.y, cx: camera.x, cy: camera.y, zoom: camera.zoom, moved: true });
  }
  if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
  if (!p.moved && !cancelled && !run.dead) {
    selection = screenToWorld(e.clientX, e.clientY);
    const flagGesture = p.button === 2 || performance.now() - p.time > 520;
    if (flagGesture || (inputMode === 'flag' && !world.isRevealed(selection.x, selection.y))) flagCell(selection.x, selection.y);
    else revealCell(selection.x, selection.y);
    describeCell(); markDirty();
  } else if (!run.dead) queueSave();
}
canvas.addEventListener('pointerup', e => releasePointer(e));
canvas.addEventListener('pointercancel', e => releasePointer(e, true));
canvas.addEventListener('lostpointercapture', e => { pointers.delete(e.pointerId); if (pointers.size < 2) pinch = null; });
canvas.addEventListener('wheel', e => { e.preventDefault(); zoomAt(camera.zoom * Math.exp(-e.deltaY * .0012), e.clientX, e.clientY); }, { passive: false });
canvas.addEventListener('keydown', e => {
  if (screen !== 'game' || $('#helpDialog').open) return;
  const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
  if (directions[e.key]) {
    e.preventDefault(); selection ||= { x: Math.round(camera.x), y: Math.round(camera.y) };
    selection.x += directions[e.key][0]; selection.y += directions[e.key][1];
    // Keep the selected cell between the HUD and the control dock.
    const px = view.width / 2 + (selection.x - camera.x) * camera.zoom;
    const py = view.height / 2 + (selection.y - camera.y) * camera.zoom;
    const top = gameHud.getBoundingClientRect().bottom + 25, bottom = controls.getBoundingClientRect().top - 25;
    if (px < 30 || px > view.width - 30) camera.x = selection.x;
    if (py < top || py > bottom) camera.y = selection.y;
    describeCell(); markDirty(); if (!run.dead) queueSave();
  } else if (['Enter', ' ', 'f', 'F', 'c', 'C'].includes(e.key)) {
    e.preventDefault(); selection ||= { x: Math.round(camera.x), y: Math.round(camera.y) };
    if (e.key.toLowerCase() === 'f') flagCell(selection.x, selection.y);
    else revealCell(selection.x, selection.y);
    describeCell(); markDirty();
  } else if (e.key === 'Home') { e.preventDefault(); recenter({ x: 0, y: 0 }); }
  else if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomAt(camera.zoom * 1.2); }
  else if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomAt(camera.zoom / 1.2); }
});
function showHelp() { clock?.pause(); persistRun(); $('#helpDialog').showModal(); }
async function openStats() {
  clock?.pause(); persistRun(); setScreen('stats'); renderLocalHistory();
  await loadLeaderboard();
}
function renderLocalHistory() {
  const history = historyData(), box = $('#localHistory');
  const score = Math.max(0, ...history.map(r => Number(r.score) || 0));
  const cells = history.reduce((sum, r) => sum + (Number(r.revealed) || 0), 0);
  $('#archiveSummary').innerHTML = [['Finished runs', history.length], ['Best score', score.toLocaleString()], ['Archived cells', cells.toLocaleString()]].map(([label, value]) => `<div><span>${label}</span><strong>${value}</strong></div>`).join('');
  if (!history.length) { box.innerHTML = '<div class="empty">Your first expedition is still ahead.<br>Finished runs will appear here.</div>'; return; }
  box.innerHTML = history.slice(0, 12).map((r, i) => `<div class="historyRow"><span>${String(i + 1).padStart(2, '0')}</span><div><strong>${Number(r.score || 0).toLocaleString()}</strong><small>${Number(r.revealed || 0).toLocaleString()} cells · ${formatTime(Number(r.elapsedMs) || 0)}<br>${r.mode === 'daily' ? 'DAILY · ' : ''}SEED ${escapeHtml(r.seed)}</small></div><button data-seed="${escapeHtml(r.seed)}" aria-label="Replay world seed ${escapeHtml(r.seed)}">Replay ↗</button></div>`).join('');
}

async function fetchAllComments() {
  const all = [];
  for (let page = 1; page <= 5; page++) {
    const res = await fetch(`${COMMENTS_API}?per_page=100&page=${page}`, { headers: { 'Accept': 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`GitHub API ${res.status}`);
    const batch = await res.json();
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

function extractCode(body) {
  const m = String(body || '').match(/IM1\.[A-Za-z0-9_-]{20,240000}/);
  return m ? m[0] : null;
}

async function loadLeaderboard(force = false) {
  if (leaderboardLoading) return;
  leaderboardLoading = true;
  $('#refreshLeaderboard').disabled = true;
  const status = $('#leaderboardStatus');
  status.textContent = 'Loading & verifying Gist comments…';
  try {
    const comments = await fetchAllComments();
    const cache = loadJson(LB_CACHE_KEY, {});
    const entries = [];
    for (let i = 0; i < comments.length; i++) {
      const c = comments[i];
      const code = extractCode(c.body);
      if (!code || !c.user?.login) continue;
      const cacheKey = `${c.id}:${c.updated_at}:${code.slice(-20)}`;
      let verified = !force ? cache[cacheKey] : null;
      if (!verified) {
        verified = await verifyShareCode(code);
        if (verified.valid) cache[cacheKey] = verified;
      }
      if (verified.valid) {
        entries.push({
          id: c.id,
          user: c.user.login,
          avatar: c.user.avatar_url,
          url: c.html_url,
          createdAt: c.created_at,
          ...verified.result
        });
      }
      if (i % 12 === 0) {
        status.textContent = `Verifying ${i + 1}/${comments.length} comments…`;
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
    const trimmed = Object.fromEntries(Object.entries(cache).slice(-400));
    saveJson(LB_CACHE_KEY, trimmed);
    leaderboardEntries = entries;
    renderLeaderboard();
    status.textContent = `${entries.length} replay-verified run${entries.length === 1 ? '' : 's'} from ${comments.length} comments.`;
  } catch (error) {
    console.warn(error);
    status.textContent = 'Could not load Gist comments. GitHub may be rate-limiting this browser.';
    $('#leaderboardBody').innerHTML = '<tr><td colspan="6" class="empty">Leaderboard temporarily unavailable.</td></tr>';
  } finally {
    leaderboardLoading = false;
    $('#refreshLeaderboard').disabled = false;
  }
}

function renderLeaderboard() {
  let entries = [...leaderboardEntries];
  const metric = $('#metricFilter').value;
  const period = $('#periodFilter').value;
  const search = $('#playerFilter').value.trim().toLowerCase();
  const bestOnly = $('#bestOnly').checked;
  const now = Date.now();
  const age = period === '7d' ? 7*864e5 : period === '30d' ? 30*864e5 : Infinity;
  entries = entries.filter(e => now - new Date(e.createdAt).getTime() <= age && (!search || e.user.toLowerCase().includes(search)));
  const key = metric === 'cells' ? 'revealed' : metric === 'time' ? 'elapsedMs' : metric === 'distance' ? 'maxDistance' : 'score';
  entries.sort((a,b) => b[key] - a[key] || b.score - a.score || new Date(a.createdAt) - new Date(b.createdAt));
  if (bestOnly) {
    const seen = new Set();
    entries = entries.filter(e => seen.has(e.user.toLowerCase()) ? false : (seen.add(e.user.toLowerCase()), true));
  }
  const body = $('#leaderboardBody');
  if (!entries.length) { body.innerHTML = '<tr><td colspan="6" class="empty">No matching verified runs.</td></tr>'; return; }
  body.innerHTML = entries.slice(0, 100).map((e, i) => `<tr>
    <td class="rank">${i+1}</td>
    <td><a href="${escapeHtml(e.url)}" target="_blank" rel="noopener noreferrer" class="player"><img src="${escapeHtml(e.avatar)}" alt=""><span>${escapeHtml(e.user)}</span></a></td>
    <td>${e.score.toLocaleString()}</td><td>${e.revealed.toLocaleString()}</td><td>${formatTime(e.elapsedMs)}</td><td>${e.maxDistance.toLocaleString()}</td>
  </tr>`).join('');
}
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }


$('#newBtn').addEventListener('click', () => requestRun());
$('#dailyBtn').addEventListener('click', () => { const { seed, day } = dailyWorld(); requestRun({ seed, day, mode: 'daily' }); });
continueBtn.addEventListener('click', restoreRun);
$('#confirmNewBtn').addEventListener('click', () => { const options = pendingWorld; pendingWorld = null; $('#replaceDialog').close(); newRun(options); });
$('#cancelNewBtn').addEventListener('click', () => $('#replaceDialog').close());
$('#replaceDialog').addEventListener('close', resumeClock);
$('#seedForm').addEventListener('submit', e => {
  e.preventDefault();
  const seed = parseSeed($('#seedInput').value);
  if (seed === null) { $('#seedError').textContent = 'Enter a whole number from 0 to 4294967295.'; $('#seedInput').setAttribute('aria-invalid', 'true'); return; }
  $('#seedError').textContent = 'Use the same seed to explore the same field.';
  $('#seedInput').removeAttribute('aria-invalid'); requestRun({ seed, mode: 'seed' });
});
$('#localHistory').addEventListener('click', e => {
  const button = e.target.closest('button[data-seed]');
  const seed = button ? parseSeed(button.dataset.seed) : null;
  if (seed !== null) requestRun({ seed, mode: 'seed' });
});
async function shareWorld() {
  const url = new URL(location.href); url.search = ''; url.hash = ''; url.searchParams.set('seed', run.seed);
  try { await navigator.clipboard.writeText(url.href); showToast('World link copied. Everyone starts with the same field.'); }
  catch { window.prompt('Copy this link to share the same world:', url.href); }
}
$('#seedCopyBtn').addEventListener('click', shareWorld);
$('#hudMode').addEventListener('click', shareWorld);
$('#statsBtn').addEventListener('click', openStats);
for (const id of ['menuBtn', 'statsBackBtn', 'deathMenuBtn']) $(`#${id}`).addEventListener('click', openMenu);
$('#retryBtn').addEventListener('click', () => requestRun());
$('#shareBtn').addEventListener('click', shareRun);
$('#openGistBtn').addEventListener('click', () => window.open(GIST_URL, '_blank', 'noopener,noreferrer'));
$('#inspectBtn').addEventListener('click', () => { closeResults(); $('#resultsBtn').classList.remove('hidden'); canvas.focus(); });
$('#resultsBtn').addEventListener('click', openResults);
for (const id of ['helpBtn', 'gameHelpBtn']) $(`#${id}`).addEventListener('click', showHelp);
$('#closeHelpBtn').addEventListener('click', () => $('#helpDialog').close());
$('#helpDialog').addEventListener('close', resumeClock);
$('#revealModeBtn').addEventListener('click', () => setInputMode('reveal'));
$('#flagModeBtn').addEventListener('click', () => setInputMode('flag'));
$('#originBtn').addEventListener('click', () => recenter({ x: 0, y: 0 }));
$('#frontierBtn').addEventListener('click', () => recenter(lastCleared));
$('#zoomInBtn').addEventListener('click', () => zoomAt(camera.zoom * 1.2));
$('#zoomOutBtn').addEventListener('click', () => zoomAt(camera.zoom / 1.2));
$('#settingsBtn').addEventListener('click', () => $('#boardSettings').classList.toggle('hidden'));
for (const [id, key] of [['gridToggle', 'grid'], ['soundToggle', 'sound']]) {
  $(`#${id}`).checked = settings[key];
  $(`#${id}`).addEventListener('change', e => { settings[key] = e.target.checked; saveJson(SETTINGS_KEY, settings); markDirty(); });
}
$('#refreshLeaderboard').addEventListener('click', () => loadLeaderboard(true));
for (const id of ['metricFilter', 'periodFilter', 'bestOnly']) $(`#${id}`).addEventListener('change', renderLeaderboard);
$('#playerFilter').addEventListener('input', renderLeaderboard);
window.addEventListener('resize', resize, { passive: true });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { clock?.pause(); persistRun(); }
  else resumeClock();
});
window.addEventListener('pagehide', () => { clock?.pause(); persistRun(); });
window.addEventListener('beforeunload', persistRun);
document.addEventListener('keydown', e => {
  if ($('#helpDialog').open || $('#replaceDialog').open) return;
  if (!deathPanel.classList.contains('hidden') && e.key === 'Tab') {
    const focusable = [...deathPanel.querySelectorAll('button:not(:disabled), textarea')].filter(el => el.getClientRects().length);
    const first = focusable[0], last = focusable.at(-1);
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  if (e.key === 'Escape' && screen !== 'menu') { e.preventDefault(); openMenu(); }
});
setInterval(() => {
  if (screen === 'game') updateHud();
  if (screen === 'menu') refreshDaily();
}, 1000);

const linkedSeed = parseSeed(new URL(location.href).searchParams.get('seed'));
if (linkedSeed !== null) {
  $('#seedInput').value = linkedSeed; $('.seedDetails').open = true;
  $('#seedError').textContent = 'A shared field is ready. Press Explore to start.';
}
refreshContinue(); refreshDaily(); drawPreview();
