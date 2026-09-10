import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectManifest } from "@scadforge/protocol";
import type { ApiClient } from "../lib/apiClient.js";

const LAST_PROJECT_KEY = "scadforge:last-project";

function readLastProject(): string | null {
  try {
    return sessionStorage.getItem(LAST_PROJECT_KEY);
  } catch {
    return null;
  }
}

function writeLastProject(id: string): void {
  try {
    sessionStorage.setItem(LAST_PROJECT_KEY, id);
  } catch {
    // storage blocked — the selection simply won't survive a refresh.
  }
}

export interface UseProjectsResult {
  projects: ProjectManifest[];
  /** The remembered/explicit selection; null while loading or when there are no projects. */
  selectedId: string | null;
  /** The selected project manifest; null when there is none (empty state). */
  project: ProjectManifest | null;
  loading: boolean;
  error: string | null;
  creating: boolean;
  createError: string | null;
  selectProject: (id: string) => void;
  createProject: (name: string, scad?: string) => Promise<ProjectManifest | null>;
  reload: () => void;
}

/**
 * Project list + selection + creation (Issue #54 studio workspace).
 *
 * Replaces the Issue #18 "reuse first / auto-create" seam with an explicit
 * selector: the last selected project id is remembered per tab
 * (sessionStorage) and restored on refresh; an empty project list shows an
 * explicit empty state rather than silently manufacturing an "untitled"
 * project.
 */
export function useProjects(client: ApiClient): UseProjectsResult {
  const [projects, setProjects] = useState<ProjectManifest[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  /** True once the first list fetch has completed, so selection restoration only happens once. */
  const hydratedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    client
      .listProjects()
      .then((res) => {
        if (cancelled) return;
        setProjects(res.projects);
        if (!hydratedRef.current) {
          hydratedRef.current = true;
          const remembered = readLastProject();
          const fallback = res.projects[0]?.id ?? null;
          const next = remembered && res.projects.some((p) => p.id === remembered) ? remembered : fallback;
          setSelectedId(next);
          if (next) writeLastProject(next);
        } else {
          // Keep the current selection if it still exists; otherwise fall back
          // to the newest/first project.
          setSelectedId((prev) => {
            if (prev && res.projects.some((p) => p.id === prev)) return prev;
            const fallback = res.projects[0]?.id ?? null;
            if (fallback) writeLastProject(fallback);
            return fallback;
          });
        }
      })
      .catch((cause) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : "Failed to load projects.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, refreshToken]);

  const project = selectedId ? (projects.find((p) => p.id === selectedId) ?? null) : null;

  const selectProject = useCallback((id: string) => {
    setSelectedId(id);
    writeLastProject(id);
  }, []);

  const createProject = useCallback(
    async (name: string, scad?: string): Promise<ProjectManifest | null> => {
      setCreating(true);
      setCreateError(null);
      try {
        const created = await client.createProject({ name, scad });
        setProjects((prev) => [created.project, ...prev]);
        setSelectedId(created.project.id);
        writeLastProject(created.project.id);
        return created.project;
      } catch (cause) {
        setCreateError(cause instanceof Error ? cause.message : "Failed to create a project.");
        return null;
      } finally {
        setCreating(false);
      }
    },
    [client]
  );

  const reload = useCallback(() => setRefreshToken((token) => token + 1), []);

  return { projects, selectedId, project, loading, error, creating, createError, selectProject, createProject, reload };
}
