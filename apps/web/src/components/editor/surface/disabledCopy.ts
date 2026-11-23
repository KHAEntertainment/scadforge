// SPDX-License-Identifier: Apache-2.0

// S3-C C4 — user-facing copy for the six disabled reasons (spec §10.2 Q3;
// Issue #136 criteria 2 and 6). The copy only claims what this tab can know:
// S3-B has no project-wide "agent turn running" signal and no push feed for
// writes from another tab or process, so nothing here says it watches them.

import type { DisabledReason } from "../controller/types.js";

export const DISABLED_COPY: Record<DisabledReason, string> = {
  "sidecar-unreadable": "Editing is off: this project's feature data could not be read. You can still view the model.",
  "source-dirty": "Editing is off while the Code tab has unsaved or conflicting edits. Save or discard them first.",
  "params-pending": "Editing is off until your parameter changes finish saving.",
  "agent-turn-running": "Editing is off while this tab's chat turn is running or its result is unknown.",
  "external-write-unsettled": "This tab saw the project change and is reloading it. Editing resumes once the latest version has loaded.",
  "display-recovering": "Your change was saved, but the preview could not be updated."
};
