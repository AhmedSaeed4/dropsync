'use client';

import { useState, useEffect, useCallback } from 'react';
import { createWorkspacesListener, createWorkspace, joinWorkspace, leaveWorkspace, deleteWorkspace } from '@/lib/workspaces';
import { Workspace } from '@/types';

const CURRENT_WORKSPACE_KEY = 'dropsync_current_workspace';

export function useWorkspaces(userId: string | null) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [currentWorkspaceId, setCurrentWorkspaceId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

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
  const leave = useCallback(async (workspaceId: string) => {
    if (!userId) return false;
    const result = await leaveWorkspace(userId, workspaceId);
    if (result && currentWorkspaceId === workspaceId) {
      switchWorkspace(null);
    }
    return result;
  }, [userId, currentWorkspaceId, switchWorkspace]);

  // Delete a workspace (owner only)
  const deleteWS = useCallback(async (workspaceId: string) => {
    if (!userId) return false;
    const result = await deleteWorkspace(userId, workspaceId);
    if (result && currentWorkspaceId === workspaceId) {
      switchWorkspace(null);
    }
    return result;
  }, [userId, currentWorkspaceId, switchWorkspace]);

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
    loading,
  };
}