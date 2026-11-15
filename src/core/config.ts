import type { AgentId, AlertRule, Level, Tier } from './types';

/** All tunable numbers of the scoring algorithm live here. */
export const CFG = {
  /** Lower bounds of each level on the 0..1 danger scale. */
  levels: { ELEVATED: 0.25, HIGH: 0.5, CRITICAL: 0.75 } as Record<Exclude<Level, 'SAFE'>, number>,
  /** How bad each threat type is when the agent is fully certain. */
  severity: { gunshot: 1.0, weapon: 0.95, altercation: 0.75, hazard: 0.7 } as Record<AgentId, number>,
  /** Idea 2 from the judges: nodes in critical positions count for more. */
  tierWeight: { critical: 1.0, standard: 0.8, peripheral: 0.6 } as Record<Tier, number>,
  /** Evidence held by an agent halves every this many ms. */
  holdHalfLifeMs: 10_000,
  /** A node's contribution to its zone halves every this many ms without fresh data. */
  nodeHalfLifeMs: 15_000,
  /** Cross-agent influence used by the rule-based round 2: influence[a][b] = how much b's opinion lifts a. */
  influence: {
    gunshot: { weapon: 0.3, altercation: 0.15 },
    weapon: { gunshot: 0.25 },
    altercation: { gunshot: 0.2, weapon: 0.2 },
    hazard: { gunshot: 0.15 },
  } as Record<AgentId, Partial<Record<AgentId, number>>>,
  /** How much a threat on a peer node in the same zone lifts an agent that already has some evidence. */
  peerInfluence: 0.15,
  peerMinOwnScore: 0.15,
  /** LLM specialists may move a score at most this far from its round-1 value. */
  llmMaxShift: 0.3,
  /** Only ask the LLM when some agent's round-1 score is at least this, and at most this often per node. */
  llmMinScore: 0.3, llmMinIntervalMs: 5_000, llmTimeoutMs: 8_000,
  /** One alert per zone per cooldown, unless the level rises. */
  alertCooldownMs: 45_000,
  alertMinLevel: 'HIGH' as Level,
  heightenedMs: 20_000,
};

export const DEFAULT_RULES: AlertRule[] = [
  { id: 'r-dispatch', name: 'Dial police — gunfire or weapon', enabled: true, minLevel: 'CRITICAL', threats: ['gunshot', 'weapon'], action: 'dispatch' },
];
