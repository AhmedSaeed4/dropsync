'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { createWorkspacesListener, createWorkspace, joinWorkspace, leaveWorkspace, deleteWorkspace, kickWorkspaceMember } from '@/lib/workspaces';
import { Workspace } from '@/types';

const CURRENT_WORKSPACE_KEY = 'dropsync_current_workspace';

export interface UseWorkspacesOptions {
  // Fired when a workspace the user belonged to disappears from the listener AND it was NOT a
  // locally-initiated leave/delete (i.e. the user was removed by the owner, or the workspace was
  // deleted by its owner). Receives the workspace as it was last seen (id + name used for the
  // notice). Stored in a ref so the listener never re-subscribes when this callback changes.
  onWorkspaceRemoved?: (workspace: Workspace) => void;
}

export function useWorkspaces(userId: string | null, options?: UseWorkspacesOptions) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [currentWorkspaceId, setCurrentWorkspaceId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Latest removal callback (ref, not dep) — the listener reads onRemovedRef.current so a new
  // callback identity from the parent doesn't tear down + re-create the Firestore subscription.
  const onRemovedRef = useRef(options?.onWorkspaceRemoved);
  onRemovedRef.current = options?.onWorkspaceRemoved;

  // Previous workspace list, used to detect removals between emissions. Starts EMPTY so the very
  // first load (incl. page refresh) does not false-fire a "you were removed" notice.
  const prevWorkspacesRef = useRef<Workspace[]>([]);
  // Workspace ids the LOCAL user removed themselves (via leave/delete). Suppresses the removal
  // notice for those — only server-side removals (kick / owner-delete) should toast.
  const locallyRemovedRef = useRef<Set<string>>(new Set());

  // Load saved workspace from localStorage
  useEffect(() => {
    if (userId) {
      const saved = localStorage.getItem(CURRENT_WORKSPACE_KEY);
      if (saved) {
        setCurrentWorkspaceId(saved);
      }
    }
  }, [userId]);

  // Subscribe to workspaces
  useEffect(() => {
    if (!userId) {
      setWorkspaces([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    const unsubscribe = createWorkspacesListener(userId, (userWorkspaces) => {
      // Detect workspaces present in the previous emission but absent now, that the local user did
      // NOT remove themselves. prevWorkspacesRef is empty on the first emission → nothing fires.
      const prev = prevWorkspacesRef.current;
      if (prev.length > 0) {
        for (const p of prev) {
          const stillPresent = userWorkspaces.some((w) => w.id === p.id);
          if (!stillPresent && !locallyRemovedRef.current.has(p.id)) {
            onRemovedRef.current?.(p);
          }
        }
      }
      // A workspace that is PRESENT again is back in good standing — clear any stale locally-removed
      // flag so a LATER genuine removal (kick / owner-delete) correctly fires the notice. leave and
      // delete do NOT rotate the invite code, so rejoining the same workspace with the old code is
      // possible; without this cleanup, a leave→rejoin→kick sequence would be permanently silenced.
      userWorkspaces.forEach((w) => locallyRemovedRef.current.delete(w.id));
      prevWorkspacesRef.current = userWorkspaces;

      setWorkspaces(userWorkspaces);
      setLoading(false);

      // If current workspace no longer exists, reset to personal
      if (currentWorkspaceId && !userWorkspaces.find(w => w.id === currentWorkspaceId)) {
        setCurrentWorkspaceId(null);
        localStorage.removeItem(CURRENT_WORKSPACE_KEY);
      }
    });

    return unsubscribe;
  }, [userId, currentWorkspaceId]);

  // Switch to a workspace
  const switchWorkspace = useCallback((workspaceId: string | null) => {
    setCurrentWorkspaceId(workspaceId);
    if (workspaceId) {
      localStorage.setItem(CURRENT_WORKSPACE_KEY, workspaceId);
    } else {
      localStorage.removeItem(CURRENT_WORKSPACE_KEY);
    }
  }, []);

  // Create a new workspace
  const create = useCallback(async (name: string) => {
    if (!userId) return null;
    return await createWorkspace(userId, name);
  }, [userId]);

  // Join a workspace
  const join = useCallback(async (inviteCode: string) => {
    if (!userId) return { workspace: null, error: 'Not authenticated' };
    return await joinWorkspace(userId, inviteCode);
  }, [userId]);

  // Leave a workspace
  const leave = useCallback(async (workspaceId: string, newOwnerId?: string) => {
    if (!userId) return false;
    // Mark as locally-removed BEFORE the write so the listener emission doesn't fire the
    // "you were removed" notice for our own leave. Roll back if the leave actually failed.
    locallyRemovedRef.current.add(workspaceId);
    const result = await leaveWorkspace(userId, workspaceId, newOwnerId);
    if (!result) locallyRemovedRef.current.delete(workspaceId);
    if (result && currentWorkspaceId === workspaceId) {
      switchWorkspace(null);
    }
    return result;
  }, [userId, currentWorkspaceId, switchWorkspace]);

  // Delete a workspace (owner only)
  const deleteWS = useCallback(async (workspaceId: string) => {
    if (!userId) return false;
    locallyRemovedRef.current.add(workspaceId);
    const result = await deleteWorkspace(userId, workspaceId);
    if (!result) locallyRemovedRef.current.delete(workspaceId);
    if (result && currentWorkspaceId === workspaceId) {
      switchWorkspace(null);
    }
    return result;
  }, [userId, currentWorkspaceId, switchWorkspace]);

  // Owner kicks (removes) another member. The OWNER stays in the workspace — do NOT reset
  // currentWorkspaceId (unlike leave/delete). No locally-removed marking: the owner isn't removed.
  const kick = useCallback(async (workspaceId: string, memberUid: string) => {
    if (!userId) return false;
    return await kickWorkspaceMember(userId, workspaceId, memberUid);
  }, [userId]);

  // Get current workspace
  const currentWorkspace = workspaces.find(w => w.id === currentWorkspaceId) || null;

  return {
    workspaces,
    currentWorkspace,
    currentWorkspaceId,
    switchWorkspace,
    create,
    join,
    leave,
    deleteWS,
    kick,
    loading,
  };
}
