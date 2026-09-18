export const GAME_VERSION = 1;
export const CHUNK_SIZE = 16;
export const SAFE_RADIUS = 2;
export const MAX_FLOOD_PER_ACTION = 6000;
export const MAX_SHARE_ACTIONS = 50000;
export const MAX_SHARE_CODE_LENGTH = 240000;
const MINE_THRESHOLD = Math.floor(0.17 * 0x100000000);

const DIRS = [
  [-1,-1],[0,-1],[1,-1],[-1,0],[1,0],[-1,1],[0,1],[1,1]
];

function mix32(v) {
  v = Math.imul(v ^ (v >>> 16), 0x7feb352d);
  v = Math.imul(v ^ (v >>> 15), 0x846ca68b);
  return (v ^ (v >>> 16)) >>> 0;
}

export function hashCell(x, y, seed) {
  let h = mix32(seed >>> 0);
  h ^= mix32((x | 0) ^ 0x9e3779b9);
  h = mix32(h + Math.imul((y | 0) ^ 0x85ebca6b, 0xc2b2ae35));
  return h >>> 0;
}

export function isMine(x, y, seed) {
  if (Math.max(Math.abs(x), Math.abs(y)) <= SAFE_RADIUS) return false;
  return hashCell(x, y, seed) < MINE_THRESHOLD;
}

export function neighborCount(x, y, seed) {
  let count = 0;
  for (const [dx, dy] of DIRS) count += isMine(x + dx, y + dy, seed) ? 1 : 0;
  return count;
}

function floorDiv(n, d) { return Math.floor(n / d); }
function mod(n, d) { return ((n % d) + d) % d; }
function chunkKey(cx, cy) { return `${cx},${cy}`; }

function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function base64ToBytes(value) {
  const s = atob(value);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function bitGet(bytes, index) {
  return !!(bytes[index >>> 3] & (1 << (index & 7)));
}
function bitSet(bytes, index, value) {
  const mask = 1 << (index & 7);
  const i = index >>> 3;
  if (value) bytes[i] |= mask;
  else bytes[i] &= ~mask;
}

export class WorldState {
  constructor(seed, serialized = null) {
    this.seed = seed >>> 0;
    this.chunks = new Map();
    this.revealedCount = 0;
    this.flagCount = 0;
    this.maxDistance = 0;
    this.floodCells = 0;
    if (serialized) this.load(serialized);
  }

  _locate(x, y, create = false) {
    const cx = floorDiv(x, CHUNK_SIZE);
    const cy = floorDiv(y, CHUNK_SIZE);
    const key = chunkKey(cx, cy);
    let bytes = this.chunks.get(key);
    if (!bytes && create) {
      bytes = new Uint8Array(64); // 32 bytes revealed + 32 bytes flagged
      this.chunks.set(key, bytes);
    }
    const lx = mod(x, CHUNK_SIZE);
    const ly = mod(y, CHUNK_SIZE);
    return { bytes, index: ly * CHUNK_SIZE + lx, cx, cy, key };
  }

  isRevealed(x, y) {
    const { bytes, index } = this._locate(x, y, false);
    return bytes ? bitGet(bytes.subarray(0, 32), index) : false;
  }

  isFlagged(x, y) {
    const { bytes, index } = this._locate(x, y, false);
    return bytes ? bitGet(bytes.subarray(32, 64), index) : false;
  }

  setRevealed(x, y, value = true) {
    const { bytes, index } = this._locate(x, y, value);
    if (!bytes) return false;
    const region = bytes.subarray(0, 32);
    const before = bitGet(region, index);
    if (before === value) return false;
    bitSet(region, index, value);
    this.revealedCount += value ? 1 : -1;
    if (value) {
      if (this.isFlagged(x, y)) this.setFlagged(x, y, false);
      this.maxDistance = Math.max(this.maxDistance, Math.max(Math.abs(x), Math.abs(y)));
    }
    return true;
  }

  setFlagged(x, y, value) {
    if (this.isRevealed(x, y)) return false;
    const { bytes, index } = this._locate(x, y, value);
    if (!bytes) return false;
    const region = bytes.subarray(32, 64);
    const before = bitGet(region, index);
    if (before === value) return false;
    bitSet(region, index, value);
    this.flagCount += value ? 1 : -1;
    return true;
  }

  toggleFlag(x, y) {
    if (!this.canInteract(x, y) || this.isRevealed(x, y)) return false;
    return this.setFlagged(x, y, !this.isFlagged(x, y));
  }

  canInteract(x, y) {
    if (Math.max(Math.abs(x), Math.abs(y)) <= SAFE_RADIUS) return true;
    if (this.isRevealed(x, y)) return true;
    for (const [dx, dy] of DIRS) {
      if (this.isRevealed(x + dx, y + dy)) return true;
    }
    return false;
  }

  reveal(x, y) {
    if (!this.canInteract(x, y) || this.isFlagged(x, y) || this.isRevealed(x, y)) {
      return { accepted: false, mine: false, cells: [] };
    }
    if (isMine(x, y, this.seed)) {
      return { accepted: true, mine: true, cells: [{ x, y, n: -1 }] };
    }

    const cells = [];
    const queue = [[x, y]];
    const queued = new Set([`${x},${y}`]);
    let qi = 0;
    while (qi < queue.length && cells.length < MAX_FLOOD_PER_ACTION) {
      const [cx, cy] = queue[qi++];
      if (this.isRevealed(cx, cy) || this.isFlagged(cx, cy) || isMine(cx, cy, this.seed)) continue;
      this.setRevealed(cx, cy, true);
      const n = neighborCount(cx, cy, this.seed);
      cells.push({ x: cx, y: cy, n });
      if (n === 0) {
        for (const [dx, dy] of DIRS) {
          const nx = cx + dx, ny = cy + dy;
          const k = `${nx},${ny}`;
          if (!queued.has(k) && !this.isRevealed(nx, ny) && !this.isFlagged(nx, ny)) {
            queued.add(k);
            queue.push([nx, ny]);
          }
        }
      }
    }
    if (cells.length > 1) this.floodCells += cells.length - 1;
    return { accepted: cells.length > 0, mine: false, cells };
  }

  chord(x, y) {
    if (!this.isRevealed(x, y)) {
      return { accepted: false, mine: false, opened: 0, hit: null };
    }

    const requiredFlags = neighborCount(x, y, this.seed);
    if (requiredFlags === 0) {
      return { accepted: false, mine: false, opened: 0, hit: null };
    }

    let adjacentFlags = 0;
    const targets = [];
    for (const [dx, dy] of DIRS) {
      const nx = x + dx, ny = y + dy;
      if (this.isFlagged(nx, ny)) adjacentFlags++;
      else if (!this.isRevealed(nx, ny)) targets.push([nx, ny]);
    }

    if (adjacentFlags !== requiredFlags || targets.length === 0) {
      return { accepted: false, mine: false, opened: 0, hit: null };
    }

    let opened = 0;
    for (const [nx, ny] of targets) {
      // An earlier zero-cell flood can reveal a later target in this same chord.
      if (this.isRevealed(nx, ny) || this.isFlagged(nx, ny)) continue;
      const result = this.reveal(nx, ny);
      if (!result.accepted) continue;
      if (result.mine) {
        return { accepted: true, mine: true, opened, hit: { x: nx, y: ny } };
      }
      opened += result.cells.length;
    }

    return { accepted: opened > 0, mine: false, opened, hit: null };
  }

  serialize() {
    const chunks = [];
    for (const [key, bytes] of this.chunks) {
      let nonzero = false;
      for (const b of bytes) if (b) { nonzero = true; break; }
      if (!nonzero) continue;
      const [cx, cy] = key.split(',').map(Number);
      chunks.push([cx, cy, bytesToBase64(bytes)]);
    }
    return {
      seed: this.seed,
      chunks,
      revealedCount: this.revealedCount,
      flagCount: this.flagCount,
      maxDistance: this.maxDistance,
      floodCells: this.floodCells
    };
  }

  load(data) {
    this.chunks.clear();
    this.revealedCount = 0;
    this.flagCount = 0;
    this.maxDistance = Number(data.maxDistance) || 0;
    this.floodCells = Number(data.floodCells) || 0;
    for (const item of data.chunks || []) {
      if (!Array.isArray(item) || item.length !== 3) continue;
      const [cx, cy, b64] = item;
      const bytes = base64ToBytes(b64);
      if (bytes.length !== 64) continue;
      this.chunks.set(chunkKey(cx, cy), bytes);
      for (let i = 0; i < 256; i++) {
        if (bitGet(bytes.subarray(0, 32), i)) this.revealedCount++;
        if (bitGet(bytes.subarray(32, 64), i)) this.flagCount++;
      }
    }
  }

  finalFlagStats() {
    let correct = 0, wrong = 0;
    for (const [key, bytes] of this.chunks) {
      const [cx, cy] = key.split(',').map(Number);
      const flags = bytes.subarray(32, 64);
      for (let i = 0; i < 256; i++) {
        if (!bitGet(flags, i)) continue;
        const x = cx * CHUNK_SIZE + (i % CHUNK_SIZE);
        const y = cy * CHUNK_SIZE + Math.floor(i / CHUNK_SIZE);
        if (isMine(x, y, this.seed)) correct++; else wrong++;
      }
    }
    return { correct, wrong };
  }
}

export function computeScore(world, elapsedMs) {
  const base = world.revealedCount * 10;
  const exploration = world.maxDistance * 18;
  const floodBonus = Math.floor(world.floodCells * 0.6);
  const endurance = Math.min(5000, Math.floor(elapsedMs / 15000));
  return Math.max(0, base + exploration + floodBonus + endurance);
}

export function makeResult(world, elapsedMs, actionsCount) {
  const flags = world.finalFlagStats();
  return {
    score: computeScore(world, elapsedMs),
    elapsedMs: Math.max(0, Math.floor(elapsedMs)),
    revealed: world.revealedCount,
    flags: world.flagCount,
    correctFlags: flags.correct,
    wrongFlags: flags.wrong,
    flagAccuracy: world.flagCount ? Math.round((flags.correct / world.flagCount) * 1000) / 10 : 0,
    maxDistance: world.maxDistance,
    chunks: world.chunks.size,
    floodCells: world.floodCells,
    actions: actionsCount
  };
}

function zigzagEncode(n) { return ((n << 1) ^ (n >> 31)) >>> 0; }
function zigzagDecode(n) { return (n >>> 1) ^ -(n & 1); }
function writeVarint(out, value) {
  value >>>= 0;
  while (value >= 0x80) { out.push((value & 0x7f) | 0x80); value >>>= 7; }
  out.push(value);
}
function readVarint(bytes, state) {
  let result = 0, shift = 0;
  while (state.i < bytes.length && shift <= 28) {
    const b = bytes[state.i++];
    result |= (b & 0x7f) << shift;
    if (!(b & 0x80)) return result >>> 0;
    shift += 7;
  }
  throw new Error('Invalid varint');
}

export function encodeActions(actions) {
  const out = [];
  let px = 0, py = 0;
  for (const a of actions) {
    out.push(a.t === 'f' ? 1 : a.t === 'c' ? 2 : 0);
    writeVarint(out, zigzagEncode((a.x | 0) - px));
    writeVarint(out, zigzagEncode((a.y | 0) - py));
    writeVarint(out, Math.max(0, Math.min(0xffffffff, Math.round(a.dt))));
    px = a.x | 0; py = a.y | 0;
  }
  return bytesToBase64(new Uint8Array(out)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function decodeActions(encoded, maxActions = MAX_SHARE_ACTIONS) {
  const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const bytes = base64ToBytes(normalized + '='.repeat((4 - normalized.length % 4) % 4));
  const actions = [];
  const st = { i: 0 };
  let x = 0, y = 0;
  while (st.i < bytes.length) {
    if (actions.length >= maxActions) throw new Error('Too many actions');
    const type = bytes[st.i++];
    if (type > 2) throw new Error('Invalid action type');
    x += zigzagDecode(readVarint(bytes, st));
    y += zigzagDecode(readVarint(bytes, st));
    const dt = readVarint(bytes, st);
    actions.push({ t: type === 1 ? 'f' : type === 2 ? 'c' : 'r', x, y, dt });
  }
  return actions;
}

function textToBase64Url(text) {
  const bytes = new TextEncoder().encode(text);
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function base64UrlToText(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  return new TextDecoder().decode(base64ToBytes(normalized + '='.repeat((4 - normalized.length % 4) % 4)));
}
function hex(bytes) { return [...bytes].map(b => b.toString(16).padStart(2, '0')).join(''); }
async function sha256(value) { return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))); }

export async function createShareCode(seed, actions, result) {
  const encodedActions = encodeActions(actions);
  const core = {
    v: GAME_VERSION,
    seed: seed >>> 0,
    a: encodedActions,
    s: result.score,
    e: result.elapsedMs,
    r: result.revealed,
    d: result.maxDistance
  };
  const sig = (await sha256(`infinite-minesweeper|${JSON.stringify(core)}`)).slice(0, 24);
  return `IM1.${textToBase64Url(JSON.stringify({ ...core, h: sig }))}`;
}

export async function verifyShareCode(code) {
  if (typeof code !== 'string' || code.length > MAX_SHARE_CODE_LENGTH || !code.startsWith('IM1.')) {
    return { valid: false, reason: 'format' };
  }
  try {
    const payload = JSON.parse(base64UrlToText(code.slice(4)));
    if (payload.v !== GAME_VERSION || !Number.isInteger(payload.seed)) return { valid: false, reason: 'version' };
    const core = { v: payload.v, seed: payload.seed >>> 0, a: payload.a, s: payload.s, e: payload.e, r: payload.r, d: payload.d };
    const expectedSig = (await sha256(`infinite-minesweeper|${JSON.stringify(core)}`)).slice(0, 24);
    if (expectedSig !== payload.h) return { valid: false, reason: 'integrity' };
    const actions = decodeActions(payload.a);
    if (!actions.length) return { valid: false, reason: 'empty' };

    const world = new WorldState(payload.seed);
    let elapsed = 0;
    let dead = false;
    let ultraFast = 0;
    let revealActions = 0;
    for (let i = 0; i < actions.length; i++) {
      const a = actions[i];
      if (dead) return { valid: false, reason: 'post-death-actions' };
      if (!Number.isSafeInteger(a.x) || !Number.isSafeInteger(a.y) || Math.abs(a.x) > 100000 || Math.abs(a.y) > 100000) return { valid: false, reason: 'coordinates' };
      elapsed += a.dt;
      if (a.t === 'r' || a.t === 'c') {
        revealActions++;
        if (a.dt < 25) ultraFast++; else ultraFast = 0;
        if (ultraFast > 14) return { valid: false, reason: 'machine-speed-input' };

        if (a.t === 'c') {
          if (!world.isRevealed(a.x, a.y)) return { valid: false, reason: 'invalid-chord-center' };
          const cr = world.chord(a.x, a.y);
          if (!cr.accepted) return { valid: false, reason: 'invalid-chord' };
          if (cr.mine) dead = true;
        } else {
          if (!world.canInteract(a.x, a.y)) return { valid: false, reason: 'frontier' };
          const rr = world.reveal(a.x, a.y);
          if (!rr.accepted) return { valid: false, reason: 'invalid-reveal' };
          if (rr.mine) dead = true;
        }
      } else {
        if (!world.canInteract(a.x, a.y) || world.isRevealed(a.x, a.y)) return { valid: false, reason: 'invalid-flag' };
        world.toggleFlag(a.x, a.y);
      }
      if (world.revealedCount > 750000 || world.chunks.size > 15000) return { valid: false, reason: 'limits' };
    }
    if (!dead || !['r', 'c'].includes(actions[actions.length - 1].t)) return { valid: false, reason: 'not-ended' };
    if (Math.abs(elapsed - payload.e) > 150) return { valid: false, reason: 'time-mismatch' };
    if (revealActions > 8 && elapsed < revealActions * 30) return { valid: false, reason: 'impossible-rate' };

    const result = makeResult(world, elapsed, actions.length);
    if (result.score !== payload.s || result.revealed !== payload.r || result.maxDistance !== payload.d) {
      return { valid: false, reason: 'result-mismatch' };
    }
    return { valid: true, result, seed: payload.seed >>> 0, actions: actions.length };
  } catch (error) {
    return { valid: false, reason: 'decode' };
  }
}

export function randomSeed() {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return values[0] >>> 0;
}
