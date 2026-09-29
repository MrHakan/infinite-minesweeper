import test from 'node:test';
import assert from 'node:assert/strict';
import { PlayClock, dailyWorld, parseSeed, sanitizeCamera } from '../src/session.js';
import { WorldState, isMine, makeResult, encodeActions, decodeActions, createShareCode, verifyShareCode } from '../src/core.js';

test('clock excludes menus, hidden tabs and repeated pauses', () => {
  let now = 0;
  const clock = new PlayClock(0, () => now);
  clock.resume(); now = 1432; assert.equal(clock.elapsed(), 1432);
  clock.pause(); now = 60000; clock.pause(); assert.equal(clock.elapsed(), 1432);
  clock.resume(); clock.resume(); now += 500; assert.equal(clock.elapsed(), 1932);
});

test('autosaves, pauses and restore preserve replay timing through death', async () => {
  let now = 0;
  const clock = new PlayClock(0, () => now);
  const seed = 12094, world = new WorldState(seed);
  world.reveal(0, 0);
  const actions = [{ t: 'r', x: 0, y: 0, dt: 0 }];
  clock.resume(); now = 2500;
  // Autosaving must not move the last input timestamp.
  const firstSave = { elapsed: Math.floor(clock.elapsed()), world: world.serialize(), actions: encodeActions(actions) };
  assert.equal(firstSave.elapsed, 2500);
  now = 3200; clock.pause(); now = 80000; clock.resume(); now += 800;
  const saved = { ...firstSave, elapsed: Math.floor(clock.elapsed()) };
  const restored = new PlayClock(saved.elapsed, () => now);
  const restoredWorld = new WorldState(seed, saved.world);
  const restoredActions = decodeActions(saved.actions);
  now = 200000; restored.resume(); now += 700;
  let hit;
  for (let y = -20; y <= 20 && !hit; y++) for (let x = -20; x <= 20 && !hit; x++) {
    if (restoredWorld.canInteract(x, y) && isMine(x, y, seed)) hit = { x, y };
  }
  assert.ok(hit);
  assert.equal(restoredWorld.reveal(hit.x, hit.y).mine, true);
  restoredActions.push({ t: 'r', ...hit, dt: Math.floor(restored.elapsed()) });
  const result = makeResult(restoredWorld, 4700, restoredActions.length);
  const code = await createShareCode(seed, restoredActions, result);
  const verified = await verifyShareCode(code);
  assert.equal(verified.valid, true);
  assert.equal(verified.result.elapsedMs, 4700);
});

test('daily field is stable for a UTC day and changes at midnight', () => {
  assert.deepEqual(dailyWorld(new Date('2026-09-29T00:00:00Z')), dailyWorld(new Date('2026-09-29T23:59:59Z')));
  assert.notEqual(dailyWorld(new Date('2026-09-29T23:59:59Z')).seed, dailyWorld(new Date('2026-09-30T00:00:00Z')).seed);
  assert.equal(dailyWorld(new Date('2026-09-29T23:59:59-01:00')).day, '2026-09-30');
});

test('world seed accepts the whole uint32 range without wrapping invalid input', () => {
  assert.equal(parseSeed('0'), 0);
  assert.equal(parseSeed('4294967295'), 4294967295);
  assert.equal(parseSeed(' 00123 '), 123);
  for (const input of ['', '-1', '4294967296', '1e3', '12.3', 'abc', null, Infinity]) assert.equal(parseSeed(input), null);
});

test('camera recovery rejects corrupt coordinates and constrains zoom', () => {
  assert.deepEqual(sanitizeCamera({ x: NaN, y: Infinity, zoom: -100 }), { x: 0, y: 0, zoom: 18 });
  assert.deepEqual(sanitizeCamera({ x: -17.5, y: 21, zoom: 9000 }), { x: -17.5, y: 21, zoom: 64 });
  assert.deepEqual(sanitizeCamera(null), { x: 0, y: 0, zoom: 36 });
});

test('chunk save restores counts, flags and negative-coordinate territory', () => {
  const world = new WorldState(459);
  world.reveal(0, 0);
  let flag;
  for (let y = -15; y < 0 && !flag; y++) for (let x = -15; x < 0 && !flag; x++) {
    if (!world.isRevealed(x, y) && world.canInteract(x, y)) flag = { x, y };
  }
  assert.ok(flag);
  world.toggleFlag(flag.x, flag.y);
  const restored = new WorldState(world.seed, world.serialize());
  assert.equal(restored.revealedCount, world.revealedCount);
  assert.equal(restored.flagCount, 1);
  assert.equal(restored.isFlagged(flag.x, flag.y), true);
  assert.deepEqual(restored.serialize(), world.serialize());
});
