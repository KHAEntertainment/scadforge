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
    const actualDist = Math.hypot(
      decision!.position.x - decision!.target.x,
      decision!.position.y - decision!.target.y,
      decision!.position.z - decision!.target.z
    );
    expect(actualDist).toBeCloseTo(fitDistance, 5);
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

  it("scales clipping planes at least as generously as today when a kept pose is far from the model", () => {
    const userPose: CameraPose = {
      position: { x: 0, y: 0, z: 1200 },
      target: { x: 0, y: 0, z: 0 }
    };
    const decision = decideCameraPose({
      sphere: { center: { x: 0, y: 0, z: 0 }, radius: 20 },
      fovDeg: FOV_DEG,
      aspect: 1.5,
      state: { userMoved: true, pose: userPose }
    });
    expect(decision).not.toBeNull();
    expect(decision!.position).toEqual(userPose.position);
    expect(decision!.near).toBeCloseTo(1200 / 1000, 5);
    expect(decision!.far).toBeCloseTo(1200 * 10, 5);
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
  it("sets userMoved only on onUserStart, never on programmatic onControlsChange, and resets back to auto-framing", () => {
    const holder = createCameraPoseHolder();
    const initial = holder.resolveForGeometry(UNIT_SPHERE, FOV_DEG, 1.5, 0);
    expect(initial?.framed).toBe(true);
    expect(holder.userMoved).toBe(false);

    // Programmatic controls.update() emits change without start; must not mark userMoved.
    holder.onControlsChange({ position: { x: 10, y: 20, z: 30 }, target: { x: 0, y: 0, z: 0 } });
    expect(holder.userMoved).toBe(false);
    expect(holder.pose).toBeNull();

    // User drags (start -> change).
    const draggedPose: CameraPose = {
      position: { x: -90, y: 40, z: 75 },
      target: { x: 2, y: 3, z: 4 }
    };
    holder.onUserStart(initial!);
    holder.onControlsChange(draggedPose);
    expect(holder.userMoved).toBe(true);
    expect(holder.pose).toEqual(draggedPose);

    // Next mesh swap keeps dragged pose.
    const next = holder.resolveForGeometry({ center: { x: 1, y: 0, z: 0 }, radius: 52 }, FOV_DEG, 1.5, 0);
    expect(next?.framed).toBe(false);
    expect(next?.position).toEqual(draggedPose.position);
    expect(next?.target).toEqual(draggedPose.target);

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
    projectAHolder.onUserStart({ position: { x: -80, y: 20, z: 60 }, target: { x: 1, y: 2, z: 3 } });
    expect(projectAHolder.userMoved).toBe(true);

    const projectBHolder = createCameraPoseHolder();
    const projectBSphere: BoundingSphere = { center: { x: 10, y: 10, z: 10 }, radius: 40 };
    const decision = projectBHolder.resolveForGeometry(projectBSphere, FOV_DEG, 1.5, 0);
    expect(projectBHolder.userMoved).toBe(false);
    expect(decision?.framed).toBe(true);
    expect(decision?.target).toEqual(projectBSphere.center);
  });
});
