import { useMemo } from "react";
import { Html } from "@react-three/drei";
import { BufferGeometry, DoubleSide, Float32BufferAttribute } from "three";
import { dimensionLines, facePlanes, formatMm, type Axis, type BBox } from "./measure.js";

export type MeasureFocus = Axis | "all";

const FOCUSED_COLOR = "#0f62fe";
const UNFOCUSED_COLOR = "#8d8d8d";
const PLANE_COLOR = "#0f62fe";

/**
 * In-viewport dimension brackets + mm labels for the mesh bounding box
 * (deferred measurement-visualization feature; pure geometry lives in
 * `measure.ts`). Rendered inside the R3F canvas alongside the model.
 *
 * When `focus` is a single axis, that axis's dimension line stays
 * accent-coloured while the other two dim, and the two bounding-box face
 * planes it spans are shown translucent — the face-to-face pair being
 * measured. `focus: "all"` shows all three dimensions equally.
 */
export function DimensionOverlay({ box, focus }: { box: BBox; focus: MeasureFocus }) {
  const lines = useMemo(
    () =>
      dimensionLines(box).map((line) => {
        const geometry = new BufferGeometry();
        geometry.setAttribute("position", new Float32BufferAttribute(line.segments, 3));
        return { ...line, geometry };
      }),
    [box]
  );
  const planes = useMemo(() => (focus === "all" ? [] : facePlanes(box, focus)), [box, focus]);

  return (
    <group>
      {lines.map((line) => {
        const focused = focus === "all" || focus === line.axis;
        return (
          <lineSegments key={line.axis} geometry={line.geometry}>
            <lineBasicMaterial color={focused ? FOCUSED_COLOR : UNFOCUSED_COLOR} transparent opacity={focused ? 1 : 0.35} />
          </lineSegments>
        );
      })}
      {lines.map((line) =>
        focus === "all" || focus === line.axis ? (
          // Labels are DOM (drei Html), not GL text — accessible, crisp at
          // every zoom, and trivially styleable.
          <Html key={`label-${line.axis}`} position={line.labelPosition} center zIndexRange={[10, 0]}>
            <div className="measure-label" data-testid={`measure-label-${line.axis}`}>
              {line.axis.toUpperCase()} {formatMm(line.sizeMm)} mm
            </div>
          </Html>
        ) : null
      )}
      {planes.map((plane, index) => (
        <mesh key={`plane-${index}`} position={plane.position} rotation={plane.rotation}>
          <planeGeometry args={plane.size} />
          <meshBasicMaterial color={PLANE_COLOR} transparent opacity={0.18} side={DoubleSide} depthWrite={false} />
        </mesh>
      ))}
    </group>
  );
}
