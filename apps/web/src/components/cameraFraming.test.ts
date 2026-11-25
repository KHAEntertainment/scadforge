// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  createCameraPoseHolder,
  decideCameraPose,
  FIT_MARGIN_FACTOR,
  type BoundingSphere,
  type CameraPose
} from "./cameraFraming.js";

const UNIT_SPHERE: BoundingSphere = { center: { x: 0, y: 0, z: 0 }, radius: 50 };
const FOV_DEG = 45;

function viewDirection(pose: CameraPose) {
  const dx = pose.position.x - pose.target.x;
  const dy = pose.position.y - pose.target.y;
  const dz = pose.position.z - pose.target.z;
  const len = Math.hypot(dx, dy, dz);
  return { x: dx / len, y: dy / len, z: dz / len };
}

function distanceBetween(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

describe("decideCameraPose", () => {
  it("frames the first mesh along (1, 0.8, 1) with model-scaled clipping planes", () => {
    const decision = decideCameraPose({
      sphere: UNIT_SPHERE,
      fovDeg: FOV_DEG,
      aspect: 1.5,
      state: { userMoved: false, pose: null }
    });
    expect(decision).not.toBeNull();
    expect(decision!.framed).toBe(true);
    expect(decision!.target).toEqual({ x: 0, y: 0, z: 0 });
    const dir = viewDirection(decision!);
    const expectedLen = Math.hypot(1, 0.8, 1);
    expect(dir.x).toBeCloseTo(1 / expectedLen, 5);
    expect(dir.y).toBeCloseTo(0.8 / expectedLen, 5);
    expect(dir.z).toBeCloseTo(1 / expectedLen, 5);
    const fitDistance = (UNIT_SPHERE.radius / Math.sin((FOV_DEG * Math.PI) / 360)) * FIT_MARGIN_FACTOR;
    expect(decision!.near).toBeCloseTo(Math.max(fitDistance / 1000, 0.01), 5);
    expect(decision!.far).toBeCloseTo(fitDistance * 10, 5);
  });

  it("matches today's vertical fitDistance exactly when aspect is >= 1 (tested at 1.2 and 2)", () => {
    const expectedFit = (UNIT_SPHERE.radius / Math.sin((FOV_DEG * Math.PI) / 360)) * FIT_MARGIN_FACTOR;
    for (const aspect of [1.2, 2]) {
      const decision = decideCameraPose({
        sphere: UNIT_SPHERE,
        fovDeg: FOV_DEG,
        aspect,
        state: { userMoved: false, pose: null }
      });
      expect(decision).not.toBeNull();
      expect(distanceBetween(decision!.position, decision!.target)).toBeCloseTo(expectedFit, 8);
    }
  });

  it("fits against the horizontal half-angle in a portrait viewer (aspect 0.5) so the model is not clipped sideways", () => {
    const userPose: CameraPose = {
      position: { x: 0, y: 0, z: 150 },
      target: { x: 0, y: 0, z: 0 }
    };
    const farOffSphere: BoundingSphere = { center: { x: 500, y: 0, z: 0 }, radius: 20 };
    const decision = decideCameraPose({
      sphere: farOffSphere,
      fovDeg: FOV_DEG,
      aspect: 0.5,
      state: { userMoved: true, pose: userPose }
    });
    expect(decision).not.toBeNull();
    const halfV = (FOV_DEG * Math.PI) / 360;
    const halfH = Math.atan(Math.tan(halfV) * 0.5);
    const expectedHorizontalFit = (farOffSphere.radius / Math.sin(halfH)) * FIT_MARGIN_FACTOR;
    const dist = distanceBetween(decision!.position, decision!.target);
    expect(dist).toBeGreaterThan(98.62);
    expect(dist).toBeCloseTo(expectedHorizontalFit, 5);
  });

  it("keeps a portrait pose when the sphere just fits horizontally and reframes to fit horizontally when just outside", () => {
    const userPose: CameraPose = {
      position: { x: 0, y: 0, z: 100 },
      target: { x: 0, y: 0, z: 0 }
    };
    const radius = 20;
    const aspect = 0.5;
    const halfV = (FOV_DEG * Math.PI) / 360;
    const tanHalfH = Math.tan(halfV) * aspect;
    const hypH = Math.hypot(1, tanHalfH);
    const boundaryX = 100 * tanHalfH + radius * hypH;

    const justInside = decideCameraPose({
      sphere: { center: { x: boundaryX - 0.01, y: 0, z: 0 }, radius },
      fovDeg: FOV_DEG,
      aspect,
      state: { userMoved: true, pose: userPose }
    });
    expect(justInside!.position).toEqual(userPose.position);

    const justOutside = decideCameraPose({
      sphere: { center: { x: boundaryX + 0.01, y: 0, z: 0 }, radius },
      fovDeg: FOV_DEG,
      aspect,
      state: { userMoved: true, pose: userPose }
    });
    const halfH = Math.atan(tanHalfH);
    const dist = distanceBetween(justOutside!.position, justOutside!.target);
    expect(dist * Math.sin(halfH)).toBeGreaterThan(radius);
    expect(dist).toBeCloseTo((radius / Math.sin(halfH)) * FIT_MARGIN_FACTOR, 5);
  });

  it("keeps the user-moved camera position, view direction, and orbit target across a mesh swap", () => {
    const userPose: CameraPose = {
      position: { x: -120, y: 35, z: 90 },
      target: { x: 4, y: -6, z: 12 }
    };
    const nextSphere: BoundingSphere = { center: { x: 2, y: 0, z: 0 }, radius: 55 };
    const decision = decideCameraPose({
      sphere: nextSphere,
      fovDeg: FOV_DEG,
      aspect: 1.5,
      state: { userMoved: true, pose: userPose }
    });
    expect(decision).not.toBeNull();
    expect(decision!.framed).toBe(false);
    expect(decision!.position).toEqual(userPose.position);
    expect(decision!.target).toEqual(userPose.target);
    expect(viewDirection(decision!)).toEqual(viewDirection(userPose));
  });

  it("counterexample: when the user has NOT moved the camera, a mesh swap re-frames on the new model", () => {
    const shifted: BoundingSphere = { center: { x: 100, y: 20, z: -30 }, radius: 80 };
    const decision = decideCameraPose({
      sphere: shifted,
      fovDeg: FOV_DEG,
      aspect: 1.5,
      state: { userMoved: false, pose: { position: { x: 80, y: 80, z: 80 }, target: { x: 0, y: 0, z: 0 } } }
    });
    expect(decision).not.toBeNull();
    expect(decision!.framed).toBe(true);
    expect(decision!.target).toEqual(shifted.center);
  });

  it("keeps view direction, centres target, and sets fitDistance when the new mesh moves outside the view frustum", () => {
    const userPose: CameraPose = {
      position: { x: 0, y: 0, z: 150 },
      target: { x: 0, y: 0, z: 0 }
    };
    const farOffSphere: BoundingSphere = { center: { x: 500, y: 0, z: 0 }, radius: 20 };
    const decision = decideCameraPose({
      sphere: farOffSphere,
      fovDeg: FOV_DEG,
      aspect: 1.2,
      state: { userMoved: true, pose: userPose }
    });
    expect(decision).not.toBeNull();
    expect(decision!.target).toEqual(farOffSphere.center);
    expect(viewDirection(decision!).x).toBeCloseTo(0, 5);
    expect(viewDirection(decision!).y).toBeCloseTo(0, 5);
    expect(viewDirection(decision!).z).toBeCloseTo(1, 5);
    const fitDistance = (farOffSphere.radius / Math.sin((FOV_DEG * Math.PI) / 360)) * FIT_MARGIN_FACTOR;
    expect(distanceBetween(decision!.position, decision!.target)).toBeCloseTo(fitDistance, 5);
  });

  it("keeps view direction, centres target, and sets fitDistance when the new mesh shrinks below 1% of viewport height", () => {
    const userPose: CameraPose = {
      position: { x: 0, y: 200, z: 0 },
      target: { x: 0, y: 0, z: 0 }
    };
    const tinySphere: BoundingSphere = { center: { x: 0, y: 0, z: 0 }, radius: 0.2 };
    const decision = decideCameraPose({
      sphere: tinySphere,
      fovDeg: FOV_DEG,
      aspect: 1.5,
      state: { userMoved: true, pose: userPose }
    });
    expect(decision).not.toBeNull();
    expect(decision!.target).toEqual(tinySphere.center);
    expect(viewDirection(decision!).y).toBeCloseTo(1, 5);
    const fitDistance = (tinySphere.radius / Math.sin((FOV_DEG * Math.PI) / 360)) * FIT_MARGIN_FACTOR;
    expect(decision!.position.y).toBeCloseTo(fitDistance, 5);
  });

  it("keeps view direction, centres target, and sets fitDistance when the saved camera position is inside the new bounding sphere", () => {
    const userPose: CameraPose = {
      position: { x: 0, y: 0, z: 120 },
      target: { x: 0, y: 0, z: 0 }
    };
    const hugeSphere: BoundingSphere = { center: { x: 0, y: 0, z: 0 }, radius: 200 };
    const decision = decideCameraPose({
      sphere: hugeSphere,
      fovDeg: FOV_DEG,
      aspect: 1.5,
      state: { userMoved: true, pose: userPose }
    });
    expect(decision).not.toBeNull();
    expect(decision!.target).toEqual(hugeSphere.center);
    expect(viewDirection(decision!).z).toBeCloseTo(1, 5);
    const fitDistance = (hugeSphere.radius / Math.sin((FOV_DEG * Math.PI) / 360)) * FIT_MARGIN_FACTOR;
    expect(decision!.position.z).toBeCloseTo(fitDistance, 5);
  });

  it("keeps near no larger and far no smaller than pre-PR when a kept pose is far from the model", () => {
    const sphere: BoundingSphere = { center: { x: 0, y: 0, z: 0 }, radius: 20 };
    const userPose: CameraPose = {
      position: { x: 0, y: 0, z: 1200 },
      target: { x: 0, y: 0, z: 0 }
    };
    const fitDistance = (sphere.radius / Math.sin((FOV_DEG * Math.PI) / 360)) * FIT_MARGIN_FACTOR;
    const prePrNear = Math.max(fitDistance / 1000, 0.01);
    const prePrFar = fitDistance * 10;

    const decision = decideCameraPose({
      sphere,
      fovDeg: FOV_DEG,
      aspect: 1.5,
      state: { userMoved: true, pose: userPose }
    });
    expect(decision).not.toBeNull();
    expect(decision!.position).toEqual(userPose.position);
    expect(decision!.near).toBeLessThanOrEqual(prePrNear + 1e-9);
    expect(decision!.near).toBeCloseTo(prePrNear, 5);
    expect(decision!.far).toBeGreaterThanOrEqual(prePrFar - 1e-9);
    expect(decision!.far).toBeCloseTo(1200 * 10, 5);
  });

  it("keeps near no larger and far no smaller than pre-PR when a kept pose is closer than fitDistance", () => {
    const sphere: BoundingSphere = { center: { x: 0, y: 0, z: 0 }, radius: 50 };
    const closeD = 60;
    const userPose: CameraPose = {
      position: { x: 0, y: 0, z: closeD },
      target: { x: 0, y: 0, z: 0 }
    };
    const fitDistance = (sphere.radius / Math.sin((FOV_DEG * Math.PI) / 360)) * FIT_MARGIN_FACTOR;
    const prePrNear = Math.max(fitDistance / 1000, 0.01);
    const prePrFar = fitDistance * 10;

    const decision = decideCameraPose({
      sphere,
      fovDeg: FOV_DEG,
      aspect: 1.5,
      state: { userMoved: true, pose: userPose }
    });
    expect(decision).not.toBeNull();
    expect(decision!.position).toEqual(userPose.position);
    expect(decision!.near).toBeLessThanOrEqual(prePrNear);
    expect(decision!.near).toBeCloseTo(Math.max(closeD / 1000, 0.01), 5);
    expect(decision!.far).toBeGreaterThanOrEqual(prePrFar);
    expect(decision!.far).toBeCloseTo(prePrFar, 5);
  });

  it("re-frames on reset even when userMoved is true", () => {
    const userPose: CameraPose = {
      position: { x: -100, y: 10, z: 50 },
      target: { x: 5, y: 5, z: 5 }
    };
    const decision = decideCameraPose({
      sphere: UNIT_SPHERE,
      fovDeg: FOV_DEG,
      aspect: 1.5,
      state: { userMoved: true, pose: userPose },
      reset: true
    });
    expect(decision).not.toBeNull();
    expect(decision!.framed).toBe(true);
    expect(decision!.target).toEqual(UNIT_SPHERE.center);
  });
});

describe("createCameraPoseHolder", () => {
  it("does not set userMoved on a plain click (start then end with no pose change) or on change without start", () => {
    const holder = createCameraPoseHolder();
    const initial = holder.resolveForGeometry(UNIT_SPHERE, FOV_DEG, 1.5, 0);
    expect(initial?.framed).toBe(true);
    const startPose: CameraPose = { position: initial!.position, target: initial!.target };

    // Programmatic controls.update() emits change without start; must not mark userMoved.
    holder.onControlsChange({ position: { x: 10, y: 20, z: 30 }, target: { x: 0, y: 0, z: 0 } });
    expect(holder.userMoved).toBe(false);
    expect(holder.pose).toBeNull();

    // Plain click: start -> (optional unchanged change) -> end.
    holder.onUserStart(startPose);
    holder.onControlsChange(startPose);
    holder.onUserEnd(startPose);
    expect(holder.userMoved).toBe(false);
    expect(holder.pose).toBeNull();

    // Plain click without any change between start and end, followed by a post-end change.
    holder.onUserStart(startPose);
    holder.onUserEnd(startPose);
    holder.onControlsChange({ position: { x: 10, y: 20, z: 30 }, target: { x: 0, y: 0, z: 0 } });
    expect(holder.userMoved).toBe(false);
    expect(holder.pose).toBeNull();
  });

  it("sets userMoved on the first changed pose after start, keeps updating through damping after end, and resets on fitNonce", () => {
    const holder = createCameraPoseHolder();
    const initial = holder.resolveForGeometry(UNIT_SPHERE, FOV_DEG, 1.5, 0)!;
    const startPose: CameraPose = { position: initial.position, target: initial.target };

    // User drags (start -> change -> end -> post-end damping change).
    const draggedPose: CameraPose = {
      position: { x: -90, y: 40, z: 75 },
      target: { x: 2, y: 3, z: 4 }
    };
    const dampedPose: CameraPose = {
      position: { x: -95, y: 42, z: 72 },
      target: { x: 2, y: 3, z: 4 }
    };
    holder.onUserStart(startPose);
    holder.onControlsChange(draggedPose);
    expect(holder.userMoved).toBe(true);
    expect(holder.pose).toEqual(draggedPose);
    holder.onUserEnd(draggedPose);
    holder.onControlsChange(dampedPose);
    expect(holder.pose).toEqual(dampedPose);

    // Next mesh swap keeps settled damped pose.
    const next = holder.resolveForGeometry({ center: { x: 1, y: 0, z: 0 }, radius: 52 }, FOV_DEG, 1.5, 0);
    expect(next?.framed).toBe(false);
    expect(next?.position).toEqual(dampedPose.position);
    expect(next?.target).toEqual(dampedPose.target);

    // Fit / reset clears userMoved so subsequent swaps frame again.
    const resetDecision = holder.resolveForGeometry(UNIT_SPHERE, FOV_DEG, 1.5, 1);
    expect(resetDecision?.framed).toBe(true);
    expect(holder.userMoved).toBe(false);

    const afterResetSwap = holder.resolveForGeometry({ center: { x: 20, y: 0, z: 0 }, radius: 50 }, FOV_DEG, 1.5, 1);
    expect(afterResetSwap?.framed).toBe(true);
    expect(afterResetSwap?.target).toEqual({ x: 20, y: 0, z: 0 });
  });

  it("frames a new project (fresh holder after PreviewTab remount) even after the previous project had a user-moved pose", () => {
    const projectAHolder = createCameraPoseHolder();
    const initialA = projectAHolder.resolveForGeometry(UNIT_SPHERE, FOV_DEG, 1.5, 0)!;
    projectAHolder.onUserStart({ position: initialA.position, target: initialA.target });
    projectAHolder.onControlsChange({ position: { x: -80, y: 20, z: 60 }, target: { x: 1, y: 2, z: 3 } });
    expect(projectAHolder.userMoved).toBe(true);

    const projectBHolder = createCameraPoseHolder();
    const projectBSphere: BoundingSphere = { center: { x: 10, y: 10, z: 10 }, radius: 40 };
    const decision = projectBHolder.resolveForGeometry(projectBSphere, FOV_DEG, 1.5, 0);
    expect(projectBHolder.userMoved).toBe(false);
    expect(decision?.framed).toBe(true);
    expect(decision?.target).toEqual(projectBSphere.center);
  });
});
