import type { Drop } from '@/types';

export interface AgentDropScope {
  workspaceId: string | null;
  userId?: string;
  ready: boolean;
}

// Agent-only pointer policy; group policy stays independent.
export function isAgentDropEligible(drop: Drop | undefined, scope: AgentDropScope, now = Date.now()): drop is Drop {
  return !!drop && !!scope.userId && scope.ready && drop.workspaceId === scope.workspaceId &&
    (scope.workspaceId !== null || drop.userId === scope.userId) &&
    (drop.type === 'text' || drop.type === 'file') && !drop.isStaged &&
    (drop.expiresAt === null || drop.expiresAt.getTime() > now);
}
