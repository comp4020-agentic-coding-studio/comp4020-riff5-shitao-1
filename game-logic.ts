// Pure simulation for "One Stroke". No canvas, no DOM, no Date.now/Math.random
// --- everything here is a function of the previous state and elapsed time, so
// it runs the same in a browser frame and in a vitest assertion. Rendering
// (game-render.ts) reads this state; it never feeds back into it.

export interface Wall {
  x: number; // world-x, 1 = off the right edge, 0 = the brush's column
  gapCenter: number; // 0..1 fraction of height
}

export interface Drop {
  x: number;
  y: number;
}

export interface GameState {
  brushY: number; // 0..1
  brushVelocity: number; // fraction-of-height per second; positive is downward
  ink: number; // 0..1, 0 means the stroke has dried out
  distance: number; // world units travelled, doubles as the score
  walls: Wall[];
  drops: Drop[];
  alive: boolean;
  cause: "wall" | "ink" | "ground" | null;
  wallSpawnIndex: number;
  distanceSinceWall: number;
}

export interface Config {
  brushX: number;
  brushRadius: number;
  scrollSpeed: number;
  maxSpeedMultiplier: number;
  speedRampPerUnit: number;
  wallSpacing: number;
  wallThickness: number;
  gapHeight: number;
  dropRadius: number;
  inkDecay: number;
  inkPerDrop: number;
  gravity: number; // downward accel on brushY, in fraction-of-height per second^2
  lift: number; // extra upward accel applied on top of gravity while the up control is held
  maxFallSpeed: number; // terminal velocity, in fraction-of-height per second, either direction
}

export const DEFAULT_CONFIG: Config = {
  brushX: 0.2,
  brushRadius: 0.02,
  scrollSpeed: 0.16,
  maxSpeedMultiplier: 2.2,
  speedRampPerUnit: 0.05,
  wallSpacing: 0.5,
  wallThickness: 0.035,
  gapHeight: 0.26,
  dropRadius: 0.022,
  inkDecay: 0.09,
  inkPerDrop: 0.2,
  gravity: 1.5,
  lift: 3.3,
  maxFallSpeed: 1.1,
};

export function createInitialState(): GameState {
  return {
    brushY: 0.5,
    brushVelocity: 0,
    ink: 1,
    distance: 0,
    walls: [],
    drops: [],
    alive: true,
    cause: null,
    wallSpawnIndex: 0,
    distanceSinceWall: 0.15, // first wall arrives quickly, before the paper's edge
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

// The gap pattern is deterministic (a function of spawn order, not the
// clock), so a replay and a test both see the same course. The first two
// gaps sit off-centre on purpose --- the brush starts at rest at 0.5 and
// gravity takes over immediately, so the opening wall only misses it if the
// player is already holding the up control, which is the whole affordance:
// the game teaches "falling is the default, holding up fights it" before
// anyone reads a word about it. After that, the amplitude ramps up as the
// run goes on.
export function gapCenterFor(index: number): number {
  if (index === 0) return 0.3;
  if (index === 1) return 0.7;
  const amplitude = Math.min(0.34, 0.2 + index * 0.012);
  return clamp(0.5 + amplitude * Math.sin(index * 0.9), 0.16, 0.84);
}

export function speedMultiplier(distance: number, config: Config = DEFAULT_CONFIG): number {
  return Math.min(config.maxSpeedMultiplier, 1 + distance * config.speedRampPerUnit);
}

// The one rule under a focused test: a wall is two ink bands with a paper
// gap between them, and the brush survives only while it fits inside that
// gap at the moment their x-ranges overlap.
export function checkWallCollision(
  brushY: number,
  brushX: number,
  brushRadius: number,
  wall: Wall,
  config: Config = DEFAULT_CONFIG,
): boolean {
  const wallLeft = wall.x - config.wallThickness / 2;
  const wallRight = wall.x + config.wallThickness / 2;
  const overlapsX = brushX + brushRadius >= wallLeft && brushX - brushRadius <= wallRight;
  if (!overlapsX) return false;

  const gapTop = wall.gapCenter - config.gapHeight / 2;
  const gapBottom = wall.gapCenter + config.gapHeight / 2;
  const brushTop = brushY - brushRadius;
  const brushBottom = brushY + brushRadius;
  return brushTop < gapTop || brushBottom > gapBottom;
}

export function advance(
  state: GameState,
  dt: number,
  thrustHeld: boolean,
  config: Config = DEFAULT_CONFIG,
): GameState {
  if (!state.alive || dt <= 0) return state;

  const dx = dt * config.scrollSpeed * speedMultiplier(state.distance, config);
  const distance = state.distance + dx;

  // Gravity always pulls the stroke down the page; holding the up control is
  // the only thing that resists it, so letting go --- even briefly --- means
  // the brush starts drifting toward the bottom of the paper again.
  let brushVelocity = state.brushVelocity + config.gravity * dt;
  if (thrustHeld) brushVelocity -= config.lift * dt;
  brushVelocity = clamp(brushVelocity, -config.maxFallSpeed, config.maxFallSpeed);
  // The paper's bottom edge is a floor, not a wall the brush bounces off ---
  // reaching it means gravity won outright, so it ends the run on its own,
  // the same way running dry does. The top edge stays a soft clamp: holding
  // up and pinning against the ceiling is a legitimate way to play.
  const rawBrushY = state.brushY + brushVelocity * dt;
  const hitGround = rawBrushY >= 1;
  const brushY = clamp01(rawBrushY);

  let walls = state.walls
    .map((w) => ({ x: w.x - dx, gapCenter: w.gapCenter }))
    .filter((w) => w.x > -config.wallThickness);

  let drops = state.drops.map((d) => ({ x: d.x - dx, y: d.y })).filter((d) => d.x > -config.dropRadius);

  let wallSpawnIndex = state.wallSpawnIndex;
  let distanceSinceWall = state.distanceSinceWall + dx;
  while (distanceSinceWall >= config.wallSpacing) {
    distanceSinceWall -= config.wallSpacing;
    const gapCenter = gapCenterFor(wallSpawnIndex);
    walls = [...walls, { x: 1 + config.wallThickness, gapCenter }];
    // The ink lives inside the gap it belongs to rather than on a schedule of
    // its own --- collecting a drop and threading the gap are the same
    // motion, so reaching for ink never means flying blind into a wall.
    drops = [...drops, { x: 1 + config.wallThickness, y: gapCenter }];
    wallSpawnIndex += 1;
  }

  let ink = Math.max(0, state.ink - dt * config.inkDecay);
  const remainingDrops: Drop[] = [];
  for (const drop of drops) {
    const collected = Math.hypot(drop.x - config.brushX, drop.y - brushY) <= config.dropRadius + config.brushRadius;
    if (collected) {
      ink = Math.min(1, ink + config.inkPerDrop);
    } else {
      remainingDrops.push(drop);
    }
  }

  const hitWall = walls.some((w) => checkWallCollision(brushY, config.brushX, config.brushRadius, w, config));
  const alive = !hitWall && !hitGround && ink > 0;
  const cause: GameState["cause"] = hitWall ? "wall" : hitGround ? "ground" : ink <= 0 ? "ink" : null;

  return {
    brushY,
    brushVelocity,
    ink,
    distance,
    walls,
    drops: remainingDrops,
    alive,
    cause,
    wallSpawnIndex,
    distanceSinceWall,
  };
}
