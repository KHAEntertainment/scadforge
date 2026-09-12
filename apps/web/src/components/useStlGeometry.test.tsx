import { StrictMode } from "react";
import { act, renderHook } from "@testing-library/react";
import { BufferGeometry, CylinderGeometry } from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { useStlGeometry } from "./useStlGeometry.js";
import { inspectSurface } from "./inspect/surfaceRegion.js";

afterEach(() => vi.restoreAllMocks());

describe("per-viewer STL ownership", () => {
  it("releases displayed geometry and welded data through unique snapshot churn, and reloads revisited URLs", () => {
    const callbacks: Array<(geometry: BufferGeometry) => void> = [];
    vi.spyOn(STLLoader.prototype, "load").mockImplementation((_url, done) => { callbacks.push(done); });
    const { result, rerender, unmount } = renderHook(({ url }) => useStlGeometry(url), { initialProps: { url: "/0.stl" } });
    const geometries: BufferGeometry[] = [];
    for (let i = 0; i < 12; i++) {
      if (i) rerender({ url: `/${i}.stl` });
      expect(result.current).toBeNull();
      const geometry = new CylinderGeometry(20, 20, 10, 48).toNonIndexed();
      const dispose = vi.spyOn(geometry, "dispose");
      act(() => callbacks[i](geometry));
      expect(result.current).toBe(geometry);
      const clone = vi.spyOn(geometry.getAttribute("position"), "clone");
      inspectSurface(geometry, 0);
      inspectSurface(geometry, 0);
      expect(clone).toHaveBeenCalledTimes(1);
      geometries.push(geometry);
      rerender({ url: `/pending-${i}.stl` });
      expect(dispose).toHaveBeenCalledTimes(1);
      // Even if another diagnostic retains a disposed key, welded data was
      // explicitly removed: a new inspection has to rebuild it.
      inspectSurface(geometry, 0);
      expect(clone).toHaveBeenCalledTimes(2);
      geometry.dispose();
      callbacks.splice(i + 1, 1); // discard this never-completed pending request
    }
    rerender({ url: "/0.stl" });
    expect(result.current).toBeNull();
    const fresh = new BufferGeometry();
    act(() => callbacks.at(-1)!(fresh));
    expect(result.current).toBe(fresh);
    expect(geometries).not.toContain(result.current);
    const dispose = vi.spyOn(fresh, "dispose");
    unmount();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("disposes late and StrictMode-abandoned loads without publishing or reusing them", () => {
    const callbacks: Array<(geometry: BufferGeometry) => void> = [];
    vi.spyOn(STLLoader.prototype, "load").mockImplementation((_url, done) => { callbacks.push(done); });
    const { result, rerender, unmount } = renderHook(({ url }) => useStlGeometry(url), {
      initialProps: { url: "/a.stl" }, wrapper: StrictMode,
    });
    const abandoned = new BufferGeometry();
    const disposed = vi.spyOn(abandoned, "dispose");
    act(() => callbacks[0](abandoned));
    expect(disposed).toHaveBeenCalledOnce();
    expect(result.current).toBeNull();
    rerender({ url: "/b.stl" });
    const late = new BufferGeometry();
    const lateDispose = vi.spyOn(late, "dispose");
    act(() => callbacks[1](late));
    expect(lateDispose).toHaveBeenCalledOnce();
    expect(result.current).toBeNull();
    unmount();
    const afterUnmount = new BufferGeometry();
    const unmountedDispose = vi.spyOn(afterUnmount, "dispose");
    act(() => callbacks[2](afterUnmount));
    expect(unmountedDispose).toHaveBeenCalledOnce();
  });
});
