// Active play time is independent of autosaves and the last recorded input.
// The next input includes any unsaved active time, keeping replay totals exact.
export class PlayClock {
  constructor(elapsed = 0, now = () => performance.now()) {
    this.now = now;
    this.total = Math.max(0, Number(elapsed) || 0);
    this.since = null;
  }
  resume() { if (this.since === null) this.since = this.now(); }
  pause() {
    this.total = this.elapsed();
    this.since = null;
  }
  elapsed() {
    return this.total + (this.since === null ? 0 : Math.max(0, this.now() - this.since));
  }
}

export function dailyWorld(date = new Date()) {
  const day = date.toISOString().slice(0, 10);
  let seed = 2166136261;
  for (const c of `infinite-minesweeper:${day}`) seed = Math.imul(seed ^ c.charCodeAt(0), 16777619) >>> 0;
  return { seed, day };
}

export function parseSeed(value) {
  const text = String(value).trim();
  if (!/^\d{1,10}$/.test(text)) return null;
  const seed = Number(text);
  return Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff ? seed : null;
}

export function sanitizeCamera(value) {
  const valid = n => Number.isFinite(n) && Math.abs(n) <= 100000;
  return {
    x: valid(value?.x) ? value.x : 0,
    y: valid(value?.y) ? value.y : 0,
    zoom: Number.isFinite(value?.zoom) ? Math.max(18, Math.min(64, value.zoom)) : 36
  };
}
