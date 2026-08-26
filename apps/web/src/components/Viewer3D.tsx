import { Component, Suspense, type ReactNode } from "react";
import { Canvas, useLoader } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import type { BufferGeometry } from "three";

export interface Viewer3DProps {
  /** HTTP path to the server-exported STL. `null` when no render has happened yet. */
  stlUrl: string | null;
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

function StlMesh({ url }: { url: string }) {
  const geometry = useLoader(STLLoader, url) as BufferGeometry;
  return (
    <mesh geometry={geometry}>
      <meshStandardMaterial color="#c9c9d4" />
    </mesh>
  );
}

/** SDP §9 Preview: three.js orbit view of the server-authoritative mesh. */
export function Viewer3D({ stlUrl }: Viewer3DProps) {
  if (!stlUrl) {
    return <ViewerPlaceholder message="No render yet. Send a message to generate the first model." />;
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
