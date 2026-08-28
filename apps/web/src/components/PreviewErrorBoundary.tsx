import { Component, type ReactNode } from "react";

export interface PreviewErrorBoundaryProps {
  children: ReactNode;
  /**
   * Rendered instead of `children` once something below has thrown. Given the
   * error message so the panel can say what went wrong.
   */
  fallback: (message: string) => ReactNode;
}

interface PreviewErrorBoundaryState {
  message: string | null;
}

/**
 * Contains ANY throw from the preview layer.
 *
 * Motivated by Issue #47, where a `TypeError: Illegal invocation` in the WASM
 * preview client blanked the whole application. That receiver bug is fixed at
 * its source separately; what belongs HERE is the structural reason a
 * one-line defect could take the entire app down. The only boundary in the
 * preview path was inside `Viewer3D`, wrapping the three.js canvas — so a
 * throw from anywhere else (the WASM client, the hook, the tab itself) passed
 * straight through to the React root and unmounted everything.
 *
 * CLAUDE.md rule 6 makes containing that a correctness requirement rather than
 * polish: the server render is authoritative and a WASM-preview failure must
 * degrade to it. Degrading is impossible once the crash has already taken the
 * app down, so the boundary belongs ABOVE the preview panel, which is where
 * this sits.
 */
export class PreviewErrorBoundary extends Component<PreviewErrorBoundaryProps, PreviewErrorBoundaryState> {
  state: PreviewErrorBoundaryState = { message: null };

  static getDerivedStateFromError(error: unknown): PreviewErrorBoundaryState {
    return { message: error instanceof Error ? error.message : "The preview failed unexpectedly." };
  }

  componentDidCatch(error: unknown) {
    // Kept on the console: unlike Viewer3D's boundary (where a failed STL
    // fetch is an ordinary, expected outcome), reaching HERE always means a
    // real defect, and swallowing it silently is how #47 survived a review.
    console.error("[ScadForge] preview layer crashed and was contained:", error);
  }

  render() {
    if (this.state.message !== null) return this.props.fallback(this.state.message);
    return this.props.children;
  }
}
