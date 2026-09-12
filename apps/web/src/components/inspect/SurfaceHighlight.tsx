import { useMemo } from "react";
import { Html, Line } from "@react-three/drei";
import { BufferAttribute, DoubleSide, type BufferGeometry } from "three";
import { formatMm } from "../measure.js";
import { cylinderHighlightGeometry, extractHighlightPositions } from "./highlightGeometry.js";
import type { CylinderInspection } from "./inspectionTypes.js";

const HIGHLIGHT_COLOR = "#0f62fe";

/**
 * Overlay for a recognized cylindrical surface: the region's own
 * triangles re-drawn in the accent color (polygon-offset ahead of the
 * base mesh), plus an axis line and a diameter line through the center,
 * labeled "Ø {mm}" in #65's badge style (the same `measure-label`
 * class `DimensionOverlay.tsx` uses — no new label component).
 *
 * Refusals get no highlight; callers only mount this for a `recognized`
 * outcome.
 */
export function SurfaceHighlight({ geometry, inspection, regionTriangles }: { geometry: BufferGeometry; inspection: CylinderInspection; regionTriangles: Uint32Array }) {
  const highlightPositions = useMemo(() => {
    const sourcePositions = geometry.getAttribute("position").array as ArrayLike<number>;
    return extractHighlightPositions(sourcePositions, regionTriangles);
  }, [geometry, regionTriangles]);

  const { axisLine, diameterLine, labelPosition } = useMemo(() => cylinderHighlightGeometry(inspection), [inspection]);

  return (
    <group>
      <mesh>
        <bufferGeometry>
          <primitive object={new BufferAttribute(highlightPositions, 3)} attach="attributes-position" />
        </bufferGeometry>
        <meshBasicMaterial color={HIGHLIGHT_COLOR} transparent opacity={0.35} side={DoubleSide} depthWrite={false} polygonOffset polygonOffsetFactor={-4} polygonOffsetUnits={-4} />
      </mesh>
      <Line points={axisLine} color={HIGHLIGHT_COLOR} lineWidth={2} dashed dashSize={2} gapSize={1.2} transparent opacity={0.85} />
      <Line points={diameterLine} color={HIGHLIGHT_COLOR} lineWidth={2} transparent opacity={0.9} />
      <Html position={labelPosition} center zIndexRange={[10, 0]}>
        <div className="measure-label" data-testid="inspect-diameter-label">
          Ø {formatMm(inspection.diameterMm)}
        </div>
      </Html>
    </group>
  );
}
