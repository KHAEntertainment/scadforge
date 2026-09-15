// SPDX-License-Identifier: Apache-2.0

import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreviewErrorBoundary } from "./PreviewErrorBoundary.js";

function Boom({ message }: { message: string }): JSX.Element {
  throw new Error(message);
}

describe("PreviewErrorBoundary", () => {
  beforeEach(() => {
    // React logs the caught error, and the boundary logs it deliberately.
    // Silenced so an intentional throw does not look like a test failure.
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("contains a throw from the preview layer instead of unmounting the tree around it", () => {
    // The Issue #47 blast radius in miniature: `Illegal invocation` came out
    // of the WASM client, and with no boundary above the preview it took the
    // whole React root down to a blank page.
    render(
      <div>
        <p>rest of the app</p>
        <PreviewErrorBoundary fallback={(message) => <p data-testid="fallback">degraded: {message}</p>}>
          <Boom message="Illegal invocation" />
        </PreviewErrorBoundary>
      </div>
    );

    expect(screen.getByTestId("fallback")).toHaveTextContent("degraded: Illegal invocation");
    // The decisive assertion: everything outside the boundary is still mounted.
    expect(screen.getByText("rest of the app")).toBeInTheDocument();
  });

  it("renders children untouched when nothing throws", () => {
    render(
      <PreviewErrorBoundary fallback={() => <p data-testid="fallback">degraded</p>}>
        <p data-testid="child">preview</p>
      </PreviewErrorBoundary>
    );
    expect(screen.getByTestId("child")).toBeInTheDocument();
    expect(screen.queryByTestId("fallback")).not.toBeInTheDocument();
  });

  it("surfaces a non-Error throw without crashing the boundary itself", () => {
    // A boundary only catches throws from its DESCENDANTS' renders, so this
    // has to be a child component rather than an inline expression.
    function ThrowString(): JSX.Element {
      throw "a bare string";
    }
    render(
      <PreviewErrorBoundary fallback={(message) => <p data-testid="fallback">{message}</p>}>
        <ThrowString />
      </PreviewErrorBoundary>
    );
    expect(screen.getByTestId("fallback")).toHaveTextContent("failed unexpectedly");
  });
});
