# sokoban-solver-01 entry — push-optimal room-decomposed Sokoban solver

An entry for make.fun's `sokoban-solver-01` bounty. It reads every instance of a set from
`/input/<id>/level.txt` and writes `/output/<id>/solution.txt` (LURD moves), one run per set,
on Node 22 with nothing installed.

## Approach

The competition's levels are a one-square hallway with 1-4 independent rooms off it, each room
holding 3-4 boxes over goals of its own. A box pushed out of its room into the hallway can never
come back, so every box stays in its room and the level's push-optimal count P* is the sum of its
rooms' optima.

The solver exploits that structure exactly:

1. **Room decomposition.** All floor of the player's row (the hallway) is cut away; the parts left,
   each holding its own boxes and goals, are the rooms. The doors stand in the rows beside the
   hallway, so no room is lost, and a box is never on the hallway.
2. **Per-room push-optimal search.** Each room is solved in turn with a breadth-first search over
   pushes (a state is the boxes' squares and the player's reachable region, named by its lowest
   square), expanded in order of pushes made, so the first solved state is push-optimal. The other
   rooms' boxes stand as walls — done rooms' at their goals — and the player walks the hallway to
   each room's door. Deadlock pruning: a push onto a dead square (one from which no push, ignoring
   the other boxes, reaches a goal) and a push making a frozen 2x2 block of walls and boxes with a
   box off its goal. Neither prunes a solvable state, so the optimum stands. State keys are exact:
   base-`size` digits for rooms (≤ 4 boxes), strings otherwise.
3. **Joining.** The rooms' moves are joined with the player's shortest walks between them; a walk
   costs no push, so the answer takes exactly P* pushes whenever the per-room searches succeed.
   A whole-level push search (the same algorithm, string state keys) is the fallback for a level
   that is no set of rooms.

The search budgets by work (states), never the clock, so the two executions the grader runs answer
alike: the output is deterministic.

## Results

- Practice set: 5,000 of 5,000 checker points — every instance solved in exactly P* pushes
  (13, 16, 29, 47, 60), verified against the kit's checker and `grade-local` (score 1,000,000,
  passed, L1 regrade reproduced byte for byte).
- 20 freshly drawn sets (100 instances, all shapes from 1 room of 3 boxes to 4 rooms of 4):
  100,000 of 100,000 points, worst set 0.73 s wall — far inside the 60 s budget for the whole set.
- House baseline (plain-astar 1.0.0) on the same practice set: 1,000 of 5,000.

## Layout

- `main.ts` — the whole entry (single file, no external dependencies, erasable TypeScript only).

## Licence

MIT (see LICENSE).
