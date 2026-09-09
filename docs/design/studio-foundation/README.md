# Studio design foundation

Owner-approved direction, September 8, 2026. The supplied Google Stitch references establish the visual system and longer-term product intent. They are design references, not evidence that the illustrated capabilities exist.

- [Supplied Carbon design system](DESIGN.md)
- [Studio reference](studio-reference.png)
- [Future print-preparation reference](print-prep-reference.png)

## Settled layout

The left pane contains Chat, Parameters, Code, and History tabs. The right pane always contains a preview. Parameter and source inspection must not replace the model. Keep the canvas mounted across tool changes. Desktop split is resizable, initially 400px, minimum 320px, maximum 640px with at least 480px for the preview. Below 900px, stack the visible preview above the tool pane.

Keep the useful visual hierarchy of Stitch, but remove its duplicated bottom parameter strip, duplicate export controls, decorative navigation, and overlapping overlays. Use one header with project selection/creation, real status, Render & validate, and Export.

## Visual decisions

Use IBM Plex Sans, blue #0f62fe, white and neutral gray surfaces, square controls, restrained borders, semantic green/red, 14px body and 12px secondary labels. Use an 8px layout grid; the supplied document's 2px rhythm applies to optical/type adjustments. Source/diffs use monospace for readability. Inputs are 40px high; touch targets 48px. Meet AA contrast and keyboard accessibility, with visible focus and reduced-motion support. No perpetual decorative animation or invented data.

## First milestone

- Explicit project creation/switching with active-turn and dirty-draft protection.
- Editable OpenSCAD with local recoverable drafts, explicit save/discard, syntax diagnostics, revision conflict detection, and compatible parameter override preservation. Confirm before dropping incompatible overrides.
- Automatic debounced Live preview of source/parameter edits. Browser geometry is a convenience preview; server validation remains authoritative and tied to its saved snapshot.
- Existing chat persistence with a multiline composer and compact activity presentation. No new structured AI card protocol.
- History inspection, source/diff review, and append-only revert beside the model. Historical state clearly labeled and read-only.
- Header export of model 3MF, STL, and source. Preserve the validation gate. Model 3MF is not a preconfigured slicer project.

Source-save and pinned-build interfaces are additive contract work tracked in [issue #54](https://github.com/KHAEntertainment/scadforge/issues/54). No authentication or database is introduced.

## Deferred product intent

Interactive clarification and proposed-change cards, durable conversation design, annotations, printer profiles, bed-fit visualization, orientation guidance, overhang/contact analysis, model splitting, and configured slicer projects require subsequent functional specifications. The screenshots' printability scores, strength changes, estimated support/time savings, and material recommendations are illustrative, not values to copy into the product. STEP export and slicer launch are not part of the foundation.

## Verification boundary

The foundation requires functional tests for draft/save races, conflicting writes, project isolation, pinned build results, params synchronization, history/revert, and export; browser verification for actual rendering, editor interaction, resize/tab persistence, keyboard navigation, and narrow layout; and build/typecheck/lint/license checks. Static mockups and unit tests alone do not establish visual or end-to-end completion.
