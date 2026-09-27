"use client";

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import gsap from "gsap";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import * as THREE from "three";

/* ------------------------------------------------------------------------- *
 * AnyLeet — signature moment
 *
 * One point cloud, two precomputed formations, one progress uniform.
 *
 *   A. PROSE    ragged lines of word-clusters with real paragraph breaks and
 *               depth scatter — a wall of pasted, unparsed text.
 *   C. MATRIX   a flat, bounded grid: line-number gutter, byte-style column
 *               groups, visible rows above hidden rows, an expected-output
 *               column — a prepared judge.
 *
 * There is no third keyframe. The intermediate formation is produced by
 * interpolating each AXIS on its own delayed window: x resolves first
 * (columns align = indentation), y second (rows lock), z last (depth collapses
 * to a plane). That reads as parsing rather than as a blob travelling between
 * two shapes, and it costs one attribute less.
 *
 * Particle i maps to prose cell i and to matrix cell floor(i / CELL_POINTS),
 * both in reading order, so prose line L lands in matrix row L and left stays
 * left. The morph therefore reads as "this line became this test row".
 * ------------------------------------------------------------------------- */

export type ExecutionFieldState = "idle" | "building" | "ready";

export interface ExecutionFieldProps {
  /**
   * "idle"     unparsed field, progress 0
   * "building" animates 0 -> 1 once
   * "ready"    settled matrix, progress 1 with no animation (remount-safe)
   */
  state?: ExecutionFieldState;
  /** Fired when the morph finishes. Not fired for "idle" or a direct "ready" mount. */
  onSettled?: () => void;
  /** Global multiplier so a page can dim the field behind dense UI. */
  opacity?: number;
  /** Positioning hook. The component fills its nearest positioned ancestor. */
  className?: string;
}

/* -- formation geometry ---------------------------------------------------- */

/** Test-case rows. The first VISIBLE_ROWS are shown; the rest are hidden tests. */
const MATRIX_ROWS = 16;
const VISIBLE_ROWS = 10;
/** Assertion columns, including the gutter and the expected-output column. */
const MATRIX_COLS = 64;
const GUTTER_COLS = 3;
const VERDICT_COLS = 2;
/** Points per cell, laid out as a CELL_SUBDIV x CELL_SUBDIV block. */
const CELL_SUBDIV = 4;
const CELL_POINTS = CELL_SUBDIV * CELL_SUBDIV;

/**
 * Derived, never hand-set: 64 * 16 * 16 = 16384 points. Inside the 12k-20k
 * budget, and a power of two so every cell is exactly full.
 */
const PARTICLE_COUNT = MATRIX_COLS * MATRIX_ROWS * CELL_POINTS;

/** Cell advance. 0.128 / 0.221 = 0.58 — the advance/line-height ratio of a monospace face. */
const CELL_W = 0.128;
const CELL_H = 0.221;
/** Gap after the line-number gutter, and every COLUMN_GROUP columns, as in a hex dump. */
const GUTTER_GAP = 0.09;
const COLUMN_GROUP = 8;
const COLUMN_GROUP_GAP = 0.044;
/** Fraction of a cell the point block occupies, leaving the cell its own gutter. */
const CELL_FILL_X = 0.6;
const CELL_FILL_Y = 0.5;
/** Sub-pixel jitter: enough to break moire against the pixel grid, not enough to read as noise. */
const MATRIX_JITTER = 0.003;
const MATRIX_Z_JITTER = 0.02;

const PROSE_WIDTH = 11.2;
const PROSE_LINE_HEIGHT = 0.3;
const PROSE_CHAR_ADVANCE = 0.082;
const PROSE_PARAGRAPH_GAP = 0.7;
const PROSE_BLOCKS = 5;
/** Ink scatter inside one character cell. */
const PROSE_JITTER_X = 0.03;
const PROSE_JITTER_Y = 0.06;
/** Depth spread of the unparsed field. Positive is toward the camera. */
const PROSE_Z_NEAR = 0.55;
const PROSE_Z_FAR = -1.15;

/* -- roles ----------------------------------------------------------------- */

const ROLE_BODY = 0;
const ROLE_GUTTER = 1;
const ROLE_VERDICT = 2;
const ROLE_HIDDEN = 3;

/* -- scene ----------------------------------------------------------------- */

const CAMERA_Z = 9.5;
const CAMERA_FOV = 30;
/** Milliseconds for the morph. The brief's window is 800-1200ms. */
const MORPH_MS = 1050;
/**
 * Fraction of the tween spent staggering particles in. The last particle starts
 * at STAGGER_SPAN and still finishes at 1, so structure sweeps top-to-bottom
 * like a parser reading rather than arriving all at once.
 */
const STAGGER_SPAN = 0.34;
/** Palette. Only these two colours appear; alpha does the rest of the work. */
const BODY_COLOR = "#9AA1AA";
const ACCENT_COLOR = "#7C8F82";
/** Apparent point size in CSS pixels, multiplied by device pixel ratio at runtime. */
const POINT_SIZE_CSS_PX = 1.35;

const MATRIX_WIDTH =
  MATRIX_COLS * CELL_W +
  GUTTER_GAP +
  Math.floor((MATRIX_COLS - GUTTER_COLS - 1) / COLUMN_GROUP) * COLUMN_GROUP_GAP;
const MATRIX_HEIGHT = MATRIX_ROWS * CELL_H;

/* -- deterministic layout -------------------------------------------------- */

/** mulberry32. Seeded so the field is byte-identical on every reload. */
function createRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface ProseCell {
  x: number;
  y: number;
  line: number;
}

/** Character cells of a wall of pasted text: ragged lines, word gaps, paragraph breaks. */
function buildProseCells(random: () => number): { cells: ProseCell[]; lineCount: number } {
  const cells: ProseCell[] = [];
  const left = -PROSE_WIDTH / 2;
  let y = 0;
  let line = 0;

  for (let block = 0; block < PROSE_BLOCKS; block += 1) {
    const lines = 5 + Math.floor(random() * 6);
    for (let l = 0; l < lines; l += 1) {
      // A paragraph last line is short; the rest run nearly full width.
      const fill = l === lines - 1 ? 0.25 + random() * 0.4 : 0.82 + random() * 0.18;
      // Alternate blocks are indented, as a constraints or examples section would be.
      const indent = block % 2 === 1 ? PROSE_CHAR_ADVANCE * 4 : 0;
      const end = left + PROSE_WIDTH * fill;
      let x = left + indent;

      while (x < end) {
        const wordLength = 2 + Math.floor(random() * 8);
        for (let c = 0; c < wordLength && x < end; c += 1) {
          cells.push({ x, y, line });
          x += PROSE_CHAR_ADVANCE;
        }
        // Word gap, occasionally doubled for a sentence break.
        x += PROSE_CHAR_ADVANCE * (random() < 0.12 ? 2 : 1);
      }
      y -= PROSE_LINE_HEIGHT;
      line += 1;
    }
    y -= PROSE_LINE_HEIGHT * PROSE_PARAGRAPH_GAP;
  }

  // Centre the block vertically about the origin.
  const offset = -y / 2 - PROSE_LINE_HEIGHT / 2;
  for (const cell of cells) cell.y += offset;

  return { cells, lineCount: Math.max(line, 2) };
}

/** Horizontal offset of a matrix column, including gutter and byte-group gaps. */
function matrixColumnX(col: number): number {
  const groups = col >= GUTTER_COLS ? Math.floor((col - GUTTER_COLS) / COLUMN_GROUP) : 0;
  return (
    col * CELL_W +
    (col >= GUTTER_COLS ? GUTTER_GAP : 0) +
    groups * COLUMN_GROUP_GAP -
    MATRIX_WIDTH / 2
  );
}

function cellRole(row: number, col: number): number {
  if (col < GUTTER_COLS) return ROLE_GUTTER;
  if (row >= VISIBLE_ROWS) return ROLE_HIDDEN;
  if (col >= MATRIX_COLS - VERDICT_COLS) return ROLE_VERDICT;
  return ROLE_BODY;
}

interface FieldBuffers {
  prose: Float32Array;
  matrix: Float32Array;
  seed: Float32Array;
  intensity: Float32Array;
}

/**
 * Fills every attribute once, from a useMemo, never per frame.
 * Total cost is ~720KB of Float32Array for 16384 points.
 */
function buildField(seedValue: number): FieldBuffers {
  const random = createRandom(seedValue);
  const { cells, lineCount } = buildProseCells(random);

  const prose = new Float32Array(PARTICLE_COUNT * 3);
  const matrix = new Float32Array(PARTICLE_COUNT * 3);
  // x stagger, y weight, z drift phase, w role
  const seed = new Float32Array(PARTICLE_COUNT * 4);
  const intensity = new Float32Array(PARTICLE_COUNT);

  // Per-cell density, so the matrix carries data texture instead of reading as a flat lattice.
  const cellIntensity = new Float32Array(MATRIX_ROWS * MATRIX_COLS);
  for (let i = 0; i < cellIntensity.length; i += 1) {
    const r = random();
    // Skewed low: most cells are quiet, a minority are dense.
    cellIntensity[i] = r * r * 0.75 + 0.1;
  }

  for (let i = 0; i < PARTICLE_COUNT; i += 1) {
    /* prose — even distribution across character cells in reading order */
    const cell = cells[Math.floor((i * cells.length) / PARTICLE_COUNT)];
    const p3 = i * 3;
    prose[p3] = cell.x + (random() - 0.5) * PROSE_JITTER_X;
    prose[p3 + 1] = cell.y + (random() - 0.5) * PROSE_JITTER_Y;
    prose[p3 + 2] = PROSE_Z_FAR + random() * (PROSE_Z_NEAR - PROSE_Z_FAR);

    /* matrix — row-major, so reading order is preserved across both formations */
    const cellIndex = Math.floor(i / CELL_POINTS);
    const sub = i % CELL_POINTS;
    const row = Math.floor(cellIndex / MATRIX_COLS);
    const col = cellIndex % MATRIX_COLS;
    const sx =
      ((sub % CELL_SUBDIV) - (CELL_SUBDIV - 1) / 2) *
      ((CELL_W * CELL_FILL_X) / (CELL_SUBDIV - 1));
    const sy =
      (Math.floor(sub / CELL_SUBDIV) - (CELL_SUBDIV - 1) / 2) *
      ((CELL_H * CELL_FILL_Y) / (CELL_SUBDIV - 1));

    matrix[p3] = matrixColumnX(col) + CELL_W / 2 + sx + (random() - 0.5) * MATRIX_JITTER;
    matrix[p3 + 1] =
      MATRIX_HEIGHT / 2 - row * CELL_H - CELL_H / 2 + sy + (random() - 0.5) * MATRIX_JITTER;
    matrix[p3 + 2] = (random() - 0.5) * MATRIX_Z_JITTER;

    /* per-particle constants */
    const s4 = i * 4;
    // Stagger follows the source line, which is also the target row.
    seed[s4] = Math.min(1, Math.max(0, cell.line / (lineCount - 1) + (random() - 0.5) * 0.1));
    seed[s4 + 1] = random();
    seed[s4 + 2] = random();
    seed[s4 + 3] = cellRole(row, col);

    intensity[i] = cellIntensity[cellIndex];
  }

  return { prose, matrix, seed, intensity };
}

/* -- shaders --------------------------------------------------------------- */

const VERTEX_SHADER = /* glsl */ `
uniform float uProgress;
uniform float uTime;
uniform float uPointSize;
uniform float uOpacity;
uniform vec2  uDepthFade;
uniform vec3  uBodyColor;
uniform vec3  uAccentColor;

attribute vec3  aMatrix;
attribute vec4  aSeed;
attribute float aIntensity;

varying vec3  vColor;
varying float vAlpha;

const float STAGGER_SPAN = ${STAGGER_SPAN.toFixed(3)};
const float TAU = 6.2831853;

float ramp(float t, float a, float b) {
  return smoothstep(0.0, 1.0, clamp((t - a) / (b - a), 0.0, 1.0));
}

void main() {
  // Per-particle local time. aSeed.x is the source line, so structure resolves
  // top-to-bottom in the order a parser would read it.
  float local = clamp((uProgress - aSeed.x * STAGGER_SPAN) / (1.0 - STAGGER_SPAN), 0.0, 1.0);

  // Axis-staggered interpolation: columns align, then rows lock, then depth
  // collapses. The overlap between the windows is what reads as parsing.
  float tx = ramp(local, 0.00, 0.58);
  float ty = ramp(local, 0.22, 0.92);
  float tz = ramp(local, 0.38, 1.00);

  vec3 pos = vec3(
    mix(position.x, aMatrix.x, tx),
    mix(position.y, aMatrix.y, ty),
    mix(position.z, aMatrix.z, tz)
  );

  // Entropy falls as the specification resolves: the field breathes, the
  // matrix is nearly still.
  float calm = mix(1.0, 0.12, tz);
  float phase = aSeed.z * TAU;
  pos += vec3(
    sin(uTime * 0.21 + phase),
    cos(uTime * 0.17 + phase * 1.31),
    sin(uTime * 0.13 + phase * 0.77)
  ) * (0.034 * calm);

  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = uPointSize;

  // Roles only carry meaning once the matrix exists.
  float settled = ramp(local, 0.55, 1.00);
  float role = aSeed.w;
  float isGutter  = step(0.5, role) * (1.0 - step(1.5, role));
  float isVerdict = step(1.5, role) * (1.0 - step(2.5, role));
  float isHidden  = step(2.5, role);

  vColor = mix(uBodyColor, uAccentColor, isVerdict * settled);

  float proseAlpha  = 0.20 + aSeed.y * 0.38;
  float matrixAlpha = (0.16 + aIntensity * 0.64)
                    * mix(1.0, 0.50, isGutter)
                    * mix(1.0, 0.38, isHidden);

  float alpha = mix(proseAlpha, matrixAlpha, settled);
  // Depth cue without fog. It fades out along with the depth spread itself,
  // which is the point: a resolved specification is flat.
  alpha *= 1.0 - 0.45 * clamp((-mv.z - uDepthFade.x) / uDepthFade.y, 0.0, 1.0);

  vAlpha = alpha * uOpacity;
}
`;

const FRAGMENT_SHADER = /* glsl */ `
varying vec3  vColor;
varying float vAlpha;

void main() {
  // Hard-edged square points. No radial falloff, because a soft sprite reads as
  // glow and this is meant to read as data.
  gl_FragColor = vec4(vColor, vAlpha);
  #include <colorspace_fragment>
}
`;

/* -- reduced motion -------------------------------------------------------- */

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
let reducedMotionQuery: MediaQueryList | null = null;

function getReducedMotionQuery(): MediaQueryList | null {
  if (typeof window === "undefined") return null;
  reducedMotionQuery ??= window.matchMedia(REDUCED_MOTION_QUERY);
  return reducedMotionQuery;
}

function subscribeReducedMotion(onChange: () => void): () => void {
  const query = getReducedMotionQuery();
  if (!query) return () => {};
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

const getReducedMotionSnapshot = () => getReducedMotionQuery()?.matches ?? false;
/** Server and hydration render assume motion is allowed; React re-reads immediately after. */
const getReducedMotionServerSnapshot = () => false;

function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    getReducedMotionSnapshot,
    getReducedMotionServerSnapshot,
  );
}

/* -- scene contents -------------------------------------------------------- */

interface FieldProps {
  state: ExecutionFieldState;
  reducedMotion: boolean;
  opacity: number;
  onSettled?: () => void;
}

function Field({ state, reducedMotion, opacity, onSettled }: FieldProps) {
  const materialRef = useRef<THREE.ShaderMaterial>(null);
  /** The single animated value. Never React state — it changes every frame. */
  const progress = useRef({ value: state === "idle" ? 0 : 1 });
  const elapsed = useRef(0);

  const reducedMotionRef = useRef(reducedMotion);
  reducedMotionRef.current = reducedMotion;
  const onSettledRef = useRef(onSettled);
  onSettledRef.current = onSettled;

  const buffers = useMemo(() => buildField(0x5eed1eaf), []);

  const uniforms = useMemo(
    () => ({
      uProgress: new THREE.Uniform(0),
      uTime: new THREE.Uniform(0),
      uPointSize: new THREE.Uniform(POINT_SIZE_CSS_PX),
      uOpacity: new THREE.Uniform(1),
      uDepthFade: new THREE.Uniform(
        new THREE.Vector2(CAMERA_Z - PROSE_Z_NEAR, PROSE_Z_NEAR - PROSE_Z_FAR),
      ),
      uBodyColor: new THREE.Uniform(new THREE.Color(BODY_COLOR)),
      uAccentColor: new THREE.Uniform(new THREE.Color(ACCENT_COLOR)),
    }),
    [],
  );

  const dpr = useThree((s) => s.viewport.dpr);
  const viewportWidth = useThree((s) => s.viewport.width);
  const invalidate = useThree((s) => s.invalidate);

  /** Keep the bounded matrix inside the frame at every supported width. */
  const scale = useMemo(
    () => Math.min(1, Math.max(0.55, viewportWidth / (MATRIX_WIDTH * 1.25))),
    [viewportWidth],
  );

  useEffect(() => {
    uniforms.uPointSize.value = POINT_SIZE_CSS_PX * dpr;
    uniforms.uOpacity.value = opacity;
    invalidate();
  }, [dpr, opacity, uniforms, invalidate]);

  useEffect(() => {
    const target = state === "idle" ? 0 : 1;
    const value = progress.current;

    // Reduced motion, or a remount straight into a settled state: jump, paint
    // once, animate nothing.
    if (reducedMotion || state !== "building") {
      value.value = target;
      uniforms.uProgress.value = target;
      uniforms.uTime.value = 0;
      invalidate();
      if (reducedMotion && state === "building") onSettledRef.current?.();
      return;
    }

    // gsap.context so StrictMode mount/unmount/mount fully reverts the first
    // pass; overwrite so a state change mid-morph replaces rather than stacks.
    const ctx = gsap.context(() => {
      gsap.to(value, {
        value: target,
        duration: MORPH_MS / 1000,
        // Linear on purpose: all shaping lives in the shader per-particle
        // smoothstep windows, and easing both would read as mush.
        ease: "none",
        overwrite: true,
        onComplete: () => onSettledRef.current?.(),
      });
    });
    return () => ctx.revert();
  }, [state, reducedMotion, uniforms, invalidate]);

  useFrame((_, delta) => {
    const material = materialRef.current;
    if (!material) return;
    // Frozen clock under reduced motion, so the single frame is deterministic.
    elapsed.current = reducedMotionRef.current ? 0 : elapsed.current + delta;
    material.uniforms.uTime.value = elapsed.current;
    material.uniforms.uProgress.value = progress.current.value;
  });

  return (
    <group scale={scale}>
      <points frustumCulled={false}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[buffers.prose, 3]} />
          <bufferAttribute attach="attributes-aMatrix" args={[buffers.matrix, 3]} />
          <bufferAttribute attach="attributes-aSeed" args={[buffers.seed, 4]} />
          <bufferAttribute attach="attributes-aIntensity" args={[buffers.intensity, 1]} />
        </bufferGeometry>
        <shaderMaterial
          ref={materialRef}
          uniforms={uniforms}
          vertexShader={VERTEX_SHADER}
          fragmentShader={FRAGMENT_SHADER}
          transparent
          depthWrite={false}
          depthTest={false}
          // Normal, not additive: additive turns every overlap into a hotspot,
          // which is exactly the glow this product is not.
          blending={THREE.NormalBlending}
        />
      </points>
    </group>
  );
}

/** Keeps a lost WebGL context from leaving a silent black rectangle. */
function ContextLossGuard() {
  const canvas = useThree((s) => s.gl.domElement);

  useEffect(() => {
    const onLost = (event: Event) => {
      // preventDefault is what allows the browser to restore the context.
      event.preventDefault();
      console.warn("[ExecutionField] WebGL context lost; awaiting restore.");
    };
    canvas.addEventListener("webglcontextlost", onLost);
    return () => canvas.removeEventListener("webglcontextlost", onLost);
  }, [canvas]);

  return null;
}

/* -- component ------------------------------------------------------------- */

/**
 * The AnyLeet signature visualisation. Decorative and non-interactive: it fills
 * its nearest positioned ancestor and never receives pointer events.
 */
export default function ExecutionField({
  state = "idle",
  onSettled,
  opacity = 1,
  className,
}: ExecutionFieldProps) {
  const reducedMotion = usePrefersReducedMotion();

  return (
    <div
      aria-hidden="true"
      className={className}
      style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
    >
      <Canvas
        // Clamped so a 3x phone or a 4K display cannot quadruple the fill cost.
        dpr={[1, 2]}
        // Reduced motion never runs a loop; frames are drawn only when asked for.
        frameloop={reducedMotion ? "demand" : "always"}
        camera={{ position: [0, 0, CAMERA_Z], fov: CAMERA_FOV, near: 0.1, far: 100 }}
        gl={{
          // Points are hard squares; MSAA buys nothing and costs fill rate.
          antialias: false,
          alpha: true,
          powerPreference: "low-power",
        }}
      >
        <ContextLossGuard />
        <Field
          state={state}
          reducedMotion={reducedMotion}
          opacity={opacity}
          onSettled={onSettled}
        />
      </Canvas>
    </div>
  );
}
