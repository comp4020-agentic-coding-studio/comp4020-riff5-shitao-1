// "One Stroke" --- the whole game is one canvas. The opening frame has to
// make the first move obvious on its own, so there is no start button and no
// text about controls anywhere in this file or index.html: the brush sits
// still, the first gap is already off to one side, and the wall is already
// approaching. Moving the pointer (or holding an arrow key) is the only way
// to find out what happens next, which is the point.
import { advance, createInitialState, DEFAULT_CONFIG, type GameState } from "./game-logic.ts";

const canvas = document.querySelector<HTMLCanvasElement>("#game");
if (!canvas) throw new Error("missing #game canvas");
const ctx = canvas.getContext("2d");
if (!ctx) throw new Error("2d canvas context unavailable");

const PAPER = "#f3ead9";
const INK = "#1c1a17";
const SEAL = "#b3402a";

let state: GameState = createInitialState();
let pointerY = 0.5;
let keyDir = 0; // -1 up, 0 none, +1 down
const KEY_SPEED = 1.1; // fraction of height per second

let diedAt: number | null = null;
const RESET_DELAY = 1.3; // seconds the dried stroke lingers before a fresh one begins
const trail: number[] = []; // recent brushY samples, in world (0..1) units, for the ink tail
const TRAIL_LENGTH = 14;

// A run's distance resets to 0 on death; persisting the best across runs (and
// across visits) is what turns "try again" into "beat that" --- the thread
// worth pulling once the wall/ink pair is no longer new. Session state, so it
// lives here rather than in the pure sim.
const BEST_KEY = "one-stroke-best-distance";

// localStorage access throws in some private-browsing/storage-blocked
// configurations (notably older Safari with cookies disabled); since this
// runs at module load, an uncaught throw here would crash the whole script
// before the game ever draws a frame. Losing the persisted best is an
// acceptable fallback --- losing the game itself is not.
function readBestDistance(): number {
  try {
    return Number(localStorage.getItem(BEST_KEY) ?? "0") || 0;
  } catch {
    return 0;
  }
}

function writeBestDistance(value: number): void {
  try {
    localStorage.setItem(BEST_KEY, String(value));
  } catch {
    // storage unavailable --- best just won't survive this session
  }
}

let best = readBestDistance();

// Measured from `main` (a plain block, no intrinsic size of its own) rather
// than from the canvas itself: a canvas's width/height attributes give it an
// intrinsic aspect ratio, so reading the canvas's own rect back to decide its
// next size closes a feedback loop --- each resize nudges the ratio, the
// ratio nudges the next measured size, and repeated window resizes made the
// canvas grow without bound. Setting explicit px style here, instead of
// leaving the CSS size to auto/percentage resolution, means that ratio can
// never re-enter the layout.
function resizeCanvas(): void {
  const main = canvas!.parentElement!;
  const mainRect = main.getBoundingClientRect();
  const mainStyle = getComputedStyle(main);
  const paddingLeft = parseFloat(mainStyle.paddingLeft);
  const paddingRight = parseFloat(mainStyle.paddingRight);
  const paddingTop = parseFloat(mainStyle.paddingTop);
  const paddingBottom = parseFloat(mainStyle.paddingBottom);

  const cssWidth = mainRect.width - paddingLeft - paddingRight;
  const cssHeight = Math.max(
    mainRect.height - paddingTop - paddingBottom,
    window.innerHeight * 0.6,
  );

  canvas!.style.left = `${paddingLeft}px`;
  canvas!.style.top = `${paddingTop}px`;
  canvas!.style.width = `${cssWidth}px`;
  canvas!.style.height = `${cssHeight}px`;

  const dpr = window.devicePixelRatio || 1;
  canvas!.width = Math.max(1, Math.round(cssWidth * dpr));
  canvas!.height = Math.max(1, Math.round(cssHeight * dpr));
  ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function relativeY(clientY: number): number {
  const rect = canvas!.getBoundingClientRect();
  return Math.min(1, Math.max(0, (clientY - rect.top) / rect.height));
}

// pointermove unifies mouse, touch and pen --- no separate touch handler
// needed; touch-action: none (styles.css) stops the page scrolling under it.
canvas.addEventListener("pointermove", (event) => {
  pointerY = relativeY(event.clientY);
});

window.addEventListener("keydown", (event) => {
  if (event.key === "ArrowUp" || event.key === "w" || event.key === "W") keyDir = -1;
  if (event.key === "ArrowDown" || event.key === "s" || event.key === "S") keyDir = 1;
});

window.addEventListener("keyup", (event) => {
  if (["ArrowUp", "ArrowDown", "w", "W", "s", "S"].includes(event.key)) keyDir = 0;
});

// A key held when focus leaves the window (alt-tab, a notification, clicking
// another app) never gets its keyup --- the browser just stops delivering
// events to this page. Without this, keyDir stays stuck non-zero forever,
// and the additive keyboard branch in frame() overrides pointer control too
// on return, since it only checks keyDir !== 0, not which input is "active."
window.addEventListener("blur", () => {
  keyDir = 0;
});

window.addEventListener("resize", resizeCanvas);
resizeCanvas();

function toPixels(fracX: number, fracY: number): [number, number] {
  const rect = canvas!.getBoundingClientRect();
  return [fracX * rect.width, fracY * rect.height];
}

function drawScene(now: number): void {
  const rect = canvas!.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;

  ctx!.fillStyle = PAPER;
  ctx!.fillRect(0, 0, w, h);

  const dead = !state.alive;
  const elapsedSinceDeath = dead && diedAt !== null ? (now - diedAt) / 1000 : 0;
  const fade = dead ? Math.max(0, 1 - elapsedSinceDeath / RESET_DELAY) : 1;

  // walls: two ink bands with a paper-coloured gap between them
  ctx!.fillStyle = dead ? `rgba(28, 26, 23, ${0.35 * fade + 0.15})` : INK;
  for (const wall of state.walls) {
    const [wx] = toPixels(wall.x, 0);
    const wallWidthPx = DEFAULT_CONFIG.wallThickness * w;
    const gapTop = (wall.gapCenter - DEFAULT_CONFIG.gapHeight / 2) * h;
    const gapBottom = (wall.gapCenter + DEFAULT_CONFIG.gapHeight / 2) * h;
    ctx!.fillRect(wx - wallWidthPx / 2, 0, wallWidthPx, gapTop);
    ctx!.fillRect(wx - wallWidthPx / 2, gapBottom, wallWidthPx, h - gapBottom);
  }

  // drops: small seal-red dots waiting to be picked up
  ctx!.fillStyle = SEAL;
  for (const drop of state.drops) {
    const [dx, dy] = toPixels(drop.x, drop.y);
    ctx!.beginPath();
    ctx!.arc(dx, dy, DEFAULT_CONFIG.dropRadius * w, 0, Math.PI * 2);
    ctx!.fill();
  }

  // the stroke's tail, thinning toward the back
  const [brushXPx] = toPixels(DEFAULT_CONFIG.brushX, 0);
  const baseRadius = DEFAULT_CONFIG.brushRadius * w * (0.4 + 0.6 * state.ink);
  for (let i = 0; i < trail.length; i += 1) {
    const t = i / trail.length;
    const [, ty] = toPixels(0, trail[i]!);
    const tx = brushXPx - (trail.length - i) * (w * 0.012);
    ctx!.fillStyle = `rgba(28, 26, 23, ${(0.25 + 0.35 * t) * fade})`;
    ctx!.beginPath();
    ctx!.arc(tx, ty, baseRadius * (0.35 + 0.5 * t), 0, Math.PI * 2);
    ctx!.fill();
  }

  // the brush itself
  const [, brushYPx] = toPixels(0, state.brushY);
  ctx!.fillStyle = `rgba(28, 26, 23, ${dead ? fade : 0.5 + 0.5 * state.ink})`;
  ctx!.beginPath();
  ctx!.arc(brushXPx, brushYPx, baseRadius, 0, Math.PI * 2);
  ctx!.fill();

  // ink meter: a thin bar the stroke itself is drawn from
  ctx!.fillStyle = "rgba(28, 26, 23, 0.18)";
  ctx!.fillRect(w * 0.04, h - 14, w * 0.2, 4);
  ctx!.fillStyle = "rgba(28, 26, 23, 0.55)";
  ctx!.fillRect(w * 0.04, h - 14, w * 0.2 * state.ink, 4);

  // distance, as a bare number --- feedback, not instruction --- with the
  // standing best beneath it once one exists, so a stranger's second life
  // already has something to chase
  ctx!.fillStyle = "rgba(28, 26, 23, 0.55)";
  ctx!.font = "16px system-ui, sans-serif";
  ctx!.textAlign = "right";
  ctx!.fillText(String(Math.floor(state.distance * 100)), w - 16, 24);
  if (best > 0) {
    ctx!.font = "12px system-ui, sans-serif";
    ctx!.fillStyle = "rgba(28, 26, 23, 0.35)";
    ctx!.fillText(`best ${Math.floor(best * 100)}`, w - 16, 42);
  }
}

let lastTime: number | null = null;

function frame(now: number): void {
  if (lastTime === null) lastTime = now;
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;

  if (state.alive) {
    if (keyDir !== 0) pointerY = Math.min(1, Math.max(0, pointerY + keyDir * KEY_SPEED * dt));
    state = advance(state, dt, pointerY, DEFAULT_CONFIG);
    trail.push(state.brushY);
    if (trail.length > TRAIL_LENGTH) trail.shift();
    if (!state.alive) {
      diedAt = now;
      if (state.distance > best) {
        best = state.distance;
        writeBestDistance(best);
      }
    }
  } else if (diedAt !== null && (now - diedAt) / 1000 >= RESET_DELAY) {
    state = createInitialState();
    diedAt = null;
    trail.length = 0;
  }

  drawScene(now);
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
