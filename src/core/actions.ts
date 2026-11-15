import { DEFAULT_RULES } from './config';
import { levelRank } from './fusion';
import type { ActionResult, AlertRule, Ctx, Incident, ThreatEvent } from './types';
import { AGENT_IDS, LEVELS } from './types';

export function alertText(ev: ThreatEvent): string {
  return `${ev.mode === 'DRILL' ? '[DRILL] ' : ''}SAFETY SENTINEL ${ev.level}: ${ev.summary}`;
}

export function ruleMatches(rule: AlertRule, ev: ThreatEvent): boolean {
  if (!rule.enabled || levelRank(ev.level) < levelRank(rule.minLevel)) return false;
  if (!rule.threats.length) return true;
  return rule.threats.includes(ev.threat) || ev.opinions.some((o) => o.score >= 0.5 && rule.threats.includes(o.agent));
}

/** Reject anything that is not a well-formed rule list (rules come from the browser). */
export function sanitizeRules(input: unknown): AlertRule[] {
  if (!Array.isArray(input)) throw new Error('rules must be a list');
  return input.slice(0, 20).map((r, i) => {
    const action = r?.action === 'sms' ? 'sms' : 'dispatch';
    const target = action === 'sms' ? String(r?.target ?? '').replace(/[^\d+]/g, '') : undefined;
    if (action === 'sms' && !/^\+[1-9]\d{7,14}$/.test(target!)) throw new Error(`rule ${i + 1}: phone must be in international format, e.g. +15551234567`);
    return {
      id: String(r?.id ?? `r-${i}`).slice(0, 40), name: String(r?.name ?? 'Alert').slice(0, 80), enabled: r?.enabled !== false,
      minLevel: LEVELS.includes(r?.minLevel) && r.minLevel !== 'SAFE' ? r.minLevel : 'HIGH',
      threats: Array.isArray(r?.threats) ? AGENT_IDS.filter((a) => r.threats.includes(a)) : [], action, target,
    };
  });
}

/**
 * The central action algorithm: runs once per threat event (EventBridge -> responder Lambda).
 * Applies every matching custom alert rule, records what happened, and tells the dashboards.
 */
export async function handleThreatEvent(ctx: Ctx, ev: ThreatEvent, broadcastNote?: string): Promise<Incident> {
  const rules = (await ctx.store.getRules()) ?? DEFAULT_RULES;
  const actions: ActionResult[] = [];
  if (broadcastNote) actions.push({ ruleId: 'topic', ruleName: 'Security team broadcast', action: 'broadcast', status: 'sent', detail: broadcastNote });
  for (const rule of rules.filter((r) => ruleMatches(r, ev))) {
    const base = { ruleId: rule.id, ruleName: rule.name, action: rule.action, target: rule.target };
    if (rule.action === 'sms') {
      try { actions.push({ ...base, status: 'sent', detail: await ctx.notifier.sms(rule.target!, alertText(ev)) }); }
      catch (e) { actions.push({ ...base, status: 'failed', detail: (e as Error).message }); }
    } else {
      // Never places a real emergency call. Records exactly what a dispatch integration would be handed.
      actions.push({ ...base, status: 'simulated', detail: `Simulated dispatch call. Packet: ${ev.level} ${ev.threat}${ev.subtype ? ` (${ev.subtype})` : ''} at "${ev.nodeName}", zone "${ev.zone}", ${ev.corroboratingNodes.length + 1} node(s) reporting.` });
    }
  }
  const incident: Incident = { ...ev, actions };
  await ctx.store.putIncident(incident);
  await broadcast(ctx, { type: 'incident', incident });
  ctx.log('incident', { id: ev.incidentId, level: ev.level, actions: actions.map((a) => `${a.action}:${a.status}`) });
  return incident;
}

export async function broadcast(ctx: Ctx, msg: unknown, alsoTo: string[] = []): Promise<void> {
  const conns = await ctx.store.listConns();
  const ids = new Set([...conns.filter((c) => c.role === 'dashboard').map((c) => c.connectionId), ...alsoTo]);
  await Promise.all([...ids].map(async (id) => { if (!(await ctx.push.send(id, msg))) await ctx.store.delConn(id); }));
}
