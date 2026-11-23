// Typed REST client for the ScadForge server API.
//
// Zero hand-rolled API types (Issue #18 AC): every request/response shape
// below is imported from `@scadforge/protocol`. This client only knows how
// to build URLs from `API_ROUTES`, attach JSON bodies, and narrow
// `ApiResponse<T>` into a success value or throw an `ApiClientError` carrying
// the frozen `ApiError` shape.
//
// The base URL is injectable so component/unit tests can point this at a
// scripted fetch mock instead of a live `apps/server` instance (Issue #17
// builds the real server in parallel — this app develops against the
// protocol contract, not a running server).

import { API_BASE_PATH, API_ROUTES, EDITOR_ROUTES, ERROR_CODES } from "@scadforge/protocol";
import type {
  ApiError,
  BuildRequest,
  BuildResponse,
  ChatTurnRequest,
  EditorCommitRequest,
  EditorDocument,
  EditorOperationResponse,
  EditorProofResponse,
  EditorReceipt,
  EditorVerifyRequest,
  ExportRequest,
  ExportResponse,
  HealthResponse,
  ListProjectsResponse,
  ListSnapshotsResponse,
  ParamsResponse,
  ParamsUpdateRequest,
  ProjectResponse,
  CreateProjectRequest,
  RevertRequest,
  SnapshotDiffResponse,
  SnapshotResponse,
  SourcePreflightRequest,
  SourcePreflightResponse,
  SourceResponse,
  SourceUpdateRequest
} from "@scadforge/protocol";
import {
  parseEditorDocument,
  parseEditorOperationResponse,
  parseEditorProofResponse,
  parseEditorReceipt
} from "@scadforge/protocol";

/**
 * How a request failed, for callers (S3-C C1's editor adapter) that classify
 * transport failures without reading prose: `http` means a non-2xx response
 * with a parseable {@link ApiError} body (see {@link isParseableApiError}),
 * `network` means `fetch` itself rejected, `unparseable-body` means the body
 * was not the JSON the strict contract requires (including strict-parser
 * rejections of JSON that parses but fails the schema).
 */
export type ApiClientFailureKind = "http" | "network" | "unparseable-body";

/** Thrown for any non-2xx response. Carries the frozen `{error_code, message}` body. */
export class ApiClientError extends Error {
  readonly error_code: ApiError["error_code"];
  /** The frozen `ApiError` this error was built from, so the commit classifier can pass it through unchanged (Issue #134 criterion 3). */
  readonly apiError: ApiError;
  /** See {@link ApiClientFailureKind}. Defaults to `"http"` for callers that predate it. */
  readonly kind: ApiClientFailureKind;
  /** HTTP status when one exists (`kind: "http"` or `"unparseable-body"`), else `null`. */
  readonly status: number | null;

  constructor(error: ApiError, failure?: { kind?: ApiClientFailureKind; status?: number | null }) {
    super(error.message);
    this.name = "ApiClientError";
    this.error_code = error.error_code;
    this.apiError = error;
    this.kind = failure?.kind ?? "http";
    this.status = failure?.status ?? null;
  }
}

export interface ApiClientOptions {
  /** Defaults to same-origin (`""`), so the app works behind a dev-server proxy. */
  baseUrl?: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

function join(base: string, path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  return `${base}${path}`;
}

function fillRoute(template: string, params: Record<string, string>): string {
  return template.replace(/:([a-zA-Z_]+)/g, (_match, key: string) => {
    const value = params[key];
    if (value === undefined) {
      throw new Error(`Missing route param "${key}" for template "${template}"`);
    }
    return encodeURIComponent(value);
  });
}

/**
 * Strict validation of a wire `ApiError` body (Issue #134 criterion 3 keys
 * commit definiteness on "4xx with a PARSEABLE `ApiError`"). Mirrors the
 * inline rule the protocol's `EditorOperationResponse` parser applies to
 * nested errors: a plain object with a closed-union `error_code` and a
 * non-empty `message`. A body failing this is "unparseable", never a
 * synthesized code.
 */
function isParseableApiError(body: unknown): body is ApiError {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return false;
  const record = body as Record<string, unknown>;
  return (
    typeof record.error_code === "string" &&
    (ERROR_CODES as readonly string[]).includes(record.error_code) &&
    typeof record.message === "string" &&
    record.message.length > 0
  );
}

/**
 * Creates a REST client bound to `baseUrl`. Every method returns the parsed
 * success body or throws {@link ApiClientError}.
 */
export function createApiClient(options: ApiClientOptions = {}) {
  const baseUrl = options.baseUrl ?? "";
  // `fetch` is bound to the global explicitly. A bare `fetchImpl(...)` call is
  // safe as written (WebIDL replaces an `undefined` receiver with the global),
  // but that safety lasts only as long as nobody turns this into a property
  // call — browsers throw `TypeError: Illegal invocation` on a WebIDL global
  // invoked with any other receiver. Binding once here makes the guarantee
  // local instead of an invariant every future caller has to remember.
  const fetchImpl: typeof fetch = options.fetchImpl ?? fetch.bind(globalThis);

  async function request<T>(
    path: string,
    init: RequestInit = {}
  ): Promise<T> {
    const suffix = path.startsWith("/") ? path : `/${path}`;
    const url = join(baseUrl, `${API_BASE_PATH}${suffix}`);

    // The server being unreachable (wrong port, not started, proxy target
    // down) makes `fetch` itself reject — surface that as a typed,
    // readable error instead of letting the rejection propagate as a raw
    // `TypeError` that downstream callers aren't expecting (Issue #36 AC).
    let res: Response;
    try {
      res = await fetchImpl(url, {
        ...init,
        headers: {
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...init.headers
        }
      });
    } catch (cause) {
      throw new ApiClientError(
        {
          error_code: "INTERNAL_ERROR",
          message: `Could not reach the ScadForge API at ${url}. Is the server running? (${
            cause instanceof Error ? cause.message : String(cause)
          })`
        },
        { kind: "network" }
      );
    }

    // Read the raw text first: a 200 with a non-JSON body (e.g. Vite's
    // `index.html` fallback when the dev proxy isn't forwarding `/api`) must
    // never be treated as a successful, empty response — that previously
    // surfaced as a silent `null` that crashed callers on destructuring
    // (Issue #36).
    const rawBody = await res.text();
    let body: unknown = null;
    let parseFailed = false;
    if (rawBody.length > 0) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        parseFailed = true;
      }
    }

    if (!res.ok) {
      const err = body as Partial<ApiError> | null;
      throw new ApiClientError(
        {
          error_code: err?.error_code ?? "INTERNAL_ERROR",
          message: err?.message ?? `Request failed with status ${res.status}`
        },
        { kind: "http", status: res.status }
      );
    }

    if (parseFailed) {
      throw new ApiClientError(
        {
          error_code: "INTERNAL_ERROR",
          message: `Received a non-JSON response (status ${res.status}) from ${url}. This usually means the dev proxy isn't forwarding /api to the API server, or the wrong baseUrl is configured.`
        },
        { kind: "unparseable-body", status: res.status }
      );
    }

    return body as T;
  }

  /**
   * Strict editor transport (Issue #134 criterion 1). Same URL/JSON plumbing
   * as {@link request}, but every response body is validated before it is
   * handed to the strict protocol parsers: a parse failure is an error, never
   * a best-effort object, and a non-2xx body only surfaces as the frozen
   * `ApiError` when it strict-validates as one (criterion 3 keys commit
   * definiteness on exactly that).
   */
  async function requestEditor<T>(
    path: string,
    init: RequestInit,
    parse: (body: unknown) => T
  ): Promise<T> {
    const suffix = path.startsWith("/") ? path : `/${path}`;
    const url = join(baseUrl, `${API_BASE_PATH}${suffix}`);

    let res: Response;
    try {
      res = await fetchImpl(url, {
        ...init,
        headers: {
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...init.headers
        }
      });
    } catch (cause) {
      throw new ApiClientError(
        {
          error_code: "INTERNAL_ERROR",
          message: `Could not reach the ScadForge API at ${url}. Is the server running? (${
            cause instanceof Error ? cause.message : String(cause)
          })`
        },
        { kind: "network" }
      );
    }

    const rawBody = await res.text();
    let body: unknown = null;
    let parseFailed = false;
    if (rawBody.length > 0) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        parseFailed = true;
      }
    }

    if (!res.ok) {
      if (!parseFailed && isParseableApiError(body)) {
        throw new ApiClientError(
          { error_code: body.error_code, message: body.message },
          { kind: "http", status: res.status }
        );
      }
      throw new ApiClientError(
        {
          error_code: "INTERNAL_ERROR",
          message: `Received a non-JSON or malformed error body (status ${res.status}) from ${url}.`
        },
        { kind: "unparseable-body", status: res.status }
      );
    }

    // F5 (fix batch 1): the editor contract answers exactly 200. Any other
    // 2xx is not the contract-conforming answer and is surfaced as
    // `unparseable-body`, which the commit/lookup classifier maps to AMBIGUOUS
    // — it can never manufacture a definite outcome. Non-editor methods keep
    // their original behaviour (`request()` below is untouched).
    if (res.status !== 200) {
      throw new ApiClientError(
        {
          error_code: "INTERNAL_ERROR",
          message: `Received an unexpected success status ${res.status} (expected exactly 200) from ${url}.`
        },
        { kind: "unparseable-body", status: res.status }
      );
    }

    if (parseFailed) {
      throw new ApiClientError(
        {
          error_code: "INTERNAL_ERROR",
          message: `Received a non-JSON response (status ${res.status}) from ${url}.`
        },
        { kind: "unparseable-body", status: res.status }
      );
    }

    try {
      return parse(body);
    } catch (cause) {
      throw new ApiClientError(
        {
          error_code: "INTERNAL_ERROR",
          message: `Received a response that failed strict editor parsing (status ${res.status}) from ${url}: ${
            cause instanceof Error ? cause.message : String(cause)
          }`
        },
        { kind: "unparseable-body", status: res.status }
      );
    }
  }

  return {
    baseUrl,

    health(): Promise<HealthResponse> {
      return request<HealthResponse>(API_ROUTES.health);
    },

    listProjects(): Promise<ListProjectsResponse> {
      return request<ListProjectsResponse>(API_ROUTES.projects.list);
    },

    createProject(body: CreateProjectRequest): Promise<ProjectResponse> {
      return request<ProjectResponse>(API_ROUTES.projects.create, {
        method: "POST",
        body: JSON.stringify(body)
      });
    },

    getProject(projectId: string): Promise<ProjectResponse> {
      return request<ProjectResponse>(fillRoute(API_ROUTES.projects.get, { projectId }));
    },

    listSnapshots(projectId: string): Promise<ListSnapshotsResponse> {
      return request<ListSnapshotsResponse>(
        fillRoute(API_ROUTES.snapshots.list, { projectId })
      );
    },

    /** `GET /projects/:projectId/snapshots/:snapshotId` — captured source for historical Code view. */
    getSnapshot(projectId: string, snapshotId: string): Promise<SnapshotResponse> {
      return request<SnapshotResponse>(
        fillRoute(API_ROUTES.snapshots.get, { projectId, snapshotId })
      );
    },

    /** `GET /snapshots/:snapshotId/diff` — empty string for the first snapshot (frozen contract). */
    getSnapshotDiff(projectId: string, snapshotId: string): Promise<SnapshotDiffResponse> {
      return request<SnapshotDiffResponse>(
        fillRoute(API_ROUTES.snapshots.diff, { projectId, snapshotId })
      );
    },

    /**
     * `POST /snapshots/:snapshotId/revert` — history is append-only: this
     * creates a NEW snapshot carrying `snapshotId`'s content forward. Throws
     * `ApiClientError` with `error_code: "CONFLICT"` (409) under write
     * contention (M1 store concurrency policy) — never a silent overwrite.
     */
    revertSnapshot(projectId: string, snapshotId: string, body: RevertRequest = {}): Promise<SnapshotResponse> {
      return request<SnapshotResponse>(
        fillRoute(API_ROUTES.snapshots.revert, { projectId, snapshotId }),
        {
          method: "POST",
          body: JSON.stringify(body)
        }
      );
    },

    /**
     * Opens the chat SSE stream. Returns the raw `Response` (not JSON) so the
     * caller can hand `response.body` to {@link parseSseStream}.
     */
    async openChatStream(projectId: string, turn: ChatTurnRequest, signal?: AbortSignal): Promise<Response> {
      const url = join(baseUrl, `${API_BASE_PATH}${fillRoute(API_ROUTES.chat.turn, { projectId })}`);
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(turn),
        signal
      });
      if (!res.ok || !res.body) {
        let body: unknown = null;
        try {
          body = await res.json();
        } catch {
          // no JSON body — fall through to a generic error
        }
        const err = body as Partial<ApiError> | null;
        throw new ApiClientError({
          error_code: err?.error_code ?? "AGENT_ERROR",
          message: err?.message ?? `Chat stream failed with status ${res.status}`
        });
      }
      return res;
    },

    async exportModel(projectId: string, body: ExportRequest): Promise<ExportResponse> {
      return request<ExportResponse>(fillRoute(API_ROUTES.exports.create, { projectId }), {
        method: "POST",
        body: JSON.stringify(body)
      });
    },

    /** `GET /api/projects/:projectId/params` — the Customizer schema + current values (Issue #33). */
    getParams(projectId: string): Promise<ParamsResponse> {
      return request<ParamsResponse>(fillRoute(API_ROUTES.params.get, { projectId }));
    },

    /**
     * `PUT /api/projects/:projectId/params` — partial update, merged and
     * validated server-side via the single `planParamUpdate` code path
     * (Issue #32). Resolves with the full merged `ParamsResponse`; rejects
     * with `ApiClientError{error_code:"VALIDATION_FAILED"}` if any supplied
     * value was rejected (no silent coerce, no partial apply).
     */
    updateParams(projectId: string, body: ParamsUpdateRequest): Promise<ParamsResponse> {
      return request<ParamsResponse>(fillRoute(API_ROUTES.params.update, { projectId }), {
        method: "PUT",
        body: JSON.stringify(body)
      });
    },

    /** `GET /projects/:projectId/source` — current source + params + head, with the opaque `revision` (Issue #54). */
    getSource(projectId: string): Promise<SourceResponse> {
      return request<SourceResponse>(fillRoute(API_ROUTES.source.get, { projectId }));
    },

    /**
     * `POST /projects/:projectId/source/preflight` — non-mutating dry run that
     * ENFORCES `base_revision` (stale → `CONFLICT`). On success returns the
     * confirmed current revision (equal to the request's `base_revision`) plus
     * the parameter drop the eventual PUT would require.
     */
    preflightSource(projectId: string, body: SourcePreflightRequest): Promise<SourcePreflightResponse> {
      return request<SourcePreflightResponse>(fillRoute(API_ROUTES.source.preflight, { projectId }), {
        method: "POST",
        body: JSON.stringify(body)
      });
    },

    /**
     * `PUT /projects/:projectId/source` — compare-and-swap save. Rejects with
     * `CONFLICT` (stale revision) or `VALIDATION_FAILED` (invalid syntax); it
     * revalidates server-side and never trusts the client.
     */
    updateSource(projectId: string, body: SourceUpdateRequest): Promise<SourceResponse> {
      return request<SourceResponse>(fillRoute(API_ROUTES.source.update, { projectId }), {
        method: "PUT",
        body: JSON.stringify(body)
      });
    },

    /** `POST /projects/:projectId/build` — pins the saved snapshot and attaches real renders/mesh/validation. */
    build(projectId: string, body: BuildRequest): Promise<BuildResponse> {
      return request<BuildResponse>(fillRoute(API_ROUTES.build.create, { projectId }), {
        method: "POST",
        body: JSON.stringify(body)
      });
    },

    // ── Editor API (S3-B routes, Issue #134 C1) ─────────────────────────────

    /** `GET /projects/:projectId/editor` — strict-parsed editor document. */
    getEditorDocument(projectId: string): Promise<EditorDocument> {
      return requestEditor(fillRoute(EDITOR_ROUTES.get, { projectId }), {}, parseEditorDocument);
    },

    /** `POST /projects/:projectId/editor/verify` — proof for one command, strict-parsed. */
    verifyEditorCommand(projectId: string, body: EditorVerifyRequest): Promise<EditorProofResponse> {
      return requestEditor(
        fillRoute(EDITOR_ROUTES.verify, { projectId }),
        { method: "POST", body: JSON.stringify(body) },
        parseEditorProofResponse
      );
    },

    /**
     * `POST /projects/:projectId/editor/commands` — the 200 body is a BARE
     * `EditorReceipt` (the real route does not wrap it in an
     * `EditorOperationResponse`; Issue #134 criterion 1). Strict-parsed: a
     * parse failure throws, never a best-effort object.
     */
    commitEditorCommand(projectId: string, body: EditorCommitRequest): Promise<EditorReceipt> {
      return requestEditor(
        fillRoute(EDITOR_ROUTES.commands, { projectId }),
        { method: "POST", body: JSON.stringify(body) },
        parseEditorReceipt
      );
    },

    /** `GET /projects/:projectId/editor/operations/:operationId` — strict-parsed operation state. */
    getEditorOperation(projectId: string, operationId: string): Promise<EditorOperationResponse> {
      return requestEditor(
        fillRoute(EDITOR_ROUTES.operation, { projectId, operationId }),
        {},
        parseEditorOperationResponse
      );
    },

    /** Fetches an exported file (e.g. the 3MF) as a `Blob` for client-side download. */
    async fetchExportFile(url: string): Promise<Blob> {
      const res = await fetchImpl(join(baseUrl, url));
      if (!res.ok) {
        throw new ApiClientError({ error_code: "EXPORT_FAILED", message: `Failed to download export (${res.status})` });
      }
      return res.blob();
    },

    resolveUrl(path: string): string {
      return join(baseUrl, path);
    },

    /**
     * Existence probe for a binary artifact (Issue #41's snapshot mesh).
     *
     * Returns a plain boolean rather than throwing: "this snapshot has no
     * mesh" is a normal answer, not a failure, and a caller that has to catch
     * an exception to learn it would be modelling it wrong. An unreachable
     * server also resolves `false` — the viewer's placeholder is the right
     * outcome either way.
     */
    async headRaw(url: string): Promise<boolean> {
      try {
        const res = await fetchImpl(join(baseUrl, url), { method: "HEAD" });
        return res.ok;
      } catch {
        return false;
      }
    }
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
