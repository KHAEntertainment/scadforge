import { useEffect, useMemo, useState } from "react";
import { useThree } from "@react-three/fiber";
import { Html, Line } from "@react-three/drei";
import { DoubleSide } from "three";
import { bboxSize, edgeDimensions, faceCenters, facePlanes, formatMm, type Axis, type BBox, type Vec3 } from "./measure.js";

export type MeasureFocus = Axis | "all";

const FOCUSED_COLOR = "#0f62fe";
const UNFOCUSED_COLOR = "#8d8d8d";
const PLANE_COLOR = "#0f62fe";
const CONNECTOR_COLOR = "#0f62fe";

/**
 * In-viewport measurement overlay — hybrid display.
 *
 * All mode: each axis's measurement anchors to the bbox edge it measures —
 * the edge highlights, endpoint dots pin it to the model corners, and the
 * mm label hugs the edge midpoint. No offset dimension lines, no
 * wrap-around extension runs (the readability failure of the drafting
 * style at oblique angles).
 *
 * Focus mode: the focused axis keeps its edge highlight while the others
 * dim, and the face-to-face pair adds center dots plus one straight dashed
 * connector through the part (x-ray — rendered without depth testing,
 * which is the honest styling for a through-model distance).
 *
 * Visual vocabulary shared with the planned extensions (#63 click-edge,
 * #64 point-to-point): blue = measured extent, dots = anchor points,
 * dashed line = through-space distance. Pure geometry lives in
 * `measure.ts`.
 *
 * Camera-aware edge pick: the dimensioned edge is the one of the four
 * parallel bbox edges whose midpoint projects most positively along the
 * current camera direction (computed from bbox centre to camera). A
 * frame-driven re-render as the user orbits the canvas keeps the visible
 * edge the labelled one — the static pick's oblique-angle failure mode.
 */
export function DimensionOverlay({ box, focus }: { box: BBox; focus: MeasureFocus }) {
  const camera = useThree((state) => state.camera);
  const controls = useThree((state) => state.controls) as { addEventListener?: (event: string, fn: () => void) => void; removeEventListener?: (event: string, fn: () => void) => void } | null;

  // The camera position is mutated by OrbitControls, not by React state,
  // so a plain `useMemo` of it would freeze at mount. Subscribe to the
  // controls' "change" event (fires every drag tick + on damping settle)
  // and bump a React state counter so the Line geometry's points prop
  // updates with the new camera-aware edge pick.
  const [cameraVersion, setCameraVersion] = useState(0);

  useEffect(() => {
    if (!controls?.addEventListener) return;
    const onChange = () => setCameraVersion((v) => (v + 1) % 1_000_000);
    controls.addEventListener("change", onChange);
    return () => controls.removeEventListener?.("change", onChange);
  }, [controls]);

  const cameraDirection: Vec3 = useMemo(() => {
    const center = {
      x: (box.min.x + box.max.x) / 2,
      y: (box.min.y + box.max.y) / 2,
      z: (box.min.z + box.max.z) / 2
    };
    return {
      x: camera.position.x - center.x,
      y: camera.position.y - center.y,
      z: camera.position.z - center.z
    };
    // cameraVersion is the dependency that actually invalidates this
    // memo as the user orbits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraVersion, camera, box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z]);

  const edges = useMemo(() => edgeDimensions(box, cameraDirection), [box, cameraDirection]);
  const planes = useMemo(() => (focus === "all" ? [] : facePlanes(box, focus)), [box, focus]);
  const centers = useMemo(() => (focus === "all" ? null : faceCenters(box, focus)), [box, focus]);

  // Dots scale with the model so they read at any size without dominating.
  const size = bboxSize(box);
  const dotRadius = Math.max(Math.sqrt(size.x ** 2 + size.y ** 2 + size.z ** 2) * 0.012, 0.4);

  return (
    <group>
      {edges.map((edge) => {
        const focused = focus === "all" || focus === edge.axis;
        return (
          <group key={edge.axis}>
            <Line
              points={edge.edge}
              color={focused ? FOCUSED_COLOR : UNFOCUSED_COLOR}
              lineWidth={focused ? 3 : 1.5}
              transparent
              opacity={focused ? 1 : 0.35}
            />
            {focused
              ? edge.endpoints.map((p, i) => (
                  <mesh key={i} position={p}>
                    <sphereGeometry args={[dotRadius, 16, 12]} />
                    <meshBasicMaterial color={FOCUSED_COLOR} />
                  </mesh>
                ))
              : null}
            {focused ? (
              // Labels are DOM (drei Html), not GL text — accessible, crisp
              // at every zoom, and trivially styleable.
              <Html position={edge.labelPosition} center zIndexRange={[10, 0]}>
                <div className="measure-label" data-testid={`measure-label-${edge.axis}`}>
                  {edge.axis.toUpperCase()} {formatMm(edge.sizeMm)} mm
                </div>
              </Html>
            ) : null}
          </group>
        );
      })}
      {centers ? (
        <group>
          <Line
            points={centers}
            color={CONNECTOR_COLOR}
            lineWidth={2}
            dashed
            dashSize={dotRadius * 4}
            gapSize={dotRadius * 2}
            transparent
            opacity={0.9}
            depthTest={false}
          />
          {centers.map((p, i) => (
            <mesh key={i} position={p}>
              <sphereGeometry args={[dotRadius, 16, 12]} />
              <meshBasicMaterial color={CONNECTOR_COLOR} depthTest={false} transparent opacity={0.9} />
            </mesh>
          ))}
        </group>
      ) : null}
      {planes.map((plane, index) => (
        <mesh key={`plane-${index}`} position={plane.position} rotation={plane.rotation}>
          <planeGeometry args={plane.size} />
          <meshBasicMaterial color={PLANE_COLOR} transparent opacity={0.18} side={DoubleSide} depthWrite={false} />
        </mesh>
      ))}
    </group>
  );
}
