import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ValidationSummary } from "@scadforge/protocol";
import { ValidationPanel, validationFindings } from "./ValidationPanel.js";

function summary(overrides: Partial<ValidationSummary> = {}): ValidationSummary {
  return { badge: "green", manifold: true, components: 1, volume_mm3: 1000, warning_count: 0, ...overrides };
}

describe("ValidationPanel (Issue #41 symptom 3)", () => {
  it("states plainly that a multi-component model is N separate pieces", () => {
    // The exact live-session case: manifold, but five disconnected islands,
    // badge amber, warning_count 1 — and the user was told none of it.
    render(
      <ValidationPanel
        validation={summary({ badge: "amber", components: 5, volume_mm3: 164079.57, warning_count: 1 })}
      />
    );

    expect(screen.getByTestId("validation-panel-badge")).toHaveTextContent("Warnings");
    expect(screen.getByTestId("validation-findings")).toHaveTextContent("This model is 5 separate pieces");
  });

  it("says nothing is wrong for a clean single-component mesh", () => {
    render(<ValidationPanel validation={summary()} />);
    expect(screen.getByTestId("validation-panel-badge")).toHaveTextContent("Valid");
    expect(screen.queryByTestId("validation-findings")).not.toBeInTheDocument();
    expect(screen.getByTestId("validation-panel")).toHaveTextContent("no problems found");
  });

  it("reports a non-manifold mesh as unprintable", () => {
    render(<ValidationPanel validation={summary({ badge: "red", manifold: false, components: null, volume_mm3: null, warning_count: 0 })} />);
    expect(screen.getByTestId("validation-panel-badge")).toHaveTextContent("Invalid");
    expect(screen.getByTestId("validation-findings")).toHaveTextContent("not manifold");
  });

  it("distinguishes 'never validated' from 'validated and clean'", () => {
    render(<ValidationPanel validation={null} />);
    expect(screen.getByTestId("validation-panel-badge")).toHaveTextContent("Not validated");
    expect(screen.getByTestId("validation-panel")).toHaveTextContent("has not been checked");
  });
});

describe("validationFindings", () => {
  it("suppresses component/volume findings on a non-manifold mesh, which cannot support them", () => {
    // Mirrors scad-core's gate: once `manifold` is false, component and volume
    // numbers are not meaningful, so reporting them would be noise at best.
    const findings = validationFindings(
      summary({ manifold: false, components: 7, volume_mm3: 0, warning_count: 0 })
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("not manifold");
  });

  it("accounts for warnings it cannot reconstruct rather than under-reporting", () => {
    // `warning_count` can exceed what the summary's fields explain — nonzero
    // genus, for one, has no field here. Silently showing fewer findings than
    // the badge counted is exactly the invisibility this issue is about.
    const findings = validationFindings(summary({ badge: "amber", components: 1, warning_count: 1 }));
    expect(findings.join(" ")).toContain("1 further finding");
  });

  it("counterexample: components === null (unmeasurable) is not reported as '0 separate pieces'", () => {
    const findings = validationFindings(summary({ components: null, warning_count: 0 }));
    expect(findings.join(" ")).not.toContain("separate pieces");
  });
});
