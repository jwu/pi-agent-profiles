/**
 * Event a session that runs as an agent emits on `pi.events` to announce its own delegation
 * scope. `pi --agent` emits it, and the delegation extensions listen for it.
 */
export const delegationScopeEvent = 'pi-subagents:configure';

/** Payload of {@link delegationScopeEvent}. An omitted field adds no limit. */
export interface DelegationScope {
  /** Profiles the session may delegate to. An empty list allows none. */
  allowedAgents?: string[];
  /** The `maxDepth` of the session's profile, counted from the session's own level. */
  maxDepth?: number;
}

/** Read an event payload from another extension. A field with an unexpected type is dropped. */
export function parseDelegationScope(value: unknown): DelegationScope {
  const { allowedAgents, maxDepth } = (value && typeof value === 'object' ? value : {}) as {
    allowedAgents?: unknown;
    maxDepth?: unknown;
  };
  return {
    allowedAgents: Array.isArray(allowedAgents)
      ? allowedAgents.filter((name): name is string => typeof name === 'string')
      : undefined,
    maxDepth:
      typeof maxDepth === 'number' && Number.isSafeInteger(maxDepth) && maxDepth >= 0
        ? maxDepth
        : undefined,
  };
}

/**
 * The deepest level that may still delegate, for an agent at `depth` whose profile declares
 * `maxDepth`. The lead session is at depth 0 and its first child at depth 1. An agent delegates
 * while its depth is at most this limit.
 *
 * A profile's `maxDepth` counts the levels below the agent itself, wherever it runs. A descendant
 * can tighten the limit it inherits, not widen it.
 */
export function delegationDepthLimit(
  depth: number,
  maxDepth: number | undefined,
  inherited?: number,
): number | undefined {
  if (maxDepth === undefined) return inherited;
  const own = depth + maxDepth - 1;
  return inherited === undefined ? own : Math.min(own, inherited);
}

/**
 * The agents a session may delegate to: `names` limited to the `inherited` list, in the order of
 * `names`. An omitted list adds no restriction, so the other list is returned as it is.
 */
export function narrowAllowedAgents(
  names: readonly string[] | undefined,
  inherited: readonly string[] | undefined,
): string[] | undefined {
  if (!names) return inherited ? [...new Set(inherited)] : undefined;
  const allowed = inherited ? new Set(inherited) : undefined;
  return [...new Set(names)].filter((name) => !allowed || allowed.has(name));
}
