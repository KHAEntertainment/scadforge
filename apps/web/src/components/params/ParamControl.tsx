import type { ParamDefinitionWire, ParamValue } from "@scadforge/protocol";
import { controlKind } from "./controlKind.js";

export interface ParamControlProps {
  def: ParamDefinitionWire;
  value: ParamValue;
  /** True while this parameter has a local edit not yet confirmed by the server. */
  dirty: boolean;
  onChange: (value: ParamValue) => void;
  disabled?: boolean;
}

/**
 * One schema-driven control (SDP §9 Params tab AC): slider (min/max/step),
 * number, checkbox, text (maxLength), or dropdown for a value list.
 *
 * Boundary values are load-bearing (this project's own "hard way" note): the
 * slider's `min`/`max` are passed straight from the schema with no epsilon
 * fudge, and `step="any"` when the schema gives no step, so dragging to
 * either end always yields exactly `def.min`/`def.max` — the server's
 * `planParamUpdate` validation is inclusive (`n < min` / `n > max` reject;
 * `n === min` / `n === max` accept) and a UI-side off-by-one would reject a
 * legal value before it ever reaches the network.
 */
export function ParamControl({ def, value, dirty, onChange, disabled }: ParamControlProps) {
  const kind = controlKind(def);
  const inputId = `param-input-${def.name}`;

  return (
    <div
      className={`param-control param-control--${kind}${dirty ? " param-control--dirty" : ""}`}
      data-testid={`param-control-${def.name}`}
    >
      <div className="param-control-header">
        <label htmlFor={inputId}>{def.name}</label>
        {dirty ? (
          <span className="param-dirty-indicator" data-testid={`param-dirty-${def.name}`} title="Saving…">
            •
          </span>
        ) : null}
      </div>
      {def.caption ? <p className="param-caption">{def.caption}</p> : null}

      {kind === "slider" ? (
        <div className="param-slider-row">
          <input
            id={inputId}
            type="range"
            min={def.min}
            max={def.max}
            step={def.step ?? "any"}
            value={typeof value === "number" ? value : Number(value)}
            disabled={disabled}
            onChange={(event) => onChange(Number(event.target.value))}
          />
          <output className="param-value" htmlFor={inputId} data-testid={`param-value-${def.name}`}>
            {String(value)}
          </output>
        </div>
      ) : kind === "number" ? (
        <input
          id={inputId}
          type="number"
          min={def.min}
          max={def.max}
          step={def.step ?? "any"}
          value={typeof value === "number" ? value : Number(value)}
          disabled={disabled}
          onChange={(event) => {
            const parsed = Number(event.target.value);
            if (!Number.isNaN(parsed)) onChange(parsed);
          }}
        />
      ) : kind === "checkbox" ? (
        <input
          id={inputId}
          type="checkbox"
          checked={Boolean(value)}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
      ) : kind === "text" ? (
        <input
          id={inputId}
          type="text"
          maxLength={def.maxLength}
          value={typeof value === "string" ? value : String(value)}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : kind === "dropdown" ? (
        <select
          id={inputId}
          value={String(value)}
          disabled={disabled}
          onChange={(event) => {
            const match = def.options?.find((option) => String(option.value) === event.target.value);
            onChange(match ? match.value : event.target.value);
          }}
        >
          {def.options?.map((option) => (
            <option key={option.name} value={String(option.value)}>
              {option.name}
            </option>
          ))}
        </select>
      ) : (
        // "unsupported" — a `vector` parameter with no value list. Shown
        // read-only rather than fabricating an editor OpenSCAD's own
        // Customizer doesn't have either.
        <span className="param-unsupported" data-testid={`param-unsupported-${def.name}`}>
          {JSON.stringify(value)} (unsupported parameter type: {def.type})
        </span>
      )}
    </div>
  );
}
