import { CFG } from './config';
import type { Level, NodeState, Opinion, ZoneState } from './types';

export const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
export const round2 = (x: number) => Math.round(x * 100) / 100;
/** Noisy-OR: independent pieces of evidence add up without ever exceeding 1. */
export const noisyOr = (xs: number[]) => 1 - xs.reduce((p, x) => p * (1 - clamp01(x)), 1);
export const decay = (ageMs: number, halfLifeMs: number) => Math.pow(0.5, Math.max(0, ageMs) / halfLifeMs);

export function levelOf(score: number): Level {
  if (score >= CFG.levels.CRITICAL) return 'CRITICAL';
  if (score >= CFG.levels.HIGH) return 'HIGH';
  if (score >= CFG.levels.ELEVATED) return 'ELEVATED';
  return 'SAFE';
}
export const levelRank = (l: Level) => ['SAFE', 'ELEVATED', 'HIGH', 'CRITICAL'].indexOf(l);

/** One node's danger: each agent's final score weighted by how severe that threat type is. */
export function nodeScore(opinions: Opinion[]): number {
  return round2(noisyOr(opinions.map((o) => CFG.severity[o.agent] * o.score)));
}

/** A zone's danger: every online node contributes its score x position weight x freshness. */
export function zoneScore(zone: string, nodes: NodeState[], now: number): ZoneState {
  const contributors = nodes
    .filter((n) => n.zone === zone && n.online)
    .map((n) => ({
      nodeId: n.nodeId, name: n.name, tier: n.tier,
      contribution: round2(n.score * CFG.tierWeight[n.tier] * decay(now - n.scoredAt, CFG.nodeHalfLifeMs)),
    }))
    .sort((a, b) => b.contribution - a.contribution);
  const score = round2(noisyOr(contributors.map((c) => c.contribution)));
  return { zone, score, level: levelOf(score), contributors };
}
