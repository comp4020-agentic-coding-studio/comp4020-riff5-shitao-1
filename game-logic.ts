// Pure simulation for "One Stroke". No canvas, no DOM, no Date.now/Math.random
// --- everything here is a function of the previous state and elapsed time, so
// it runs the same in a browser frame and in a vitest assertion. Rendering
// (game-render.ts) reads this state; it never feeds back into it.

export interface Wall {
  x: number; // world-x, 1 = off the right edge, 0 = the brush's column
  gapCenter: number; // 0..1 fraction of height
  gapHeight?: number; // 0..1 fraction of height; falls back to config.gapHeight when unset
  thickness?: number; // 0..1 fraction of width; falls back to config.wallThickness when unset
}

export interface Drop {
  x: number;
  y: number;
}

export interface GameState {
  brushY: number; // 0..1
  ink: number; // 0..1, 0 means the stroke has dried out
  distance: number; // world units travelled, doubles as the score
  walls: Wall[];
  drops: Drop[];
  alive: boolean;
  cause: "wall" | "ink" | null;
  wallSpawnIndex: number;
  dropSpawnIndex: number;
  distanceSinceWall: number;
  distanceSinceDrop: number;
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
  dropSpacing: number;
  dropRadius: number;
  inkDecay: number;
  inkPerDrop: number;
  brushEase: number;
}

export const DEFAULT_CONFIG: Config = {
  brushX: 0.2,
  brushRadius: 0.02,
  scrollSpeed: 0.24,
  maxSpeedMultiplier: 2.2,
  speedRampPerUnit: 0.05,
  wallSpacing: 0.5,
  wallThickness: 0.035,
  gapHeight: 0.26,
  dropSpacing: 0.37,
  dropRadius: 0.022,
  inkDecay: 0.09,
  inkPerDrop: 0.2,
  brushEase: 10,
};

export function createInitialState(): GameState {
  return {
    brushY: 0.5,
    ink: 1,
    distance: 0,
    walls: [],
    drops: [],
    alive: true,
    cause: null,
    wallSpawnIndex: 0,
    dropSpawnIndex: 0,
    distanceSinceWall: 0.15, // first wall arrives quickly, before the paper's edge
    distanceSinceDrop: 0.3,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * clamp01(t);
}

// The gap pattern is deterministic (a function of spawn order, not the
// clock), so a replay and a test both see the same course. The first two
// gaps sit off-centre on purpose --- the brush starts at 0.5, so the opening
// wall only misses it if the player has already moved, which is the whole
// affordance: the game teaches "the mouse steers this" before anyone reads a
// word about it. After that, the amplitude ramps up as the run goes on.
export function gapCenterFor(index: number): number {
  if (index === 0) return 0.3;
  if (index === 1) return 0.7;
  const amplitude = Math.min(0.34, 0.2 + index * 0.012);
  return clamp(0.5 + amplitude * Math.sin(index * 0.9), 0.16, 0.84);
}

export function dropYFor(index: number): number {
  return 0.5 + 0.32 * Math.sin(index * 2.07 + 0.7);
}

// Same deterministic-by-index approach as gapCenterFor, applied to the wall's
// other dimensions --- a fixed opening of one shape, spaced at one interval,
// reads as a repeating pattern rather than a stroke to react to. Each swings
// around the config's base value on its own phase/frequency so the three
// never move in lockstep.
export function gapHeightFor(index: number, config: Config = DEFAULT_CONFIG): number {
  const swing = 0.07;
  return clamp(config.gapHeight + swing * Math.sin(index * 1.7 + 0.4), config.gapHeight - swing, config.gapHeight + swing);
}

export function wallThicknessFor(index: number, config: Config = DEFAULT_CONFIG): number {
  const swing = 0.018;
  return clamp(
    config.wallThickness + swing * Math.sin(index * 1.3 + 1.1),
    config.wallThickness - swing,
    config.wallThickness + swing,
  );
}

export function wallSpacingFor(index: number, config: Config = DEFAULT_CONFIG): number {
  const swing = 0.16;
  return clamp(config.wallSpacing + swing * Math.sin(index * 0.6 + 2.2), config.wallSpacing - swing, config.wallSpacing + swing);
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
  const thickness = wall.thickness ?? config.wallThickness;
  const gapHeight = wall.gapHeight ?? config.gapHeight;
  const wallLeft = wall.x - thickness / 2;
  const wallRight = wall.x + thickness / 2;
  const overlapsX = brushX + brushRadius >= wallLeft && brushX - brushRadius <= wallRight;
  if (!overlapsX) return false;

  const gapTop = wall.gapCenter - gapHeight / 2;
  const gapBottom = wall.gapCenter + gapHeight / 2;
  const brushTop = brushY - brushRadius;
  const brushBottom = brushY + brushRadius;
  return brushTop < gapTop || brushBottom > gapBottom;
}

export function advance(
  state: GameState,
  dt: number,
  pointerY: number,
  config: Config = DEFAULT_CONFIG,
): GameState {
  if (!state.alive || dt <= 0) return state;

  const dx = dt * config.scrollSpeed * speedMultiplier(state.distance, config);
  const brushY = lerp(state.brushY, clamp01(pointerY), dt * config.brushEase);
  const distance = state.distance + dx;

  let walls = state.walls
    .map((w) => ({ x: w.x - dx, gapCenter: w.gapCenter }))
    .filter((w) => w.x > -config.wallThickness);

  let wallSpawnIndex = state.wallSpawnIndex;
  let distanceSinceWall = state.distanceSinceWall + dx;
  let nextWallGap = wallSpacingFor(wallSpawnIndex, config);
  while (distanceSinceWall >= nextWallGap) {
    distanceSinceWall -= nextWallGap;
    const thickness = wallThicknessFor(wallSpawnIndex, config);
    walls = [
      ...walls,
      {
        x: 1 + thickness,
        gapCenter: gapCenterFor(wallSpawnIndex),
        gapHeight: gapHeightFor(wallSpawnIndex, config),
        thickness,
      },
    ];
    wallSpawnIndex += 1;
    nextWallGap = wallSpacingFor(wallSpawnIndex, config);
  }

  let drops = state.drops.map((d) => ({ x: d.x - dx, y: d.y })).filter((d) => d.x > -config.dropRadius);

  let dropSpawnIndex = state.dropSpawnIndex;
  let distanceSinceDrop = state.distanceSinceDrop + dx;
  while (distanceSinceDrop >= config.dropSpacing) {
    distanceSinceDrop -= config.dropSpacing;
    drops = [...drops, { x: 1 + config.dropRadius, y: dropYFor(dropSpawnIndex) }];
    dropSpawnIndex += 1;
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
  const alive = !hitWall && ink > 0;
  const cause: GameState["cause"] = hitWall ? "wall" : ink <= 0 ? "ink" : null;

  return {
    brushY,
    ink,
    distance,
    walls,
    drops: remainingDrops,
    alive,
    cause,
    wallSpawnIndex,
    dropSpawnIndex,
    distanceSinceWall,
    distanceSinceDrop,
  };
}
