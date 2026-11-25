// SPDX-License-Identifier: Apache-2.0

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface BoundingSphere {
  center: Vec3;
  radius: number;
}

export interface CameraPose {
  position: Vec3;
  target: Vec3;
}

export interface CameraPoseState {
  userMoved: boolean;
  pose: CameraPose | null;
}

export interface CameraFramingInput {
  sphere: BoundingSphere | null;
  fovDeg: number;
  aspect?: number;
  state: CameraPoseState;
  reset?: boolean;
}

export interface CameraFramingDecision {
  position: Vec3;
  target: Vec3;
  near: number;
  far: number;
  framed: boolean;
}

export interface CameraApplyTarget {
  position: { set: (x: number, y: number, z: number) => unknown };
  near: number;
  far: number;
  updateProjectionMatrix: () => void;
  lookAt: (x: number, y: number, z: number) => void;
}

export interface ControlsApplyTarget {
  target: { set: (x: number, y: number, z: number) => unknown };
  enableDamping?: boolean;
  update: () => unknown;
}

/** Margin multiplier around the fitted sphere so the model does not touch viewport edges. */
export const FIT_MARGIN_FACTOR = 1.15;

/** Minimum projected diameter as a fraction of viewport height before a shrunk model counts as having left the view. */
export const MIN_VIEWPORT_FRACTION = 0.01;

/** Minimum forward depth (mm) for a sphere's far side to intersect the camera view frustum. */
export const FRUSTUM_MIN_DEPTH = 0;

/** Guard fallback viewport aspect ratio used only when camera aspect is missing or non-finite/non-positive. */
export const DEFAULT_FRUSTUM_ASPECT = 1;

/** Minimum camera position or target delta (mm) after `start` required to count as user camera movement. */
export const POSE_CHANGE_EPSILON = 1e-5;

/** Minimum non-zero vector length (mm) before a direction vector is treated as degenerate. */
const MIN_VECTOR_LENGTH = 1e-6;

/** Dot-product threshold above which a view ray is treated as collinear with world Y-up. */
const PARALLEL_UP_DOT = 0.999;

function length(v: Vec3): number {
  return Math.hypot(v.x, v.y, v.z);
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function scale(v: Vec3, s: number): Vec3 {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x
  };
}

function normalize(v: Vec3): Vec3 {
  const len = length(v);
  if (len <= 0 || !Number.isFinite(len)) return { x: 0, y: 0, z: 1 };
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

function cloneVec3(v: Vec3): Vec3 {
  return { x: v.x, y: v.y, z: v.z };
}

function clonePose(pose: CameraPose): CameraPose {
  return { position: cloneVec3(pose.position), target: cloneVec3(pose.target) };
}

function poseDiffers(a: CameraPose, b: CameraPose, epsilon: number): boolean {
  return length(sub(a.position, b.position)) > epsilon || length(sub(a.target, b.target)) > epsilon;
}

function resolveAspect(aspect: number | undefined): number {
  return aspect !== undefined && Number.isFinite(aspect) && aspect > 0 ? aspect : DEFAULT_FRUSTUM_ASPECT;
}

/** Fallback direction when framing a model for the first time or after reset. */
const DEFAULT_VIEW_DIRECTION: Vec3 = normalize({ x: 1, y: 0.8, z: 1 });

function hasLeftView(
  sphere: BoundingSphere,
  pose: CameraPose,
  fovRadians: number,
  safeAspect: number
): boolean {
  const viewOffset = sub(pose.target, pose.position);
  if (length(viewOffset) <= MIN_VECTOR_LENGTH) return true;

  const forward = normalize(viewOffset);
  const toCenter = sub(sphere.center, pose.position);
  const depth = dot(toCenter, forward);
  if (depth + sphere.radius <= FRUSTUM_MIN_DEPTH) return true;

  const tanHalfV = Math.tan(fovRadians / 2);
  const tanHalfH = tanHalfV * safeAspect;

  const worldUp: Vec3 = Math.abs(dot(forward, { x: 0, y: 1, z: 0 })) > PARALLEL_UP_DOT
    ? { x: 0, y: 0, z: -1 }
    : { x: 0, y: 1, z: 0 };
  const right = normalize(cross(forward, worldUp));
  const camUp = cross(right, forward);

  const x = Math.abs(dot(toCenter, right));
  const y = Math.abs(dot(toCenter, camUp));
  const hypV = Math.hypot(1, tanHalfV);
  const hypH = Math.hypot(1, tanHalfH);
  const outsideHorizontal = x * (1 / hypH) - depth * (tanHalfH / hypH) > sphere.radius;
  const outsideVertical = y * (1 / hypV) - depth * (tanHalfV / hypV) > sphere.radius;
  if (outsideHorizontal || outsideVertical) return true;

  if (depth <= FRUSTUM_MIN_DEPTH) return true;
  return sphere.radius < depth * tanHalfV * MIN_VIEWPORT_FRACTION;
}

/**
 * Decides the camera position, target, and clipping planes for a loaded mesh.
 * Frames along `(1, 0.8, 1)` initially and on reset; preserves the user's pose
 * across same-project mesh swaps unless the new bounding sphere leaves the view
 * or encloses the saved camera position.
 */
export function decideCameraPose(input: CameraFramingInput): CameraFramingDecision | null {
  const { sphere, fovDeg, aspect, state, reset = false } = input;
  if (!sphere || !Number.isFinite(sphere.radius) || sphere.radius <= 0) return null;

  const fovRadians = (fovDeg * Math.PI) / 180;
  const halfV = fovRadians / 2;
  const safeAspect = resolveAspect(aspect);
  const halfH = Math.atan(Math.tan(halfV) * safeAspect);
  const effectiveHalfAngle = Math.min(halfV, halfH);
  const sinHalf = Math.sin(effectiveHalfAngle);
  if (!Number.isFinite(sinHalf) || sinHalf <= 0) return null;

  const fitDistance = (sphere.radius / sinHalf) * FIT_MARGIN_FACTOR;

  if (reset || !state.userMoved || !state.pose) {
    const target = cloneVec3(sphere.center);
    const position = add(target, scale(DEFAULT_VIEW_DIRECTION, fitDistance));
    return {
      position,
      target,
      near: Math.max(fitDistance / 1000, 0.01),
      far: fitDistance * 10,
      framed: true
    };
  }

  const saved = state.pose;
  const viewOffset = sub(saved.position, saved.target);
  const viewDir = length(viewOffset) > MIN_VECTOR_LENGTH ? normalize(viewOffset) : DEFAULT_VIEW_DIRECTION;
  const distToCenter = length(sub(saved.position, sphere.center));
  const cameraInsideSphere = distToCenter <= sphere.radius;

  if (cameraInsideSphere || hasLeftView(sphere, saved, fovRadians, safeAspect)) {
    const target = cloneVec3(sphere.center);
    const position = add(target, scale(viewDir, fitDistance));
    return {
      position,
      target,
      near: Math.max(fitDistance / 1000, 0.01),
      far: fitDistance * 10,
      framed: false
    };
  }

  return {
    position: cloneVec3(saved.position),
    target: cloneVec3(saved.target),
    near: Math.max(Math.min(fitDistance, distToCenter) / 1000, 0.01),
    far: Math.max(fitDistance, distToCenter) * 10,
    framed: false
  };
}

/**
 * Applies a camera framing decision to a perspective camera and orbit controls.
 * Temporarily turns damping off for one `controls.update()` before writing the
 * decision pose so pending orbit, pan, and dolly inertia is flushed instead of
 * drifting the camera away after Fit or a programmatic pose update.
 */
export function applyCameraFramingDecision(
  camera: CameraApplyTarget,
  controls: ControlsApplyTarget | null,
  decision: CameraFramingDecision
): void {
  if (!controls) {
    camera.position.set(decision.position.x, decision.position.y, decision.position.z);
    camera.near = decision.near;
    camera.far = decision.far;
    camera.updateProjectionMatrix();
    camera.lookAt(decision.target.x, decision.target.y, decision.target.z);
    return;
  }

  const hasDampingProp = "enableDamping" in controls;
  const wasDamping = controls.enableDamping;
  if (hasDampingProp) {
    controls.enableDamping = false;
  }
  try {
    // Public-API inertia flush: update() with enableDamping=false zeroes sphericalDelta, panOffset, and scale.
    controls.update();

    camera.position.set(decision.position.x, decision.position.y, decision.position.z);
    camera.near = decision.near;
    camera.far = decision.far;
    camera.updateProjectionMatrix();
    camera.lookAt(decision.target.x, decision.target.y, decision.target.z);

    controls.target.set(decision.target.x, decision.target.y, decision.target.z);
    controls.update();
  } finally {
    if (hasDampingProp) {
      controls.enableDamping = wasDamping;
    }
  }
}

export interface CameraPoseHolder {
  readonly userMoved: boolean;
  readonly pose: CameraPose | null;
  onUserStart: (currentPose?: CameraPose) => void;
  onControlsChange: (currentPose: CameraPose) => void;
  onUserEnd: (currentPose?: CameraPose) => void;
  resolveForGeometry: (
    sphere: BoundingSphere | null,
    fovDeg: number,
    aspect?: number,
    fitNonce?: number
  ) => CameraFramingDecision | null;
}

/** Holds per-viewer camera state across `<Canvas>` remounts within one project. */
export function createCameraPoseHolder(): CameraPoseHolder {
  let userMoved = false;
  let pose: CameraPose | null = null;
  let armed = false;
  let startPose: CameraPose | null = null;
  let lastFitNonce = 0;

  return {
    get userMoved() {
      return userMoved;
    },
    get pose() {
      return pose ? clonePose(pose) : null;
    },
    onUserStart(currentPose?: CameraPose) {
      armed = true;
      startPose = currentPose ? clonePose(currentPose) : null;
    },
    onControlsChange(currentPose: CameraPose) {
      if (userMoved) {
        pose = clonePose(currentPose);
        return;
      }
      if (!armed) return;
      if (!startPose) {
        startPose = clonePose(currentPose);
        return;
      }
      if (poseDiffers(startPose, currentPose, POSE_CHANGE_EPSILON)) {
        userMoved = true;
        armed = false;
        startPose = null;
        pose = clonePose(currentPose);
      }
    },
    onUserEnd(currentPose?: CameraPose) {
      if (userMoved && currentPose) {
        pose = clonePose(currentPose);
      }
    },
    resolveForGeometry(
      sphere: BoundingSphere | null,
      fovDeg: number,
      aspect?: number,
      fitNonce = lastFitNonce
    ): CameraFramingDecision | null {
      const reset = fitNonce !== lastFitNonce;
      if (reset) {
        lastFitNonce = fitNonce;
        userMoved = false;
        pose = null;
        armed = false;
        startPose = null;
      }
      const prevPose = pose;
      const decision = decideCameraPose({
        sphere,
        fovDeg,
        aspect,
        state: { userMoved, pose },
        reset
      });
      if (!decision) return null;
      const reframedByCode = reset || decision.framed || !prevPose || poseDiffers(prevPose, decision, 0);
      if (reframedByCode) {
        armed = false;
        startPose = null;
      }
      if (userMoved && !reset) {
        pose = { position: cloneVec3(decision.position), target: cloneVec3(decision.target) };
      }
      return decision;
    }
  };
}
