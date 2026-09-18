import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WorldState,
  isMine,
  neighborCount,
  encodeActions,
  decodeActions
} from '../src/core.js';

const DIRS = [
  [-1,-1],[0,-1],[1,-1],[-1,0],[1,0],[-1,1],[0,1],[1,1]
];

function findChordCenter(seed) {
  for (let y = 6; y < 80; y++) {
    for (let x = 6; x < 80; x++) {
      const count = neighborCount(x, y, seed);
      if (count > 0 && count < 8) return { x, y, count };
    }
  }
  throw new Error('Could not find chord test cell');
}

test('replay codec preserves chord actions', () => {
  const actions = [
    { t: 'r', x: 0, y: 0, dt: 0 },
    { t: 'f', x: 4, y: -3, dt: 121 },
    { t: 'c', x: 3, y: -3, dt: 47 }
  ];
  assert.deepEqual(decodeActions(encodeActions(actions)), actions);
});

test('chord opens covered neighbors when adjacent flag count matches', () => {
  const seed = 0x1234abcd;
  const { x, y, count } = findChordCenter(seed);
  const world = new WorldState(seed);
  world.setRevealed(x, y, true);

  let flags = 0;
  for (const [dx, dy] of DIRS) {
    const nx = x + dx, ny = y + dy;
    if (isMine(nx, ny, seed)) {
      world.setFlagged(nx, ny, true);
      flags++;
    }
  }

  assert.equal(flags, count);
  const result = world.chord(x, y);
  assert.equal(result.accepted, true);
  assert.equal(result.mine, false);
  assert.ok(result.opened > 0);
});

test('incorrect flags can make a chord hit an unflagged mine', () => {
  const seed = 0x1234abcd;
  const { x, y, count } = findChordCenter(seed);
  const world = new WorldState(seed);
  world.setRevealed(x, y, true);

  const mines = [];
  const safe = [];
  for (const [dx, dy] of DIRS) {
    const cell = [x + dx, y + dy];
    (isMine(cell[0], cell[1], seed) ? mines : safe).push(cell);
  }

  assert.ok(mines.length > 0);
  assert.ok(safe.length > 0);

  // Leave one real mine unflagged and replace it with a wrong safe-cell flag.
  for (const [mx, my] of mines.slice(1)) world.setFlagged(mx, my, true);
  world.setFlagged(safe[0][0], safe[0][1], true);
  assert.equal(world.flagCount, count);

  const result = world.chord(x, y);
  assert.equal(result.accepted, true);
  assert.equal(result.mine, true);
  assert.deepEqual(result.hit, { x: mines[0][0], y: mines[0][1] });
});

test('chord is a no-op until the adjacent flag count matches', () => {
  const seed = 0x1234abcd;
  const { x, y } = findChordCenter(seed);
  const world = new WorldState(seed);
  world.setRevealed(x, y, true);

  const result = world.chord(x, y);
  assert.equal(result.accepted, false);
  assert.equal(result.mine, false);
});
