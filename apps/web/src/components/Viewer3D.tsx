import { Component, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { Raycaster, Vector2, type Mesh, type BufferGeometry, type PerspectiveCamera } from "three";
import { DimensionOverlay, type MeasureFocus } from "./DimensionOverlay.js";
import { isValidBBox, type BBox } from "./measure.js";
import { inspectSurface } from "./inspect/surfaceRegion.js";
import { SurfaceHighlight } from "./inspect/SurfaceHighlight.js";
import { useStlGeometry } from "./useStlGeometry.js";
import { bindInspectionPointerEvents } from "./inspectionPointerEvents.js";
import type { InspectionOutcome } from "./inspect/inspectionTypes.js";
import {
  applyCameraFramingDecision,
  createCameraPoseHolder,
  type CameraPose,
  type CameraPoseHolder,
  type ControlsApplyTarget
} from "./cameraFraming.js";
export { isInspectClick } from "./inspectionPointerEvents.js";

export interface Viewer3DProps {
  /** HTTP path to the server-exported STL. `null` when no render has happened yet. */
  stlUrl: string | null;
  /**
   * Shown when `stlUrl` is null. The caller knows WHY there is no mesh —
   * nothing rendered yet, or this particular snapshot was never validated —
   * and a viewer that always says "send a message" is wrong in the second
   * case (Issue #41).
   */
  emptyMessage?: string;
  /** Show dimension brackets + mm labels derived from the displayed mesh. */
  measure?: boolean;
  /** Which axis's face-to-face measurement to focus; "all" shows all three dimensions equally. */
  measureAxis?: MeasureFocus;
  /**
   * Reports the displayed mesh's bounding box (plain data, mm) whenever a
   * mesh loads, and `null` when it unloads — lets DOM UI outside the canvas
   * (the measure readout) stay in sync with what is actually on screen.
   */
  onBoundingBox?: (box: BBox | null) => void;
  /**
   * Routes mesh clicks through surface inspection instead of leaving the
   * mesh inert. Off by default: with `inspect` off, no click handlers are
   * attached and no highlight renders — behavior is unchanged, and Measure
   * / FitCamera are unaffected either way. The toolbar toggle (ticket 5)
   * turns this on only in 3D view; the viewer itself never decides whether
   * inspecting is allowed (render-authority rule, CLAUDE.md rule 6).
   */
  inspect?: boolean;
  /**
   * Reports each inspection outcome, and `null` when the selection is
   * cleared — an empty-space click, Esc, a new mesh, `inspect` turning
   * off, or this viewer unmounting.
   */
  onInspect?: (outcome: InspectionOutcome | null) => void;
  /** Incrementing this token resets the user camera pose and re-frames on the model. */
  fitNonce?: number;
}

interface ControlsTargetLike {
  object?: { position?: { x: number; y: number; z: number } };
  target?: { x: number; y: number; z: number };
}

function readControlsPose(event?: { target?: unknown }): CameraPose | undefined {
  const ctrl = event?.target as ControlsTargetLike | undefined;
  const pos = ctrl?.object?.position;
  const tgt = ctrl?.target;
  if (!pos || !tgt) return undefined;
  return {
    position: { x: pos.x, y: pos.y, z: pos.z },
    target: { x: tgt.x, y: tgt.y, z: tgt.z }
  };
}

/**
 * Whether a keydown event should clear the current inspection selection.
 * Unit tests exercise this predicate; the native qualification walk
 * covers the real keyboard end to end.
 */
export function isEscapeKey(event: Pick<KeyboardEvent, "key">): boolean {
  return event.key === "Escape";
}

function ViewerPlaceholder({ message }: { message: string }) {
  return (
    <div className="viewer-placeholder" data-testid="viewer-placeholder">
      {message}
    </div>
  );
}

/**
 * The geometry hook forwards an asynchronous load failure to this
 * error boundary on the following render. This
 * boundary turns a failed/missing STL fetch into the same graceful
 * placeholder instead of crashing the viewer (Issue #18 self-check).
 */
class ViewerErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {
    // Swallow — surfaced via the placeholder render below, not the console.
  }

  render() {
    if (this.state.failed) {
      return <ViewerPlaceholder message="Couldn't load the model preview. The last valid render will show once available." />;
    }
    return this.props.children;
  }
}

/**
 * Frames the camera on the loaded mesh initially and on Fit reset (Issue #41, #164),
 * while preserving a user-adjusted pose across same-project mesh swaps.
 */
function FitCamera({
  geometry,
  cameraHolder,
  fitNonce,
  programmaticUpdateRef
}: {
  geometry: BufferGeometry;
  cameraHolder: CameraPoseHolder;
  fitNonce: number;
  programmaticUpdateRef: { current: boolean };
}) {
  const camera = useThree((state) => state.camera) as PerspectiveCamera;
  const controls = useThree((state) => state.controls) as ControlsApplyTarget | null;

  useEffect(() => {
    geometry.computeBoundingSphere();
    const sphere = geometry.boundingSphere;
    const decision = cameraHolder.resolveForGeometry(
      sphere ? { center: { x: sphere.center.x, y: sphere.center.y, z: sphere.center.z }, radius: sphere.radius } : null,
      camera.fov,
      camera.aspect,
      fitNonce
    );
    if (!decision) return;

    programmaticUpdateRef.current = true;
    try {
      applyCameraFramingDecision(camera, controls, decision);
    } finally {
      programmaticUpdateRef.current = false;
    }
  }, [geometry, camera, controls, cameraHolder, fitNonce, programmaticUpdateRef]);

  return null;
}

interface StlMeshProps {
  geometry: BufferGeometry;
  cameraHolder: CameraPoseHolder;
  fitNonce: number;
  programmaticUpdateRef: { current: boolean };
  measure?: boolean;
  measureAxis?: MeasureFocus;
  onBoundingBox?: (box: BBox | null) => void;
  inspect?: boolean;
  /** The current inspection outcome, owned by `Viewer3D` so empty-canvas gestures can clear it too. */
  outcome?: InspectionOutcome | null;
  /** A mesh click that passed the click-vs-drag check, with a hit triangle. */
  onSurfaceClick?: (geometry: BufferGeometry, faceIndex: number) => void;
  /** Fires once per loaded geometry (including the first), so any prior selection is dropped when the mesh changes underneath it. */
  onGeometryChange?: () => void;
  onEmptyClick: () => void;
}

/** Keep pending feedback in the DOM until the active request publishes a mesh. */
export function StlModel({ url, children }: { url: string; children: (geometry: BufferGeometry) => ReactNode }) {
  const geometry = useStlGeometry(url);
  return geometry ? children(geometry) : <ViewerPlaceholder message="Loading model…" />;
}

function LoadedStlMesh({ geometry, cameraHolder, fitNonce, programmaticUpdateRef, measure = false, measureAxis = "all", onBoundingBox, inspect = false, outcome = null, onSurfaceClick, onGeometryChange, onEmptyClick }: StlMeshProps) {
  const mesh = useRef<Mesh>(null);
  const { camera, gl } = useThree();

  const bbox: BBox | null = useMemo(() => {
    geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    if (!box) return null;
    const plain: BBox = { min: { x: box.min.x, y: box.min.y, z: box.min.z }, max: { x: box.max.x, y: box.max.y, z: box.max.z } };
    return isValidBBox(plain) ? plain : null;
  }, [geometry]);

  // Report the measured box upward (and clear it on unload) so the DOM
  // readout outside the canvas reflects exactly what the viewer shows.
  useEffect(() => {
    onBoundingBox?.(bbox);
    return () => onBoundingBox?.(null);
  }, [bbox, onBoundingBox]);

  // A new geometry (including the first) invalidates any inspection
  // selection made against a previous mesh.
  useEffect(() => {
    onGeometryChange?.();
  }, [geometry, onGeometryChange]);

  useEffect(() => {
    if (!inspect) return;
    const raycaster = new Raycaster();
    const pointer = new Vector2();
    return bindInspectionPointerEvents(gl.domElement, (event) => {
      const bounds = gl.domElement.getBoundingClientRect();
      if (!mesh.current || bounds.width <= 0 || bounds.height <= 0) return null;
      pointer.set((event.clientX - bounds.left) / bounds.width * 2 - 1, -(event.clientY - bounds.top) / bounds.height * 2 + 1);
      camera.updateMatrixWorld();
      mesh.current.updateWorldMatrix(true, false);
      raycaster.setFromCamera(pointer, camera);
      return raycaster.intersectObject(mesh.current, false)[0]?.faceIndex ?? null;
    }, (faceIndex) => onSurfaceClick?.(geometry, faceIndex), onEmptyClick);
  }, [inspect, geometry, camera, gl, onSurfaceClick, onEmptyClick]);

  return (
    <>
      <FitCamera
        geometry={geometry}
        cameraHolder={cameraHolder}
        fitNonce={fitNonce}
        programmaticUpdateRef={programmaticUpdateRef}
      />
      <mesh ref={mesh}>
        <primitive object={geometry} attach="geometry" />
        <meshStandardMaterial color="#c9c9d4" />
      </mesh>
      {measure && bbox ? <DimensionOverlay box={bbox} focus={measureAxis} /> : null}
      {inspect && outcome?.status === "recognized" ? (
        <SurfaceHighlight geometry={geometry} inspection={outcome.inspection} regionTriangles={outcome.regionTriangles} />
      ) : null}
    </>
  );
}

/** SDP §9 Preview: three.js orbit view of the server-authoritative mesh. */
export function Viewer3D({ stlUrl, emptyMessage, measure = false, measureAxis = "all", onBoundingBox, inspect = false, onInspect, fitNonce = 0 }: Viewer3DProps) {
  const [outcome, setOutcome] = useState<InspectionOutcome | null>(null);
  const [cameraHolder] = useState(createCameraPoseHolder);
  const programmaticUpdateRef = useRef(false);

  // Read from effects/handlers so they don't need to re-subscribe just
  // because the caller passed a fresh callback identity every render.
  const onInspectRef = useRef(onInspect);
  onInspectRef.current = onInspect;

  const clearInspection = useCallback(() => {
    setOutcome(null);
    onInspectRef.current?.(null);
  }, []);

  // Turning inspect off clears any existing selection.
  useEffect(() => {
    if (!inspect) clearInspection();
  }, [inspect, clearInspection]);

  // Esc clears the selection while inspecting. Real keyboard input is
  // exercised in the S2-6 human walk; this covers the logic itself.
  useEffect(() => {
    if (!inspect) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEscapeKey(event)) clearInspection();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [inspect, clearInspection]);

  // Unmounting this viewer (leaving 3D view, switching projects) clears
  // the selection too — mount-only so it fires exactly once, at unmount.
  useEffect(() => {
    return () => onInspectRef.current?.(null);
  }, []);

  const handleSurfaceClick = useCallback((geometry: BufferGeometry, faceIndex: number) => {
    const result = inspectSurface(geometry, faceIndex);
    setOutcome(result);
    onInspectRef.current?.(result);
  }, []);

  if (!stlUrl) {
    return (
      <ViewerPlaceholder
        message={emptyMessage ?? "No render yet. Send a message to generate the first model."}
      />
    );
  }

  return (
    <div className="viewer-3d" data-testid="viewer-3d">
      <ViewerErrorBoundary>
        <Suspense fallback={<ViewerPlaceholder message="Loading model…" />}>
          <StlModel url={stlUrl}>{(geometry) => (
            <Canvas camera={{ position: [80, 80, 80], fov: 45 }}>
              <ambientLight intensity={0.6} />
              <directionalLight position={[100, 150, 100]} intensity={0.8} />
              <LoadedStlMesh
                geometry={geometry}
                cameraHolder={cameraHolder}
                fitNonce={fitNonce}
                programmaticUpdateRef={programmaticUpdateRef}
                measure={measure}
                measureAxis={measureAxis}
                onBoundingBox={onBoundingBox}
                inspect={inspect}
                outcome={outcome}
                onSurfaceClick={handleSurfaceClick}
                onGeometryChange={clearInspection}
                onEmptyClick={clearInspection}
              />
              <OrbitControls
                makeDefault
                enableDamping
                onStart={(event) => {
                  cameraHolder.onUserStart(readControlsPose(event));
                }}
                onChange={(event) => {
                  if (programmaticUpdateRef.current) return;
                  const pose = readControlsPose(event);
                  if (pose) cameraHolder.onControlsChange(pose);
                }}
                onEnd={(event) => {
                  cameraHolder.onUserEnd(readControlsPose(event));
                }}
              />
            </Canvas>
          )}</StlModel>
        </Suspense>
      </ViewerErrorBoundary>
    </div>
  );
}
