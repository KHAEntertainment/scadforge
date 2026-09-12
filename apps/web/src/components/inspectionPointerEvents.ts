import { INSPECTION_THRESHOLDS } from "./inspect/thresholds.js";

export function isInspectClick(deltaPx: number): boolean {
  return Number.isFinite(deltaPx) && deltaPx >= 0 && deltaPx <= INSPECTION_THRESHOLDS.clickMaxDeltaPx;
}

/** One native gesture path for hits and misses, independent of R3F's 2px miss gate. */
export function bindInspectionPointerEvents(
  canvas: HTMLElement,
  hitTest: (event: MouseEvent) => number | null,
  onHit: (faceIndex: number) => void,
  onMiss: () => void,
): () => void {
  let start: { x: number; y: number; hit: boolean } | null = null;
  let end: { x: number; y: number } | null = null;
  const down = (event: PointerEvent) => {
    end = null;
    start = event.button === 0 ? { x: event.clientX, y: event.clientY, hit: hitTest(event) !== null } : null;
  };
  const up = (event: PointerEvent) => { end = { x: event.clientX, y: event.clientY }; };
  const cancel = () => { start = null; end = null; };
  const click = (event: MouseEvent) => {
    const initial = start;
    const final = end;
    cancel();
    // Pointer coordinates retain fractional CSS pixels; MouseEvent click
    // coordinates can be truncated under browser zoom.
    if (!initial || !final || event.button !== 0 || !isInspectClick(Math.hypot(final.x - initial.x, final.y - initial.y))) return;
    const face = hitTest(event);
    if (face === null) onMiss();
    else if (initial.hit) onHit(face);
  };
  canvas.addEventListener("pointerdown", down);
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", cancel);
  canvas.addEventListener("click", click);
  return () => {
    cancel();
    canvas.removeEventListener("pointerdown", down);
    canvas.removeEventListener("pointerup", up);
    canvas.removeEventListener("pointercancel", cancel);
    canvas.removeEventListener("click", click);
  };
}
