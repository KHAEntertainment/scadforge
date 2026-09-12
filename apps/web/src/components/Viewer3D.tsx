import { Component, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Canvas, useLoader, useThree, type ThreeEvent } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { Vector3, type BufferGeometry, type PerspectiveCamera } from "three";
import { DimensionOverlay, type MeasureFocus } from "./DimensionOverlay.js";
import { isValidBBox, type BBox } from "./measure.js";
import { inspectSurface } from "./inspect/surfaceRegion.js";
import { SurfaceHighlight } from "./inspect/SurfaceHighlight.js";
import { INSPECTION_THRESHOLDS } from "./inspect/thresholds.js";
import type { InspectionOutcome } from "./inspect/inspectionTypes.js";

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
}

/**
 * A pointer whose travel between mouse-down and mouse-up is at most
 * `clickMaxDeltaPx` (r3f's `event.delta`) counts as a click, not a drag —
 * so orbiting the camera never selects a surface. Exported for direct
 * unit testing: the canvas itself can't run under jsdom, so this is the
 * one piece of the click-vs-drag decision worth pulling out and testing
 * on its own, the same way `measure.ts` carries `DimensionOverlay.tsx`'s
 * pure logic.
 */
export function isInspectClick(deltaPx: number): boolean {
  return deltaPx <= INSPECTION_THRESHOLDS.clickMaxDeltaPx;
}

/**
 * Whether a keydown event should clear the current inspection selection.
 * Pulled out and exported for the same reason as `isInspectClick`: a real
 * OS-level keypress can't be driven from automation, so this is the piece
 * of the Esc-clears logic a unit test can actually exercise — the S2-6
 * human walk covers the real keyboard end to end.
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
 * `useLoader` throws (via Suspense) while pending and rejects the nearest
 * error boundary on failure — a plain try/catch cannot see either. This
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
 * Frames the camera on the loaded mesh (Issue #41).
 *
 * The camera used to sit at a fixed `[80, 80, 80]`, which only suits a model
 * a few tens of mm across. The demo's box is 200 mm wide, so the very first
 * mesh this viewer ever showed a user was an extreme close-up of one hinge —
 * technically "rendering", but unreadable, and easily mistaken for the blank
 * preview this issue is about. Models are authored at arbitrary scales and
 * are not necessarily centred on the origin, so the framing has to be derived
 * from the geometry rather than guessed.
 */
function FitCamera({ geometry }: { geometry: BufferGeometry }) {
  const camera = useThree((state) => state.camera) as PerspectiveCamera;
  const controls = useThree((state) => state.controls) as { target: Vector3; update: () => void } | null;

  useEffect(() => {
    geometry.computeBoundingSphere();
    const sphere = geometry.boundingSphere;
    // A degenerate or empty mesh has no usable sphere; leaving the default
    // camera alone beats dividing by zero and producing a NaN transform that
    // renders nothing at all.
    if (!sphere || !Number.isFinite(sphere.radius) || sphere.radius <= 0) return;

    const fovRadians = (camera.fov * Math.PI) / 180;
    // Distance at which a sphere of this radius exactly fills the vertical
    // field of view, plus a small margin so the model does not touch the edges.
    const distance = (sphere.radius / Math.sin(fovRadians / 2)) * 1.15;

    const direction = new Vector3(1, 0.8, 1).normalize();
    camera.position.copy(sphere.center).addScaledVector(direction, distance);
    // Re-scale the clipping planes with the model: the defaults clip a large
    // model away entirely, and a too-small `near` z-fights on a small one.
    camera.near = Math.max(distance / 1000, 0.01);
    camera.far = distance * 10;
    camera.updateProjectionMatrix();
    camera.lookAt(sphere.center);

    // Orbit around the model's own centre, not the origin, so dragging keeps
    // the part in frame for an off-origin model.
    if (controls) {
      controls.target.copy(sphere.center);
      controls.update();
    }
  }, [geometry, camera, controls]);

  return null;
}

interface StlMeshProps {
  url: string;
  measure?: boolean;
  measureAxis?: MeasureFocus;
  onBoundingBox?: (box: BBox | null) => void;
  inspect?: boolean;
  /** The current inspection outcome, owned by `Viewer3D` (so `onPointerMissed` on the sibling `<Canvas>` can clear it too). */
  outcome?: InspectionOutcome | null;
  /** A mesh click that passed the click-vs-drag check, with a hit triangle. */
  onSurfaceClick?: (geometry: BufferGeometry, faceIndex: number) => void;
  /** Fires once per loaded geometry (including the first), so any prior selection is dropped when the mesh changes underneath it. */
  onGeometryChange?: () => void;
}

function StlMesh({ url, measure = false, measureAxis = "all", onBoundingBox, inspect = false, outcome = null, onSurfaceClick, onGeometryChange }: StlMeshProps) {
  const geometry = useLoader(STLLoader, url) as BufferGeometry;

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

  const handleClick = useCallback(
    (event: ThreeEvent<MouseEvent>) => {
      if (!isInspectClick(event.delta) || event.faceIndex == null) return;
      event.stopPropagation();
      onSurfaceClick?.(geometry, event.faceIndex);
    },
    [geometry, onSurfaceClick]
  );

  return (
    <>
      <FitCamera geometry={geometry} />
      <mesh geometry={geometry} onClick={inspect ? handleClick : undefined}>
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
export function Viewer3D({ stlUrl, emptyMessage, measure = false, measureAxis = "all", onBoundingBox, inspect = false, onInspect }: Viewer3DProps) {
  const [outcome, setOutcome] = useState<InspectionOutcome | null>(null);

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
          <Canvas camera={{ position: [80, 80, 80], fov: 45 }} onPointerMissed={inspect ? clearInspection : undefined}>
            <ambientLight intensity={0.6} />
            <directionalLight position={[100, 150, 100]} intensity={0.8} />
            <StlMesh
              url={stlUrl}
              measure={measure}
              measureAxis={measureAxis}
              onBoundingBox={onBoundingBox}
              inspect={inspect}
              outcome={outcome}
              onSurfaceClick={handleSurfaceClick}
              onGeometryChange={clearInspection}
            />
            <OrbitControls makeDefault enableDamping />
          </Canvas>
        </Suspense>
      </ViewerErrorBoundary>
    </div>
  );
}
