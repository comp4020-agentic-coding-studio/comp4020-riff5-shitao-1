import { describe, expect, it } from "vitest";
import {
  advance,
  checkWallCollision,
  createInitialState,
  DEFAULT_CONFIG,
  gapCenterFor,
  type GameState,
  type Wall,
} from "../game-logic.ts";

// "a wrong move is possible, and play ends somewhere" --- the collision rule
// is the one thing this week's spec asks for a focused test on.
describe("checkWallCollision: a wall ends the round only if the brush misses the gap", () => {
  const wall: Wall = { x: 0.2, gapCenter: 0.5 };

  it("passes when the brush sits inside the gap", () => {
    expect(checkWallCollision(0.5, 0.2, 0.02, wall, DEFAULT_CONFIG)).toBe(false);
  });

  it("collides when the brush is above the gap", () => {
    expect(checkWallCollision(0.05, 0.2, 0.02, wall, DEFAULT_CONFIG)).toBe(true);
  });

  it("collides when the brush is below the gap", () => {
    expect(checkWallCollision(0.95, 0.2, 0.02, wall, DEFAULT_CONFIG)).toBe(true);
  });

  it("ignores a wall the brush hasn't reached yet", () => {
    const farWall: Wall = { x: 0.9, gapCenter: 0.5 };
    expect(checkWallCollision(0.05, 0.2, 0.02, farWall, DEFAULT_CONFIG)).toBe(false);
  });
});

describe("advance: the round ends on either failure, not just collision", () => {
  it("kills the run when a wall's gap doesn't reach the brush's height", () => {
    let state = createInitialState();
    state = { ...state, walls: [{ x: DEFAULT_CONFIG.brushX, gapCenter: 0.9 }], brushY: 0.5 };
    const next = advance(state, 1 / 60, false);
    expect(next.alive).toBe(false);
    expect(next.cause).toBe("wall");
  });

  it("kills the run when ink runs dry, even with every wall cleared", () => {
    let state = { ...createInitialState(), ink: 0.001, walls: [], drops: [] };
    const next = advance(state, 1, false);
    expect(next.alive).toBe(false);
    expect(next.cause).toBe("ink");
  });

  it("a collected drop replenishes ink instead of ending the run", () => {
    const state = {
      ...createInitialState(),
      ink: 0.2,
      brushY: 0.5,
      walls: [],
      drops: [{ x: DEFAULT_CONFIG.brushX, y: 0.5 }],
    };
    const next = advance(state, 1 / 60, false);
    expect(next.alive).toBe(true);
    expect(next.ink).toBeGreaterThan(0.2);
    expect(next.drops).toHaveLength(0);
  });

  it("does nothing once the run is already over", () => {
    const state = { ...createInitialState(), alive: false, cause: "wall" as const };
    const next = advance(state, 1, false);
    expect(next).toBe(state);
  });

  it("distance only grows while alive, so it doubles as a stable score", () => {
    const state = createInitialState();
    const next = advance(state, 1 / 60, false);
    expect(next.distance).toBeGreaterThan(state.distance);
  });
});

describe("advance: gravity always pulls down, holding up is the only thing that fights it", () => {
  it("falls when the up control isn't held, even with no walls or drops in the way", () => {
    const state = { ...createInitialState(), walls: [], drops: [] };
    const next = advance(state, 0.5, false);
    expect(next.brushY).toBeGreaterThan(state.brushY);
    expect(next.brushVelocity).toBeGreaterThan(0);
  });

  it("rises when the up control is held long enough to overcome gravity", () => {
    const state = { ...createInitialState(), walls: [], drops: [] };
    const next = advance(state, 0.5, true);
    expect(next.brushY).toBeLessThan(state.brushY);
    expect(next.brushVelocity).toBeLessThan(0);
  });

  it("releasing the up control lets gravity retake the stroke on the very next frame", () => {
    let state: GameState = { ...createInitialState(), walls: [], drops: [] };
    state = advance(state, 0.2, true); // rising
    const risingVelocity = state.brushVelocity;
    state = advance(state, 1 / 60, false); // let go
    expect(state.brushVelocity).toBeGreaterThan(risingVelocity);
  });
});

describe("gapCenterFor: deterministic course, harder as the run goes on", () => {
  it("the opening two gaps sit off-centre, so standing still is a loss", () => {
    expect(gapCenterFor(0)).toBeCloseTo(0.3);
    expect(gapCenterFor(1)).toBeCloseTo(0.7);
  });

  it("never places a gap centre outside the playable band", () => {
    for (let i = 0; i < 200; i += 1) {
      const center = gapCenterFor(i);
      expect(center).toBeGreaterThanOrEqual(0.16);
      expect(center).toBeLessThanOrEqual(0.84);
    }
  });
});
