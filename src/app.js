import {
  WorldState, isMine, neighborCount, makeResult, encodeActions, decodeActions,
  createShareCode, verifyShareCode, randomSeed
} from './core.js';

const GIST_ID = '02990dee7192a0419aeb0b208b54b02d';
const GIST_URL = `https://gist.github.com/MrHakan/${GIST_ID}`;
const COMMENTS_API = `https://api.github.com/gists/${GIST_ID}/comments`;
const SAVE_KEY = 'infinite-minesweeper.active.v1';
const HISTORY_KEY = 'infinite-minesweeper.history.v1';
const SETTINGS_KEY = 'infinite-minesweeper.settings.v1';
const LB_CACHE_KEY = 'infinite-minesweeper.leaderboard-cache.v1';

const $ = (s) => document.querySelector(s);
const canvas = $('#game');
const ctx = canvas.getContext('2d', { alpha: false });
const menu = $('#menu');
const gameHud = $('#gameHud');
const deathPanel = $('#deathPanel');
const statsPanel = $('#statsPanel');
const continueBtn = $('#continueBtn');
const toast = $('#toast');

let run = null;
let world = null;
let actions = [];
let camera = { x: 0, y: 0, zoom: 34 };
let dirty = true;
let raf = 0;
let saveTimer = 0;
let pointer = null;
let endedResult = null;
let endedCode = '';
let settings = loadJson(SETTINGS_KEY, { grid: true, sound: false });

function loadJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function saveJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch (error) { console.warn('Storage quota exceeded', error); return false; }
}
function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(showToast.t);
  showToast.t = setTimeout(() => toast.classList.remove('show'), 2200);
}

function newRun() {
  const now = Date.now();
  run = { seed: randomSeed(), startedAt: now, elapsedBefore: 0, lastActionAt: performance.now(), dead: false };
  world = new WorldState(run.seed);
  actions = [];
  camera = { x: 0, y: 0, zoom: 34 };
  world.reveal(0, 0);
  actions.push({ t: 'r', x: 0, y: 0, dt: 0 });
  run.lastActionAt = performance.now();
  openGame();
  queueSave(true);
}

function restoreRun() {
  const data = loadJson(SAVE_KEY, null);
  if (!data || data.dead || !data.world || (!Array.isArray(data.actions) && typeof data.actionLog !== 'string')) return false;
  try {
    run = {
      seed: data.seed >>> 0,
      startedAt: Date.now(),
      elapsedBefore: Number(data.elapsedMs) || 0,
      lastActionAt: performance.now(),
      dead: false
    };
    world = new WorldState(run.seed, data.world);
    actions = typeof data.actionLog === 'string'
      ? decodeActions(data.actionLog, Infinity)
      : data.actions.filter(a => a && (a.t === 'r' || a.t === 'f' || a.t === 'c')); // backward-compatible v1 saves
    camera = data.camera || { x: 0, y: 0, zoom: 34 };
    openGame();
    return true;
  } catch (error) {
    console.warn('Could not restore save', error);
    localStorage.removeItem(SAVE_KEY);
    return false;
  }
}

function elapsedMs() {
  if (!run) return 0;
  return run.elapsedBefore + (run.dead ? 0 : performance.now() - run.lastActionAt);
}

function queueSave(immediate = false) {
  clearTimeout(saveTimer);
  if (immediate) return persistRun();
  saveTimer = setTimeout(persistRun, 1200);
}
function persistRun() {
  clearTimeout(saveTimer);
  saveTimer = 0;
  if (!run || run.dead || !world) return;
  const now = performance.now();
  const activeElapsed = run.elapsedBefore + (now - run.lastActionAt);
  run.elapsedBefore = activeElapsed;
  run.lastActionAt = now;
  saveJson(SAVE_KEY, {
    seed: run.seed,
    elapsedMs: activeElapsed,
    dead: false,
    camera,
    world: world.serialize(),
    actionLog: encodeActions(actions)
  });
}

function openGame() {
  menu.classList.add('hidden');
  statsPanel.classList.add('hidden');
  deathPanel.classList.add('hidden');
  gameHud.classList.remove('hidden');
  canvas.classList.remove('hidden');
  resize();
  markDirty();
}
function openMenu() {
  if (run && !run.dead) persistRun();
  menu.classList.remove('hidden');
  gameHud.classList.add('hidden');
  canvas.classList.add('hidden');
  deathPanel.classList.add('hidden');
  statsPanel.classList.add('hidden');
  refreshContinue();
}
function refreshContinue() {
  const data = loadJson(SAVE_KEY, null);
  continueBtn.disabled = !(data && !data.dead && data.world);
  continueBtn.textContent = continueBtn.disabled ? 'No active run' : 'Continue run';
}

function recordAction(t, x, y) {
  const now = performance.now();
  const dt = Math.max(0, Math.round(now - run.lastActionAt));
  run.elapsedBefore += dt;
  run.lastActionAt = now;
  actions.push({ t, x, y, dt });
}

function revealCell(x, y) {
  if (!run || run.dead) return;
  if (!world.canInteract(x, y)) { showToast('Expand from the frontier'); return; }

  // Classic Minesweeper chording: clicking an already-open number opens all
  // remaining adjacent cells when the surrounding flag count matches it.
  if (world.isRevealed(x, y)) {
    const chord = world.chord(x, y);
    if (!chord.accepted) return;
    recordAction('c', x, y);
    if (chord.mine) endRun(chord.hit.x, chord.hit.y);
    else {
      queueSave();
      updateHud();
      markDirty();
    }
    return;
  }

  const result = world.reveal(x, y);
  if (!result.accepted) return;
  recordAction('r', x, y);
  if (result.mine) endRun(x, y);
  else {
    queueSave();
    updateHud();
    markDirty();
  }
}
function flagCell(x, y) {
  if (!run || run.dead || !world.canInteract(x, y) || world.isRevealed(x, y)) return;
  world.toggleFlag(x, y);
  recordAction('f', x, y);
  queueSave();
  updateHud();
  markDirty();
}

async function endRun(hitX, hitY) {
  run.dead = true;
  localStorage.removeItem(SAVE_KEY);
  endedResult = makeResult(world, run.elapsedBefore, actions.length);
  const history = loadJson(HISTORY_KEY, []);
  history.unshift({ ...endedResult, seed: run.seed, at: new Date().toISOString() });
  saveJson(HISTORY_KEY, history.slice(0, 100));
  endedCode = await createShareCode(run.seed, actions, endedResult);
  renderDeath(hitX, hitY);
  markDirty();
}

function renderDeath(hitX, hitY) {
  const r = endedResult;
  $('#deathScore').textContent = r.score.toLocaleString();
  $('#deathGrid').innerHTML = [
    ['Safe cells', r.revealed.toLocaleString()],
    ['Survival', formatTime(r.elapsedMs)],
    ['Max radius', `${r.maxDistance} cells`],
    ['Chunks touched', r.chunks.toLocaleString()],
    ['Flags', r.flags.toLocaleString()],
    ['Correct flags', r.correctFlags.toLocaleString()],
    ['Wrong flags', r.wrongFlags.toLocaleString()],
    ['Flag accuracy', `${r.flagAccuracy}%`],
    ['Flood-cleared', r.floodCells.toLocaleString()],
    ['Inputs', r.actions.toLocaleString()],
    ['Final mine', `${hitX}, ${hitY}`]
  ].map(([k,v]) => `<div><span>${k}</span><strong>${v}</strong></div>`).join('');
  deathPanel.classList.remove('hidden');
  gameHud.classList.add('hidden');
}

async function shareRun() {
  if (!endedCode) return;
  const win = window.open(GIST_URL, '_blank', 'noopener,noreferrer');
  try {
    await navigator.clipboard.writeText(endedCode);
    showToast('Share code copied — paste it as a Gist comment');
  } catch {
    $('#shareCode').value = endedCode;
    $('#shareCodeWrap').classList.remove('hidden');
    $('#shareCode').select();
    showToast('Copy the code, then paste it as a Gist comment');
  }
  if (!win) showToast('Code copied. Open the leaderboard Gist to post it.');
}

function formatTime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}` : `${m}:${String(sec).padStart(2,'0')}`;
}

function updateHud() {
  if (!world || !run) return;
  const r = makeResult(world, elapsedMs(), actions.length);
  $('#hudScore').textContent = r.score.toLocaleString();
  $('#hudCells').textContent = r.revealed.toLocaleString();
  $('#hudFlags').textContent = r.flags.toLocaleString();
  $('#hudDistance').textContent = r.maxDistance.toLocaleString();
}

function resize() {
  if (canvas.classList.contains('hidden')) return;
  const dpr = Math.min(2, devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  markDirty();
}
function markDirty() {
  dirty = true;
  if (!raf) raf = requestAnimationFrame(render);
}

function worldToScreen(x, y) {
  const rect = canvas.getBoundingClientRect();
  return { x: rect.width / 2 + (x - camera.x) * camera.zoom, y: rect.height / 2 + (y - camera.y) * camera.zoom };
}
function screenToWorld(px, py) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: Math.floor(camera.x + (px - rect.width / 2) / camera.zoom + 0.5),
    y: Math.floor(camera.y + (py - rect.height / 2) / camera.zoom + 0.5)
  };
}

function render() {
  raf = 0;
  if (!dirty || !world || canvas.classList.contains('hidden')) return;
  dirty = false;
  const rect = canvas.getBoundingClientRect();
  ctx.fillStyle = '#0a0d12';
  ctx.fillRect(0, 0, rect.width, rect.height);

  const halfX = Math.ceil(rect.width / camera.zoom / 2) + 2;
  const halfY = Math.ceil(rect.height / camera.zoom / 2) + 2;
  const minX = Math.floor(camera.x) - halfX;
  const maxX = Math.floor(camera.x) + halfX;
  const minY = Math.floor(camera.y) - halfY;
  const maxY = Math.floor(camera.y) + halfY;

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) drawCell(x, y);
  }
  updateHud();
}

function drawCell(x, y) {
  const p = worldToScreen(x, y);
  const z = camera.zoom;
  const left = p.x - z / 2, top = p.y - z / 2;
  const revealed = world.isRevealed(x, y);
  const flagged = world.isFlagged(x, y);
  const frontier = world.canInteract(x, y);

  if (revealed) {
    ctx.fillStyle = '#171d25';
  } else if (run?.dead && isMine(x, y, world.seed)) {
    ctx.fillStyle = '#3b1820';
  } else if (frontier) {
    ctx.fillStyle = '#242c37';
  } else {
    ctx.fillStyle = '#11161d';
  }
  ctx.fillRect(left + 1, top + 1, z - 2, z - 2);

  if (settings.grid && z >= 16) {
    ctx.strokeStyle = 'rgba(255,255,255,.035)';
    ctx.strokeRect(left + .5, top + .5, z - 1, z - 1);
  }

  if (flagged) {
    ctx.fillStyle = '#ffcc66';
    ctx.font = `${Math.max(11, z * .5)}px system-ui`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('⚑', p.x, p.y + 1);
  } else if (revealed) {
    const n = neighborCount(x, y, world.seed);
    if (n) {
      const colors = ['','#66b3ff','#7ee787','#f2cc60','#ff7b72','#d2a8ff','#56d4dd','#ffa657','#f0f6fc'];
      ctx.fillStyle = colors[n];
      ctx.font = `700 ${Math.max(10, z * .46)}px ui-monospace, monospace`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(n), p.x, p.y + 1);
    }
  } else if (run?.dead && isMine(x, y, world.seed)) {
    ctx.fillStyle = '#ff6b6b';
    ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(2, z * .15), 0, Math.PI * 2); ctx.fill();
  } else if (!frontier && z >= 24) {
    ctx.fillStyle = 'rgba(255,255,255,.08)';
    ctx.font = `${z * .35}px system-ui`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('·', p.x, p.y);
  }
}

canvas.addEventListener('contextmenu', e => e.preventDefault());
canvas.addEventListener('pointerdown', e => {
  if (!run || run.dead) return;
  canvas.setPointerCapture(e.pointerId);
  pointer = { id: e.pointerId, sx: e.clientX, sy: e.clientY, cx: camera.x, cy: camera.y, moved: false, time: performance.now(), button: e.button };
});
canvas.addEventListener('pointermove', e => {
  if (!pointer || e.pointerId !== pointer.id) return;
  const dx = e.clientX - pointer.sx, dy = e.clientY - pointer.sy;
  if (Math.hypot(dx, dy) > 5) pointer.moved = true;
  if (pointer.moved) {
    camera.x = pointer.cx - dx / camera.zoom;
    camera.y = pointer.cy - dy / camera.zoom;
    markDirty();
  }
});
canvas.addEventListener('pointerup', e => {
  if (!pointer || e.pointerId !== pointer.id) return;
  const p = pointer; pointer = null;
  const w = screenToWorld(e.clientX, e.clientY);
  const held = performance.now() - p.time;
  if (!p.moved) {
    if (p.button === 2 || held > 520) flagCell(w.x, w.y);
    else revealCell(w.x, w.y);
  } else queueSave();
});
canvas.addEventListener('pointercancel', () => { pointer = null; });
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const before = screenToWorld(e.clientX, e.clientY);
  const factor = Math.exp(-e.deltaY * 0.0012);
  camera.zoom = Math.max(16, Math.min(60, camera.zoom * factor));
  const after = screenToWorld(e.clientX, e.clientY);
  camera.x += before.x - after.x;
  camera.y += before.y - after.y;
  markDirty(); queueSave();
}, { passive: false });

async function openStats() {
  menu.classList.add('hidden');
  statsPanel.classList.remove('hidden');
  gameHud.classList.add('hidden');
  canvas.classList.add('hidden');
  renderLocalHistory();
  await loadLeaderboard();
}

function renderLocalHistory() {
  const history = loadJson(HISTORY_KEY, []);
  const box = $('#localHistory');
  if (!history.length) { box.innerHTML = '<div class="empty">No finished local runs yet.</div>'; return; }
  box.innerHTML = history.slice(0, 12).map((r, i) => `<div class="historyRow"><span>#${i+1}</span><strong>${Number(r.score).toLocaleString()}</strong><span>${Number(r.revealed).toLocaleString()} cells</span><span>${formatTime(Number(r.elapsedMs)||0)}</span></div>`).join('');
}

async function fetchAllComments() {
  const all = [];
  for (let page = 1; page <= 5; page++) {
    const res = await fetch(`${COMMENTS_API}?per_page=100&page=${page}`, { headers: { 'Accept': 'application/vnd.github+json' } });
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
      if (i % 12 === 0) status.textContent = `Verifying ${i + 1}/${comments.length} comments…`;
    }
    const trimmed = Object.fromEntries(Object.entries(cache).slice(-400));
    saveJson(LB_CACHE_KEY, trimmed);
    window.__leaderboardEntries = entries;
    renderLeaderboard();
    status.textContent = `${entries.length} replay-verified run${entries.length === 1 ? '' : 's'} from ${comments.length} comments.`;
  } catch (error) {
    console.warn(error);
    status.textContent = 'Could not load Gist comments. GitHub may be rate-limiting this browser.';
    $('#leaderboardBody').innerHTML = '<tr><td colspan="6" class="empty">Leaderboard temporarily unavailable.</td></tr>';
  }
}

function renderLeaderboard() {
  let entries = [...(window.__leaderboardEntries || [])];
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

$('#newBtn').addEventListener('click', newRun);
continueBtn.addEventListener('click', () => { if (!restoreRun()) newRun(); });
$('#statsBtn').addEventListener('click', openStats);
$('#menuBtn').addEventListener('click', openMenu);
$('#statsBackBtn').addEventListener('click', openMenu);
$('#deathMenuBtn').addEventListener('click', openMenu);
$('#retryBtn').addEventListener('click', newRun);
$('#shareBtn').addEventListener('click', shareRun);
$('#openGistBtn').addEventListener('click', () => window.open(GIST_URL, '_blank', 'noopener,noreferrer'));
$('#refreshLeaderboard').addEventListener('click', () => loadLeaderboard(true));
for (const id of ['metricFilter','periodFilter','bestOnly']) $(id.startsWith('#') ? id : `#${id}`).addEventListener('change', renderLeaderboard);
$('#playerFilter').addEventListener('input', renderLeaderboard);
$('#gridToggle').checked = settings.grid;
$('#gridToggle').addEventListener('change', e => { settings.grid = e.target.checked; saveJson(SETTINGS_KEY, settings); markDirty(); });

window.addEventListener('resize', resize, { passive: true });
document.addEventListener('visibilitychange', () => { if (document.hidden && run && !run.dead) persistRun(); });
window.addEventListener('beforeunload', () => { if (run && !run.dead) persistRun(); });
setInterval(() => { if (run && !run.dead && !canvas.classList.contains('hidden')) { updateHud(); } }, 1000);

// Keep gameplay state module-scoped: no debug state is attached to window.
refreshContinue();
