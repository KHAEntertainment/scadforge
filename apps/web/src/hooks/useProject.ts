import { useCallback, useEffect, useState } from "react";
import type { ProjectManifest } from "@scadforge/protocol";
import type { ApiClient } from "../lib/apiClient.js";

export interface UseProjectResult {
  projects: ProjectManifest[];
  selectedId: string | null;
  project: ProjectManifest | null;
  loading: boolean;
  error: string | null;
  creating: boolean;
  createError: string | null;
  selectProject: (id: string) => void;
  createProject: (name: string, scad?: string, options?: { select?: boolean }) => Promise<ProjectManifest | null>;
  reload: () => void;
}

/**
 * Ensures there is a current project to work against: reuses the first one
 * the server reports, or creates a default one when the project list is
 * empty. Project creation/selection UI is out of scope for Issue #18 — this
 * is the minimal seam the chat/preview/history panes need to have something
 * to point at.
 */
const LAST_PROJECT_KEY = "scadforge:last-project";

function readRememberedProject(): string | null {
  try { return sessionStorage.getItem(LAST_PROJECT_KEY); } catch { return null; }
}

function rememberProject(id: string): void {
  try { sessionStorage.setItem(LAST_PROJECT_KEY, id); } catch { /* storage is optional */ }
}

export function useProject(client: ApiClient): UseProjectResult {
  const [projects, setProjects] = useState<ProjectManifest[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [project, setProject] = useState<ProjectManifest | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    let cancelled = false;

    client.listProjects().then(({ projects: nextProjects }) => {
      if (cancelled) return;
      setProjects(nextProjects);
      setSelectedId((previous) => {
        const remembered = readRememberedProject();
        const next = previous && nextProjects.some((item) => item.id === previous)
          ? previous
          : remembered && nextProjects.some((item) => item.id === remembered)
            ? remembered
            : nextProjects[0]?.id ?? null;
        if (next) rememberProject(next);
        return next;
      });
    }).catch((cause) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : "Failed to load projects.");
      }).finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, refreshToken]);

  useEffect(() => {
    setProject(selectedId ? projects.find((item) => item.id === selectedId) ?? null : null);
  }, [projects, selectedId]);

  const selectProject = useCallback((id: string) => {
    setSelectedId(id);
    rememberProject(id);
  }, []);

  const createProject = useCallback(async (name: string, scad?: string, options: { select?: boolean } = {}) => {
    setCreating(true);
    setCreateError(null);
    try {
      const response = await client.createProject({ name, scad });
      setProjects((current) => [response.project, ...current]);
      if (options.select !== false) {
        setSelectedId(response.project.id);
        rememberProject(response.project.id);
      }
      return response.project;
    } catch (cause) {
      setCreateError(cause instanceof Error ? cause.message : "Failed to create project.");
      return null;
    } finally {
      setCreating(false);
    }
  }, [client]);

  return {
    projects,
    selectedId,
    project,
    loading,
    error,
    creating,
    createError,
    selectProject,
    createProject,
    reload: () => setRefreshToken((token) => token + 1)
  };
}
