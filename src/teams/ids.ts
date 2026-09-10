import { createHash } from 'node:crypto';

export interface EventIdentity {
  tenantId: string;
  conversationId: string;
  activityId: string;
}

// Caller validates provider identities first. Preserve their exact case/content.
// A versioned tuple avoids collisions caused by ambiguous delimiter concatenation.
export function createExternalEventId(identity: Readonly<EventIdentity>): string {
  const tuple = JSON.stringify([
    'teams-event-v1', identity.tenantId, identity.conversationId, identity.activityId,
  ]);
  return `teams:v1:${createHash('sha256').update(tuple, 'utf8').digest('hex')}`;
}
