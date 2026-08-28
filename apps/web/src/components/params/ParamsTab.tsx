import { useState, type FormEvent } from "react";
import { groupParams } from "./paramGrouping.js";
import { ParamControl } from "./ParamControl.js";
import type { ParamsControllerResult } from "./useParamsController.js";

export interface ParamsTabProps {
  controller: ParamsControllerResult;
  /**
   * Composes and sends a chat message — never fabricates a parameter or
   * schema client-side (Issue #33 AC). The agent decides whether/how to
   * annotate `model.scad`.
   */
  onAskAgent: (message: string) => void;
  disabled?: boolean;
}

function composeAskMessage(description: string): string {
  const trimmed = description.trim();
  return trimmed.length > 0
    ? `Please add a new Customizer parameter to the model for: ${trimmed}`
    : "Please add a new Customizer parameter to the model.";
}

function AskAgentForm({ onAskAgent, disabled }: { onAskAgent: (message: string) => void; disabled?: boolean }) {
  const [draft, setDraft] = useState("");

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onAskAgent(composeAskMessage(draft));
    setDraft("");
  }

  return (
    <form className="params-ask-form" onSubmit={handleSubmit}>
      <input
        type="text"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="What should be adjustable? (optional)"
        aria-label="Parameter request"
        disabled={disabled}
      />
      <button type="submit" data-testid="ask-agent-button" disabled={disabled}>
        Ask agent to add a parameter
      </button>
    </form>
  );
}

/**
 * SDP §9 Params tab: schema-driven controls generated from `ParamSchema`
 * (via the frozen `ParamDefinitionWire` wire shape), grouped under
 * `/* [Section] *\/` headings, driving both the debounced WASM live preview
 * and the persisted server PUT. See `useParamsController.ts` for the
 * debounce/coalescing and agent-vs-user conflict policy.
 */
export function ParamsTab({ controller, onAskAgent, disabled }: ParamsTabProps) {
  const groups = groupParams(controller.parameters);
  const isEmpty = !controller.loading && !controller.loadError && controller.parameters.length === 0;

  return (
    <div className="params-tab">
      {controller.loading ? (
        <p className="params-loading" data-testid="params-loading">
          Loading parameters…
        </p>
      ) : controller.loadError ? (
        <p className="params-error" role="alert" data-testid="params-load-error">
          {controller.loadError}
        </p>
      ) : isEmpty ? (
        <div className="params-empty" data-testid="params-empty-state">
          <p>This model has no Customizer parameters yet.</p>
          <AskAgentForm onAskAgent={onAskAgent} disabled={disabled} />
        </div>
      ) : (
        <>
          <AskAgentForm onAskAgent={onAskAgent} disabled={disabled} />

          {controller.saveError ? (
            <p className="params-save-error" role="alert" data-testid="params-save-error">
              {controller.saveError}
            </p>
          ) : null}

          <div
            className={`params-status params-status--${controller.saving ? "saving" : "saved"}`}
            role="status"
            data-testid="params-status"
          >
            {controller.saving ? "Saving…" : "Saved"}
          </div>

          {groups.map((group) => (
            <section
              key={group.name ?? "__ungrouped"}
              className="param-group"
              data-testid={group.name ? `param-group-${group.name}` : "param-group-ungrouped"}
            >
              {group.name ? <h3 className="param-group-title">{group.name}</h3> : null}
              {group.parameters.map((def) => (
                <ParamControl
                  key={def.name}
                  def={def}
                  value={controller.values[def.name] ?? def.initial}
                  dirty={controller.dirty.has(def.name)}
                  disabled={disabled}
                  onChange={(value) => controller.setValue(def.name, value)}
                />
              ))}
            </section>
          ))}
        </>
      )}
    </div>
  );
}
