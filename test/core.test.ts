import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleThreatEvent, sanitizeRules } from '../src/core/actions';
import { deliberate, initialOpinions, observe, SPECIALISTS } from '../src/core/agents';
import { decodeMulaw, encodeMulaw } from '../src/core/audio';
import { levelOf, zoneScore } from '../src/core/fusion';
import { llmDeliberate } from '../src/core/llm';
import { handleMessage, processRecords } from '../src/core/pipeline';
import type { Ctx, Incident, NodeState, Tier } from '../src/core/types';
import { MemoryStore } from '../src/local/memory-store';

const audio = (classes: Record<string, number>, peakDb = -3) => ({ ts: 0, classes, peakDb, rmsDb: peakDb - 12, crest: 4 });
const visual = (labels: Record<string, number>, moderation: Record<string, number> = {}, persons = 1) => ({ ts: 0, labels, moderation, persons });
const node = (over: Partial<NodeState> = {}): NodeState => ({ nodeId: 'n1', name: 'N1', zone: 'Z', tier: 'standard', online: true, joinedAt: 0, lastSeen: 0, held: {}, opinions: [], score: 0, level: 'SAFE', scoredAt: 0, ...over });

test('mu-law round trip keeps the waveform', () => {
  const pcm = Float32Array.from({ length: 2000 }, (_, i) => 0.8 * Math.sin(i / 7));
  const back = decodeMulaw(encodeMulaw(pcm));
  let err = 0; for (let i = 0; i < pcm.length; i++) err = Math.max(err, Math.abs(pcm[i] - back[i]));
  assert.ok(err < 0.04, `max error ${err}`);
});

test('gunshot agent: gunfire is high, fireworks and claps are not', () => {
  // Class scores below are what YAMNet returned for real field recordings (see README, "How detection was checked").
  assert.ok(SPECIALISTS.gunshot(audio({ 'Gunshot, gunfire': 0.56, 'Machine gun': 0.47, Explosion: 0.66 })).score >= 0.75);
  assert.ok(SPECIALISTS.gunshot(audio({ 'Gunshot, gunfire': 0.53, Explosion: 0.69, Firecracker: 0.4 }, -15)).score >= 0.5);
  assert.ok(SPECIALISTS.gunshot(audio({ Fireworks: 0.85, 'Gunshot, gunfire': 0.3, 'Burst, pop': 0.5 }, -9)).score < 0.5);
  assert.ok(SPECIALISTS.gunshot(audio({ Clapping: 0.87, Hands: 0.8 })).score < 0.05);
});

test('weapon agent: rifle outranks blade and reports its subtype', () => {
  const rifle = SPECIALISTS.weapon(undefined, visual({ Rifle: 93, Gun: 95, Weapon: 97, Person: 99 }));
  const knife = SPECIALISTS.weapon(undefined, visual({ Knife: 93, Person: 99 }));
  assert.equal(rifle.subtype, 'rifle'); assert.ok(rifle.score > 0.9); assert.ok(knife.score < rifle.score);
  assert.ok(SPECIALISTS.weapon(undefined, visual({ Rifle: 93 }, {}, 0)).score < rifle.score, 'no person in frame lowers it');
});

test('agents raise each other when they corroborate, but cannot invent a threat alone', () => {
  const n = node();
  observe(n, 1000, { audio: audio({ 'Gunshot, gunfire': 0.35 }, -10), visual: visual({ Rifle: 90, Gun: 92, Person: 99 }) });
  const initial = initialOpinions(n, 1000);
  const final = deliberate(initial, 0);
  const g0 = initial.find((o) => o.agent === 'gunshot')!, g1 = final.find((o) => o.agent === 'gunshot')!;
  assert.ok(g1.score > g0.score + 0.1, 'a visible rifle makes the bang more likely a shot');
  assert.match(g1.rationale, /Weapon agent/);
  const quiet = deliberate(initialOpinions(Object.assign(node(), { held: { gunshot: { score: 0.9, ts: 1000, evidence: [] } } }), 1000), 0);
  assert.ok(quiet.find((o) => o.agent === 'weapon')!.score < 0.15, 'weapon agent has no camera evidence');
});

test('evidence decays instead of vanishing', () => {
  const n = node(); observe(n, 0, { audio: audio({ 'Gunshot, gunfire': 0.8 }) });
  const s = (t: number) => initialOpinions(n, t).find((o) => o.agent === 'gunshot')!.score;
  assert.ok(s(0) > 0.9); assert.ok(s(10_000) < s(0) * 0.55 && s(10_000) > 0.4); assert.ok(s(60_000) < 0.05);
});

test('zone fusion: critical positions count for more, and nodes corroborate', () => {
  const at = (id: string, tier: Tier, score: number) => node({ nodeId: id, name: id, tier, score, scoredAt: 0 });
  const alone = (tier: Tier) => zoneScore('Z', [at('a', tier, 0.8)], 0).score;
  assert.ok(alone('critical') > alone('standard') && alone('standard') > alone('peripheral'));
  assert.equal(levelOf(alone('critical')), 'CRITICAL'); assert.equal(levelOf(alone('peripheral')), 'ELEVATED');
  const two = zoneScore('Z', [at('a', 'peripheral', 0.8), at('b', 'peripheral', 0.8)], 0);
  assert.equal(two.level, 'HIGH', 'two peripheral nodes agreeing outrank one');
  assert.ok(zoneScore('Z', [at('a', 'critical', 0.8)], 30_000).score < 0.25, 'stale readings fade');
});

test('LLM round is clamped and falls back per agent', async () => {
  const n = node(); observe(n, 0, { audio: audio({ 'Gunshot, gunfire': 0.3 }, -10) });
  const initial = initialOpinions(n, 0), rules = deliberate(initial, 0);
  const g0 = initial.find((o) => o.agent === 'gunshot')!.initial;
  const res = await llmDeliberate({ complete: async (system) => { if (system.includes('WEAPON')) throw new Error('boom'); return 'Sure: {"score": 1, "confidence": 0.9, "rationale": "x"}'; } }, n, initial, rules, []);
  assert.equal(res.ok, 3);
  const g = res.opinions.find((o) => o.agent === 'gunshot')!;
  assert.equal(g.by, 'llm'); assert.ok(Math.abs(g.score - (g0 + 0.3)) < 0.011, 'cannot move more than 0.3 from round 1');
  assert.equal(res.opinions.find((o) => o.agent === 'weapon')!.by, 'rules');
  assert.ok(res.opinions.find((o) => o.agent === 'hazard')!.score <= 0.3, 'an agent with no evidence cannot be pushed past the clamp');
});

function memoryCtx() {
  const sent: { to: string; msg: any }[] = []; const sms: string[] = []; const incidents: Incident[] = []; let t = 1_000_000;
  const ctx: Ctx = {
    store: new MemoryStore(), push: { async send(to, msg) { sent.push({ to, msg }); return true; } },
    vision: { async analyze() { return { labels: {}, moderation: {}, persons: 0 }; } }, audioModel: { async classify() { return {}; } },
    notifier: { async sms(phone, text) { sms.push(`${phone}: ${text}`); return 'ok'; } },
    async enqueue(rec) { await processRecords(ctx, [rec]); },
    async emit(ev) { incidents.push(await handleThreatEvent(ctx, ev)); },
    now: () => t, log: () => {},
  };
  return { ctx, sent, sms, incidents, tick: (ms: number) => { t += ms; } };
}

test('pipeline: drill on a critical node raises one incident, runs alert rules, alerts peers', async () => {
  const { ctx, sent, sms, incidents, tick } = memoryCtx();
  await handleMessage(ctx, 'd1', { action: 'hello', role: 'dashboard' });
  await handleMessage(ctx, 'c1', { action: 'hello', role: 'node', nodeId: 'door', name: 'Door', zone: 'Lobby', tier: 'critical' });
  await handleMessage(ctx, 'c2', { action: 'hello', role: 'node', nodeId: 'yard', name: 'Yard', zone: 'Lobby', tier: 'peripheral' });
  await handleMessage(ctx, 'd1', { action: 'setRules', rules: [{ name: 'Text lead', action: 'sms', target: '+15551234567', minLevel: 'HIGH', threats: [] }, { name: 'Police', action: 'dispatch', minLevel: 'CRITICAL', threats: ['gunshot', 'weapon'] }] });

  await handleMessage(ctx, 'd1', { action: 'simulate', nodeId: 'yard', scenario: 'fireworks' });
  assert.equal(incidents.length, 0, 'fireworks on a peripheral node does not alert');

  await handleMessage(ctx, 'd1', { action: 'simulate', nodeId: 'door', scenario: 'shooter' });
  assert.equal(incidents.length, 1);
  const inc = incidents[0];
  assert.equal(inc.level, 'CRITICAL'); assert.equal(inc.mode, 'DRILL'); assert.equal(inc.nodeId, 'door'); assert.equal(inc.threat, 'gunshot');
  assert.deepEqual(inc.actions.map((a) => `${a.action}:${a.status}`), ['sms:sent', 'dispatch:simulated']);
  assert.match(sms[0], /^\+15551234567: \[DRILL\] SAFETY SENTINEL CRITICAL/);
  assert.ok(sent.some((s) => s.to === 'c2' && s.msg.type === 'directive'), 'peer node told to go on heightened watch');
  assert.ok(sent.some((s) => s.to === 'd1' && s.msg.type === 'incident'));

  tick(5_000); await handleMessage(ctx, 'd1', { action: 'simulate', nodeId: 'door', scenario: 'shooter' });
  assert.equal(incidents.length, 1, 'cooldown: same zone, same level does not re-alert');
});

test('pipeline: media needs a joined node, and rules are validated', async () => {
  const { ctx, sent } = memoryCtx();
  await handleMessage(ctx, 'x', { action: 'frame', jpeg: 'A'.repeat(500) });
  assert.equal(sent.at(-1)!.msg.code, 'not_joined');
  assert.throws(() => sanitizeRules([{ action: 'sms', target: '555-1234' }]), /international format/);
  ctx.joinCode = 'secret';
  await handleMessage(ctx, 'y', { action: 'hello', role: 'node', name: 'Y' });
  assert.equal(sent.at(-1)!.msg.code, 'bad_code');
});
