// Dev-only. Imported automatically by @reticlehq/vite-plugin, so you do not need to import it.
// Self-guards on import.meta.env.DEV, so it is a no-op in a production build.
import { registerCapabilities } from '@reticlehq/react';

if (import.meta.env.DEV) {
  // ── Start with ONE flow. ─────────────────────────────────────────────────────────────────────
  // You do not need to describe the whole app to get value, and trying to is the slow path. Register
  // the store your most important flow reads, and list the testids that flow touches. Add more later,
  // when a flow you actually replay needs them.
  //
  // Registering a store is the highest-value line in this file: it lets the agent check what the app
  // BELIEVES, not just what it rendered — the class of bug a screenshot cannot see. Pass the STORE,
  // not `() => store.getState()`: the store form wires `subscribe` too, so every mutation emits a
  // state diff; the getter form is read-only and silently produces empty diffs.
  // No state library detected. If you add one, register it here — see node_modules/@reticlehq/server/docs/usage.md.

  registerCapabilities({
    testids: ['preview-state', 'chat-user-message', 'tool-activity', 'chat-transcript', 'chat-stream-error', 'code-tab', 'removed-params-confirmation', 'export-button', 'export-refusal', 'export-override', 'fallback', 'child', 'viewer-3d', 'preview-crash-fallback', 'view-button-live', 'measure-toggle', 'inspect-toggle', 'measure-readout', 'png-placeholder', 'snapshot-list-empty', 'snapshot-list', 'snapshot-row', 'snapshot-badge', 'validation-badge', 'openscad-version', 'validation-panel', 'validation-panel-badge', 'validation-findings', 'viewer-placeholder', 'diff-empty-selection', 'diff-first-snapshot', 'diff-view', 'diff-expand', 'history-panel', 'revert-button', 'revert-confirm', 'revert-confirm-yes', 'revert-confirm-no', 'revert-trigger', 'revert-conflict', 'revert-retry', 'revert-failed', 'revert-success', 'snapshot-thumb', 'snapshot-message', 'snapshot-timestamp', 'inspect-setup-cta', 'inspect-readout', 'inspect-diameter-label', 'ask-agent-button', 'params-loading', 'params-load-error', 'params-empty-state', 'params-save-error', 'params-status'],
    signals: [], // names you pass to reticle.signal()
    stores: [], // the keys you registered above
  });
}
