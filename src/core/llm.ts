import { CFG } from './config';
import { clamp01, round2 } from './fusion';
import type { AgentId, Llm, NodeState, Opinion } from './types';

const PERSONA: Record<AgentId, string> = {
  gunshot: 'You are the GUNSHOT specialist. Your evidence is an audio classifier (YAMNet) run on short microphone clips. You know gunfire is easily confused with fireworks, door slams, balloon pops, claps and movie audio.',
  weapon: 'You are the WEAPON specialist. Your evidence is object and moderation labels from Amazon Rekognition on camera frames. You care whether a firearm (especially a rifle or other long gun) or blade is visible and held by a person, and you know toys, posters, screens and tools cause false positives.',
  altercation: 'You are the PHYSICAL ALTERCATION specialist. Your evidence is violence labels from camera frames plus screaming, shouting and impact sounds from the microphone. You know sports, play, cheering and films cause false positives.',
  hazard: 'You are the ENVIRONMENTAL HAZARD specialist (fire, smoke, explosions, alarms, breaking glass). Your evidence comes from both camera labels and audio classes. You know candles, cooking and alarm tests cause false positives.',
};

const RULES = `You are one of four specialist agents in a public-safety sensor network. Each agent first scored its own evidence alone. You are now shown the other agents' opinions and what nearby sensor nodes report, and you must give your revised opinion on YOUR threat type only.

Raise your score when other agents or nearby nodes corroborate your threat; lower it when they make an innocent explanation more likely. Do not adopt another agent's threat as your own: if you have no evidence, stay near your initial score. Missed threats and false alarms are both costly.

Reply with one JSON object and nothing else:
{"score": <0..1 probability that your threat is really happening>, "confidence": <0..1>, "rationale": "<one sentence, at most 30 words, naming what changed your mind>"}`;

export function buildPrompt(agent: AgentId, node: NodeState, initial: Opinion[], peers: { name: string; tier: string; score: number; top?: string }[]) {
  const mine = initial.find((o) => o.agent === agent)!;
  const user = JSON.stringify({
    node: { name: node.name, zone: node.zone, position: node.tier },
    your_initial_opinion: { score: mine.initial, subtype: mine.subtype, evidence: mine.evidence },
    other_agents: initial.filter((o) => o.agent !== agent).map((o) => ({ agent: o.agent, score: o.initial, subtype: o.subtype, evidence: o.evidence })),
    nearby_nodes: peers,
  }, null, 1);
  return { system: `${PERSONA[agent]}\n\n${RULES}`, user };
}

export function parseReply(text: string): { score: number; confidence: number; rationale: string } | undefined {
  const s = text.indexOf('{'), e = text.lastIndexOf('}');
  if (s < 0 || e <= s) return undefined;
  try {
    const j = JSON.parse(text.slice(s, e + 1));
    if (typeof j.score !== 'number' || Number.isNaN(j.score)) return undefined;
    return { score: clamp01(j.score), confidence: clamp01(typeof j.confidence === 'number' ? j.confidence : 0.5), rationale: String(j.rationale ?? '').slice(0, 300) };
  } catch { return undefined; }
}

/**
 * Round 2, LLM. One call per specialist, in parallel. Each agent's revision is clamped to
 * +/- llmMaxShift around its round-1 score so a model error cannot invent or erase a threat.
 * Agents whose call fails keep their rule-based opinion.
 */
export async function llmDeliberate(llm: Llm, node: NodeState, initial: Opinion[], ruleBased: Opinion[], peers: { name: string; tier: string; score: number; top?: string }[]): Promise<{ opinions: Opinion[]; ok: number; error?: string }> {
  let ok = 0; let error: string | undefined;
  const opinions = await Promise.all(ruleBased.map(async (o) => {
    const { system, user } = buildPrompt(o.agent, node, initial, peers);
    try {
      const reply = await Promise.race([
        llm.complete(system, user),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), CFG.llmTimeoutMs)),
      ]);
      const p = parseReply(reply);
      if (!p) throw new Error('unparseable reply');
      ok++;
      const score = round2(Math.max(o.initial - CFG.llmMaxShift, Math.min(o.initial + CFG.llmMaxShift, p.score)));
      return { ...o, score, confidence: round2(p.confidence), rationale: p.rationale || o.rationale, by: 'llm' as const };
    } catch (e) { error = (e as Error).message; return o; }
  }));
  return { opinions, ok, error };
}
