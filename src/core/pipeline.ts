import { randomUUID } from 'node:crypto';
import { broadcast, sanitizeRules } from './actions';
import { deliberate, initialOpinions, observe } from './agents';
import { decodeMulaw, levels } from './audio';
import { CFG, DEFAULT_RULES } from './config';
import { levelOf, levelRank, nodeScore, round2, zoneScore } from './fusion';
import { llmDeliberate } from './llm';
import type { AudioObs, Ctx, MediaRecord, NodeState, Opinion, ThreatEvent, Tier, VisualObs, ZoneState } from './types';

const TIERS: Tier[] = ['critical', 'standard', 'peripheral'];
const clean = (s: unknown, max: number, fallback: string) => (String(s ?? '').replace(/[^\w .,'#()-]/g, '').trim().slice(0, max) || fallback);
const top = (m: Record<string, number>, n: number) => Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, n));

/** What dashboards and phones are shown about a node (no raw media, no connection ids). */
export function publicNode(n: NodeState, now: number) {
  return {
    nodeId: n.nodeId, name: n.name, zone: n.zone, tier: n.tier, online: n.online, lastSeen: n.lastSeen,
    score: n.score, level: n.level, opinions: n.opinions, llmStatus: n.llmStatus, drill: (n.simUntil ?? 0) > now,
    heard: n.audio ? { ...top(n.audio.classes, 4) } : undefined, peakDb: n.audio?.peakDb,
    seen: n.visual ? { ...top({ ...n.visual.labels, ...n.visual.moderation }, 6) } : undefined,
  };
}

// ---------- Ingest side: WebSocket messages from phones and dashboards ----------

export async function handleDisconnect(ctx: Ctx, connectionId: string): Promise<void> {
  const conn = await ctx.store.getConn(connectionId);
  await ctx.store.delConn(connectionId);
  if (conn?.role !== 'node' || !conn.nodeId) return;
  const node = await ctx.store.getNode(conn.nodeId);
  if (!node || node.connectionId !== connectionId) return;
  node.online = false; node.connectionId = undefined;
  await ctx.store.putNode(node);
  const nodes = await ctx.store.listNodes();
  await broadcast(ctx, { type: 'assessment', node: publicNode(node, ctx.now()), zone: zoneScore(node.zone, nodes, ctx.now()) });
}

export async function handleMessage(ctx: Ctx, connectionId: string, msg: any): Promise<void> {
  const reply = (m: unknown) => ctx.push.send(connectionId, m);
  const now = ctx.now();
  switch (msg?.action) {
    case 'ping': await reply({ type: 'pong', ts: now }); return;
    case 'hello': {
      if (ctx.joinCode && msg.code !== ctx.joinCode) { await reply({ type: 'error', code: 'bad_code', message: 'Wrong join code.' }); return; }
      if (msg.role === 'dashboard') {
        await ctx.store.putConn({ connectionId, role: 'dashboard' });
        const nodes = await ctx.store.listNodes();
        const zones = [...new Set(nodes.map((n) => n.zone))].map((z) => zoneScore(z, nodes, now));
        await reply({
          type: 'snapshot', nodes: nodes.map((n) => publicNode(n, now)), zones,
          incidents: await ctx.store.listIncidents(25), rules: (await ctx.store.getRules()) ?? DEFAULT_RULES,
          cfg: { levels: CFG.levels, tierWeight: CFG.tierWeight, severity: CFG.severity },
        });
        return;
      }
      const nodeId = clean(msg.nodeId, 40, randomUUID());
      const prev = await ctx.store.getNode(nodeId);
      const node: NodeState = {
        held: {}, opinions: [], score: 0, level: 'SAFE', scoredAt: now, joinedAt: now, ...prev,
        nodeId, name: clean(msg.name, 30, 'Node'), zone: clean(msg.zone, 30, 'Main'),
        tier: TIERS.includes(msg.tier) ? msg.tier : 'standard', connectionId, online: true, lastSeen: now,
      };
      await ctx.store.putConn({ connectionId, role: 'node', nodeId });
      await ctx.store.putNode(node);
      await reply({ type: 'welcome', node: publicNode(node, now), capture: { frameMs: 3000, frameMsHeightened: 1000, heightenedMs: CFG.heightenedMs } });
      const nodes = await ctx.store.listNodes();
      await broadcast(ctx, { type: 'assessment', node: publicNode(node, now), zone: zoneScore(node.zone, nodes, now) });
      return;
    }
    case 'frame': case 'audio': {
      const conn = await ctx.store.getConn(connectionId);
      if (conn?.role !== 'node' || !conn.nodeId) { await reply({ type: 'error', code: 'not_joined', message: 'Join first.' }); return; }
      const data = msg.action === 'frame' ? msg.jpeg : msg.mulaw;
      if (typeof data !== 'string' || data.length < 100 || data.length > 40_000) return;
      await ctx.enqueue(msg.action === 'frame' ? { type: 'frame', nodeId: conn.nodeId, ts: now, jpeg: data } : { type: 'audio', nodeId: conn.nodeId, ts: now, mulaw: data });
      return;
    }
    case 'simulate': case 'setRules': {
      const conn = await ctx.store.getConn(connectionId);
      if (conn?.role !== 'dashboard') return;
      if (msg.action === 'simulate') {
        if (!SCENARIOS[msg.scenario]) return;
        await ctx.enqueue({ type: 'sim', nodeId: String(msg.nodeId), ts: now, scenario: msg.scenario });
      } else {
        try { const rules = sanitizeRules(msg.rules); await ctx.store.putRules(rules); await broadcast(ctx, { type: 'rules', rules }); }
        catch (e) { await reply({ type: 'error', code: 'bad_rules', message: (e as Error).message }); }
      }
      return;
    }
  }
}

// ---------- Drill scenarios: injected observations that run through the real agents ----------

type Scenario = { audio?: Record<string, number>; peakDb?: number; labels?: Record<string, number>; moderation?: Record<string, number>; persons?: number; clear?: boolean };
export const SCENARIOS: Record<string, Scenario> = {
  gunshot: { audio: { 'Gunshot, gunfire': 0.82, Explosion: 0.3, 'Burst, pop': 0.2 }, peakDb: -2 },
  rifle: { labels: { Rifle: 93, Gun: 95, Weapon: 97, Person: 99 }, moderation: { Weapons: 88 }, persons: 1 },
  fight: { labels: { Person: 99, Fighting: 81 }, moderation: { 'Physical Violence': 84, Violence: 84 }, persons: 3, audio: { Screaming: 0.6, Shout: 0.7 }, peakDb: -8 },
  fire: { labels: { Fire: 96, Flame: 94, Smoke: 85 }, persons: 0, audio: { 'Smoke detector, smoke alarm': 0.8, 'Fire alarm': 0.6 }, peakDb: -10 },
  shooter: { audio: { 'Gunshot, gunfire': 0.9, 'Machine gun': 0.4, Screaming: 0.7 }, peakDb: -1, labels: { Rifle: 90, Gun: 94, Weapon: 96, Person: 99 }, moderation: { Weapons: 90, Violence: 60 }, persons: 4 },
  fireworks: { audio: { Fireworks: 0.85, 'Gunshot, gunfire': 0.3, 'Burst, pop': 0.5 }, peakDb: -9 },
  clear: { clear: true },
};

// ---------- Analyzer side: one media record -> perception -> agents -> fusion -> alert ----------

/** Kinesis hands us a batch. Keep order per node, but only analyse each node's newest frame. */
export async function processRecords(ctx: Ctx, records: MediaRecord[]): Promise<void> {
  const lastFrame = new Map<string, MediaRecord>();
  for (const r of records) if (r.type === 'frame') lastFrame.set(r.nodeId, r);
  const byNode = new Map<string, MediaRecord[]>();
  for (const r of records) {
    if (r.type === 'frame' && lastFrame.get(r.nodeId) !== r) continue;
    byNode.set(r.nodeId, [...(byNode.get(r.nodeId) ?? []), r]);
  }
  await Promise.all([...byNode.values()].map(async (list) => {
    for (const r of list) {
      try { await processMedia(ctx, r); } catch (e) { ctx.log('processMedia failed', { nodeId: r.nodeId, type: r.type, error: (e as Error).message }); }
    }
  }));
}

export async function processMedia(ctx: Ctx, rec: MediaRecord): Promise<void> {
  const node = await ctx.store.getNode(rec.nodeId);
  if (!node) return;
  const now = ctx.now();
  const fresh: { audio?: AudioObs; visual?: VisualObs } = {};
  let thumb: string | undefined;

  if (rec.type === 'frame') {
    fresh.visual = { ts: now, ...(await ctx.vision.analyze(Buffer.from(rec.jpeg, 'base64'))) };
    thumb = rec.jpeg;
  } else if (rec.type === 'audio') {
    const pcm = decodeMulaw(Buffer.from(rec.mulaw, 'base64'));
    const classes = await ctx.audioModel.classify(pcm);
    fresh.audio = { ts: now, classes: Object.fromEntries(Object.entries(classes).filter(([, s]) => s >= 0.03).map(([k, s]) => [k, round2(s)])), ...levels(pcm) };
  } else {
    const sc = SCENARIOS[rec.scenario];
    if (!sc) return;
    if (sc.clear) { node.held = {}; node.simUntil = undefined; node.audio = undefined; node.visual = undefined; }
    else {
      node.simUntil = now + 30_000;
      if (sc.audio) fresh.audio = { ts: now, classes: sc.audio, peakDb: sc.peakDb ?? -6, rmsDb: (sc.peakDb ?? -6) - 12, crest: 4 };
      if (sc.labels || sc.moderation) fresh.visual = { ts: now, labels: sc.labels ?? {}, moderation: sc.moderation ?? {}, persons: sc.persons ?? 0 };
    }
  }
  if (fresh.audio) node.audio = fresh.audio;
  if (fresh.visual) node.visual = fresh.visual;

  // Round 1: specialists score their own evidence. Round 2 (rules): they hear each other and peer nodes.
  observe(node, now, fresh);
  const initial = initialOpinions(node, now);
  let nodes = await ctx.store.listNodes();
  const peers = nodes.filter((n) => n.nodeId !== node.nodeId && n.zone === node.zone && n.online && now - n.scoredAt < 30_000)
    .sort((a, b) => b.score - a.score);
  const apply = (ops: Opinion[]) => { node.opinions = ops; node.score = nodeScore(ops); node.level = levelOf(node.score); node.scoredAt = now; node.lastSeen = now; };
  apply(deliberate(initial, peers[0]?.score ?? 0, peers[0]?.name));

  const wantLlm = !!ctx.llm && Math.max(...initial.map((o) => o.initial)) >= CFG.llmMinScore && now - (node.llmAt ?? 0) >= CFG.llmMinIntervalMs;
  if (wantLlm) node.llmAt = now;
  await ctx.store.putNode(node);
  nodes = nodes.map((n) => (n.nodeId === node.nodeId ? node : n));
  // Fast path: publish and alert on the rule-based result immediately; never wait on the LLM to raise an alarm.
  await publish(ctx, node, nodes, thumb);

  if (wantLlm) {
    const peerInfo = peers.slice(0, 5).map((p) => ({ name: p.name, tier: p.tier, score: p.score, top: [...p.opinions].sort((a, b) => b.score - a.score)[0]?.agent }));
    const res = await llmDeliberate(ctx.llm!, node, initial, node.opinions, peerInfo);
    node.llmStatus = res.ok ? `LLM specialists revised ${res.ok}/4 opinions` : `LLM unavailable (${res.error}); rule-based opinions used`;
    if (res.ok) apply(res.opinions);
    await ctx.store.putNode(node);
    await publish(ctx, node, nodes, undefined);
  }
}

async function publish(ctx: Ctx, node: NodeState, nodes: NodeState[], thumb?: string): Promise<void> {
  const now = ctx.now();
  const zone = zoneScore(node.zone, nodes, now);
  await broadcast(ctx, { type: 'assessment', node: publicNode(node, now), zone, thumb }, node.connectionId ? [node.connectionId] : []);

  // Nodes talk to each other: a node that senses danger puts its zone peers on heightened capture.
  if (levelRank(node.level) >= levelRank('ELEVATED') && now - (node.lastDirectiveAt ?? 0) > CFG.heightenedMs / 2) {
    node.lastDirectiveAt = now;
    await ctx.store.putNode(node);
    const lead = [...node.opinions].sort((a, b) => b.score - a.score)[0];
    await Promise.all(nodes.filter((n) => n.nodeId !== node.nodeId && n.zone === node.zone && n.online && n.connectionId)
      .map((n) => ctx.push.send(n.connectionId!, { type: 'directive', mode: 'heightened', ms: CFG.heightenedMs, reason: `${node.name} reports possible ${lead.agent} (${Math.round(lead.score * 100)}%)` })));
  }
  await maybeAlert(ctx, node, zone, nodes, now);
}

async function maybeAlert(ctx: Ctx, node: NodeState, zone: ZoneState, nodes: NodeState[], now: number): Promise<void> {
  if (levelRank(zone.level) < levelRank(CFG.alertMinLevel)) return;
  const prev = await ctx.store.getZone(zone.zone);
  const inCooldown = prev?.lastAlertAt !== undefined && now - prev.lastAlertAt < CFG.alertCooldownMs;
  if (inCooldown && levelRank(zone.level) <= levelRank(prev!.lastAlertLevel ?? 'SAFE')) return;
  await ctx.store.putZone({ ...zone, lastAlertAt: now, lastAlertLevel: zone.level });

  // Report the node contributing most to the zone, and its leading threat.
  const leadNode = nodes.find((n) => n.nodeId === zone.contributors[0]?.nodeId) ?? node;
  const lead = [...leadNode.opinions].sort((a, b) => CFG.severity[b.agent] * b.score - CFG.severity[a.agent] * a.score)[0];
  const others = zone.contributors.filter((c) => c.nodeId !== leadNode.nodeId && c.contribution >= CFG.levels.ELEVATED).map((c) => c.name);
  const ev: ThreatEvent = {
    incidentId: randomUUID(), ts: now, mode: nodes.some((n) => n.zone === zone.zone && (n.simUntil ?? 0) > now) ? 'DRILL' : 'LIVE',
    zone: zone.zone, level: zone.level, zoneScore: zone.score,
    nodeId: leadNode.nodeId, nodeName: leadNode.name, nodeScore: leadNode.score,
    threat: lead.agent, subtype: lead.subtype,
    summary: `${lead.agent}${lead.subtype ? ` (${lead.subtype})` : ''} ${Math.round(lead.score * 100)}% at "${leadNode.name}" (${leadNode.tier} position), zone "${zone.zone}" danger ${Math.round(zone.score * 100)}%` + (others.length ? `; also reported by ${others.join(', ')}` : ''),
    opinions: leadNode.opinions.map((o) => ({ agent: o.agent, score: o.score, rationale: o.rationale })),
    corroboratingNodes: others,
  };
  await ctx.emit(ev);
}
