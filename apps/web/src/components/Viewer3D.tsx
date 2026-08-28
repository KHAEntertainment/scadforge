import { Component, Suspense, useEffect, type ReactNode } from "react";
import { Canvas, useLoader, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { Vector3, type BufferGeometry, type PerspectiveCamera } from "three";

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

function StlMesh({ url }: { url: string }) {
  const geometry = useLoader(STLLoader, url) as BufferGeometry;
  return (
    <>
      <FitCamera geometry={geometry} />
      <mesh geometry={geometry}>
        <meshStandardMaterial color="#c9c9d4" />
      </mesh>
    </>
  );
}

/** SDP §9 Preview: three.js orbit view of the server-authoritative mesh. */
export function Viewer3D({ stlUrl, emptyMessage }: Viewer3DProps) {
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
          <Canvas camera={{ position: [80, 80, 80], fov: 45 }}>
            <ambientLight intensity={0.6} />
            <directionalLight position={[100, 150, 100]} intensity={0.8} />
            <StlMesh url={stlUrl} />
            <OrbitControls makeDefault enableDamping />
          </Canvas>
        </Suspense>
      </ViewerErrorBoundary>
    </div>
  );
}
