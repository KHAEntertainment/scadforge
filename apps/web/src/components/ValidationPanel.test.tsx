import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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

  it("counterexample: no onBuild handler — the 'Not validated' state renders no Build action", () => {
    render(<ValidationPanel validation={null} />);
    expect(screen.queryByTestId("validation-build-button")).not.toBeInTheDocument();
  });
});

describe("ValidationPanel — Build CTA (Issue #78 AC2)", () => {
  it("gains the same one-line instruction and an inline Build action when 'Not validated'", () => {
    const onBuild = vi.fn();
    render(<ValidationPanel validation={null} onBuild={onBuild} buildDisabled={false} buildDisabledReason={null} />);

    expect(screen.getByTestId("validation-panel")).toHaveTextContent(/build validates the model and creates the mesh/i);
    const button = screen.getByTestId("validation-build-button");
    expect(button).toBeEnabled();
    expect(button).toHaveTextContent("Build");
    fireEvent.click(button);
    expect(onBuild).toHaveBeenCalledTimes(1);
  });

  it("shows 'Validating…' in place of the instruction and on the button while building", () => {
    render(<ValidationPanel validation={null} onBuild={vi.fn()} building buildDisabled buildDisabledReason="Building…" />);

    expect(screen.getByTestId("validation-panel")).toHaveTextContent("Validating…");
    expect(screen.getByTestId("validation-build-button")).toHaveTextContent("Validating…");
    expect(screen.getByTestId("validation-build-button")).toBeDisabled();
  });

  it("disables the Build action with a tooltip naming the reason", () => {
    render(
      <ValidationPanel
        validation={null}
        onBuild={vi.fn()}
        buildDisabled
        buildDisabledReason="Finish the active chat turn before building."
      />
    );

    const button = screen.getByTestId("validation-build-button");
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Finish the active chat turn before building.");
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
