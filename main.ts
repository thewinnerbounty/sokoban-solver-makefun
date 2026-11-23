// sokoban solver for make.fun sokoban-solver-01 (MIT).
//
// The levels of this competition are a one-square hallway with 1-4 independent rooms off it, each room holding
// 3-4 boxes on goals of its own; a box pushed out of its room into the hallway can never come back, so every box
// stays in its room and the level's push-optimal count is the sum of its rooms' optima.
//
// This solver exploits exactly that: it cuts the level into its rooms (the dead squares of the player's row, the
// hallway, separate them), solves each room push-optimally with a breadth-first search over pushes with deadlock
// pruning (dead squares and frozen 2x2 blocks, neither of which prunes a solvable state), and joins the rooms'
// solutions with the player's shortest walks between them. Because the rooms are independent and a walk costs no
// push, the result takes exactly P* pushes: the level's optimum, whenever the per-room searches succeed.
// A whole-level push search stands as the fallback for a level that is no set of rooms.
//
// The search budgets by work (states expanded), never the clock, so the two executions the grader runs answer
// alike: the answer is deterministic.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The most states one search keeps before it gives up (a memory bound: the grader gives the whole run 512 MB). */
const MAX_STATES = 2_000_000;

const DIRS: readonly [number, number, string][] = [
  [0, -1, 'u'],
  [0, 1, 'd'],
  [-1, 0, 'l'],
  [1, 0, 'r'],
];

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goal: Uint8Array;
  box: Uint8Array;
  player: number;
}

/** A level in XSB text: its walls, goals, boxes and player (the outer frame forced to wall). */
function levelOf(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goal = new Uint8Array(w * h);
  const box = new Uint8Array(w * h);
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goal[i] = 1;
      if (ch === '$' || ch === '*') box[i] = 1;
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
  return { w, h, wall, goal, box, player };
}

/** The squares from which a box alone (ignoring the other boxes) can still be pushed onto some goal. */
function liveSquares(lv: Level): Uint8Array {
  const { w, wall, goal } = lv;
  const live = new Uint8Array(wall.length);
  const queue: number[] = [];
  for (let i = 0; i < wall.length; i++)
    if (goal[i]) {
      live[i] = 1;
      queue.push(i);
    }
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/** The player's reachable region from `from` around walls and boxes in `occ`; its lowest square. */
function reach(w: number, wall: Uint8Array, occ: Uint8Array, from: number, seen: Int32Array, stamp: number, stack: Int32Array): number {
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    const up = p - w;
    if (wall[up] === 0 && occ[up] === 0 && seen[up] !== stamp) {
      seen[up] = stamp;
      stack[n++] = up;
    }
    const dn = p + w;
    if (wall[dn] === 0 && occ[dn] === 0 && seen[dn] !== stamp) {
      seen[dn] = stamp;
      stack[n++] = dn;
    }
    const lf = p - 1;
    if (wall[lf] === 0 && occ[lf] === 0 && seen[lf] !== stamp) {
      seen[lf] = stamp;
      stack[n++] = lf;
    }
    const rt = p + 1;
    if (wall[rt] === 0 && occ[rt] === 0 && seen[rt] !== stamp) {
      seen[rt] = stamp;
      stack[n++] = rt;
    }
  }
  return low;
}

/** Whether the box just pushed to `t` sits in a frozen 2x2 block of walls and boxes with a box among them off its goal. */
function frozenBlock(w: number, wall: Uint8Array, occ: Uint8Array, goal: Uint8Array, t: number): boolean {
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occ[a]) || !(wall[b] || occ[b]) || !(wall[c] || occ[c]) || !(wall[d] || occ[d])) continue;
    if ((occ[a] && !goal[a]) || (occ[b] && !goal[b]) || (occ[c] && !goal[c]) || (occ[d] && !goal[d])) return true;
  }
  return false;
}

/** The level's rooms: cut the player's whole row (the hallway; the doors stand in the rows beside it) and take the parts holding boxes. */
function roomsOf(lv: Level): { squares: number[]; boxes: number[]; goals: number[]; done?: boolean }[] | null {
  const { w, wall, goal, box, player } = lv;
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) if (!wall[i]) cut[i] = 1;
  if (box.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: { squares: number[]; boxes: number[]; goals: number[] }[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      const p = squares[i]!;
      for (const [dx, dy] of DIRS) {
        const q = p + dy * w + dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [] });
  }
  for (let i = 0; i < wall.length; i++)
    if (box[i]) rooms[part[i]]!.boxes.push(i);
  for (let i = 0; i < wall.length; i++)
    if (goal[i]) {
      if (part[i] < 0) return null;
      rooms[part[i]]!.goals.push(i);
    }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower LURD letters. */
function walkTo(w: number, wall: Uint8Array, occ: Uint8Array, from: number, to: number): string {
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-2);
  const how: (string | undefined)[] = [];
  const queue = [from];
  prev[from] = -1;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || occ[q] || prev[q] !== -2) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -2) throw new Error('walkTo: target out of reach');
  let s = '';
  for (let p = to; prev[p] !== -1; p = prev[p]!) s = how[p] + s;
  return s;
}

/**
 * A push-optimal search over pushes on a level (other rooms' boxes standing as walls): a state is the boxes' squares
 * and the player's reachable region named by its lowest square, expanded in order of pushes made, so the first
 * solved state is push-optimal. Deadlock pruning: a push onto a dead square, and one making a frozen 2x2 block.
 * Returns the moves (lower letter a step, upper one a push), or null when the search gives up.
 */
function solvePushOptimal(lv: Level, maxStates: number): string | null {
  const { w, h, wall, goal, box, player } = lv;
  const size = wall.length;
  const live = liveSquares(lv);
  const boxes: number[] = [];
  for (let i = 0; i < size; i++) if (box[i]) boxes.push(i);
  if (boxes.some((b) => !live[b])) return null;
  const occ = new Uint8Array(size);
  for (const b of boxes) occ[b] = 1;
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  const exactKey = Math.pow(size, boxes.length + 1) < 2 ** 53;
  const keyOf = (bs: number[], low: number): number | string => {
    // Boxes and the region's low square. In base `size` when exact (rooms: up to four boxes), else a string.
    if (!exactKey) return `${low}:${bs.join(',')}`;
    let k = low;
    for (const b of bs) k = k * size + b;
    return k;
  };
  const statesBoxes: number[][] = [boxes];
  const statesPlayer: number[] = [player];
  const parent: number[] = [-1];
  const index = new Map<number | string, number>();
  index.set(keyOf(boxes, reach(w, wall, occ, player, seen, ++stamp, stack)), 0);
  const solved = (bs: number[]): boolean => bs.every((b) => goal[b]);
  let found = solved(boxes) ? 0 : -1;
  for (let head = 0; found < 0 && head < statesBoxes.length; head++) {
    const bs = statesBoxes[head]!;
    for (const b of bs) occ[b] = 1;
    reach(w, wall, occ, statesPlayer[head]!, seen, ++stamp, stack);
    const here = stamp;
    for (let bi = 0; bi < bs.length && found < 0; bi++) {
      const b = bs[bi]!;
      for (const [dx, dy] of DIRS) {
        const d = dy * w + dx;
        const t = b + d;
        if (seen[b - d] !== here || wall[t] || occ[t] || !live[t]) continue;
        occ[b] = 0;
        occ[t] = 1;
        const frozen = frozenBlock(w, wall, occ, goal, t);
        let key = -1;
        let next: number[] | null = null;
        if (!frozen) {
          next = bs.slice();
          next[bi] = t;
          next.sort((x, y) => x - y);
          key = keyOf(next, reach(w, wall, occ, b, mark, ++stamp, stack));
        }
        occ[t] = 0;
        occ[b] = 1;
        if (frozen || index.has(key)) continue;
        if (statesBoxes.length >= maxStates) {
          for (const x of bs) occ[x] = 0;
          return null;
        }
        index.set(key, statesBoxes.length);
        statesBoxes.push(next!);
        statesPlayer.push(b);
        parent.push(head);
        if (solved(next!)) {
          found = statesBoxes.length - 1;
          break;
        }
      }
    }
    for (const b of bs) occ[b] = 0;
  }
  if (found < 0) return null;
  const path: number[] = [];
  for (let s = found; s > 0; s = parent[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let at = player;
  let cur = boxes;
  for (const s of path) {
    const nb = statesBoxes[s]!;
    let from = -1;
    let to = -1;
    for (const b of cur)
      if (!nb.includes(b)) from = b;
    for (const b of nb)
      if (!cur.includes(b)) to = b;
    const d = to - from;
    const dir = DIRS.find(([dx, dy]) => dy * w + dx === d)!;
    for (const b of cur) occ[b] = 1;
    moves += walkTo(w, wall, occ, at, from - d);
    for (const b of cur) occ[b] = 0;
    moves += dir[2].toUpperCase();
    at = from;
    cur = nb;
  }
  void h;
  return moves;
}

/** The whole level solved: cut it into rooms, solve each in turn with the others' boxes as walls, join the moves. */
function solveByRooms(lv: Level): string | null {
  const rooms = roomsOf(lv);
  if (rooms === null) return null;
  let player = lv.player;
  let moves = '';
  for (const room of rooms) {
    const wall = lv.wall.slice();
    for (const other of rooms)
      if (other !== room)
        for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
    const sub: Level = {
      w: lv.w,
      h: lv.h,
      wall,
      goal: lv.goal,
      box: new Uint8Array(lv.wall.length),
      player,
    };
    for (const b of room.boxes) sub.box[b] = 1;
    const part = solvePushOptimal(sub, MAX_STATES);
    if (part === null) return null;
    moves += part;
    // Where the walk left the player: replay the push letters of the room's moves on the whole level.
    for (const ch of part) {
      const [dx, dy] = DIRS.find(([, , l]) => l === ch.toLowerCase())!;
      player += dy * lv.w + dx;
    }
    room.done = true;
  }
  return moves;
}

function solve(text: string): string {
  const lv = levelOf(text);
  const byRooms = solveByRooms(lv);
  if (byRooms !== null) return byRooms;
  // Fallback: a whole-level push search (also answers a level no set of rooms).
  const whole: Level = lv;
  return solvePushOptimal(whole, MAX_STATES) ?? '';
}

for (const id of readdirSync(I).sort()) {
  const moves = solve(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
