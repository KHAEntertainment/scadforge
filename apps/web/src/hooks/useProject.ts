import { useEffect, useState } from "react";
import type { ProjectManifest } from "@scadforge/protocol";
import type { ApiClient } from "../lib/apiClient.js";

export interface UseProjectResult {
  project: ProjectManifest | null;
  loading: boolean;
  error: string | null;
}

/**
 * Ensures there is a current project to work against: reuses the first one
 * the server reports, or creates a default one when the project list is
 * empty. Project creation/selection UI is out of scope for Issue #18 — this
 * is the minimal seam the chat/preview/history panes need to have something
 * to point at.
 */
export function useProject(client: ApiClient): UseProjectResult {
  const [project, setProject] = useState<ProjectManifest | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function ensureProject() {
      try {
        const { projects } = await client.listProjects();
        if (cancelled) return;
        if (projects.length > 0) {
          setProject(projects[0]);
          return;
        }
        const created = await client.createProject({ name: "untitled" });
        if (cancelled) return;
        setProject(created.project);
      } catch (cause) {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : "Failed to load or create a project.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void ensureProject();
    return () => {
      cancelled = true;
    };
  }, [client]);

  return { project, loading, error };
}
