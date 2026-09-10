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

import { API_BASE_PATH, API_ROUTES } from "@scadforge/protocol";
import type {
  ApiError,
  BuildRequest,
  BuildResponse,
  ChatTurnRequest,
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

/** Thrown for any non-2xx response. Carries the frozen `{error_code, message}` body. */
export class ApiClientError extends Error {
  readonly error_code: ApiError["error_code"];

  constructor(error: ApiError) {
    super(error.message);
    this.name = "ApiClientError";
    this.error_code = error.error_code;
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
      throw new ApiClientError({
        error_code: "INTERNAL_ERROR",
        message: `Could not reach the ScadForge API at ${url}. Is the server running? (${
          cause instanceof Error ? cause.message : String(cause)
        })`
      });
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
      throw new ApiClientError({
        error_code: err?.error_code ?? "INTERNAL_ERROR",
        message: err?.message ?? `Request failed with status ${res.status}`
      });
    }

    if (parseFailed) {
      throw new ApiClientError({
        error_code: "INTERNAL_ERROR",
        message: `Received a non-JSON response (status ${res.status}) from ${url}. This usually means the dev proxy isn't forwarding /api to the API server, or the wrong baseUrl is configured.`
      });
    }

    return body as T;
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
