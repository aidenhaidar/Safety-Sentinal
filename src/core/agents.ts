import { CFG } from './config';
import { clamp01, decay, noisyOr, round2 } from './fusion';
import type { AgentId, AudioObs, NodeState, Opinion, VisualObs } from './types';
import { AGENT_IDS } from './types';

interface Reading { score: number; subtype?: string; evidence: string[] }
const a = (o: AudioObs | undefined, name: string) => o?.classes[name] ?? 0;
const v = (o: VisualObs | undefined, ...names: string[]) => Math.max(0, ...names.map((n) => o?.labels[n] ?? 0)) / 100;
const m = (o: VisualObs | undefined, ...names: string[]) => Math.max(0, ...names.map((n) => o?.moderation[n] ?? 0)) / 100;
const pct = (x: number) => `${Math.round(x * 100)}%`;
function ev(list: string[], label: string, x: number, min = 0.1) { if (x >= min) list.push(`${label} ${pct(x)}`); }

/**
 * Round 1. Each specialist looks only at its own kind of evidence and returns a score.
 * `audio` / `visual` are passed only when that modality has a NEW observation this tick.
 */
export const SPECIALISTS: Record<AgentId, (audio?: AudioObs, visual?: VisualObs) => Reading> = {
  // Gunshot agent: audio only. Gunfire classes, discounted when it sounds like fireworks.
  gunshot(audio) {
    const e: string[] = [];
    const gun = Math.max(a(audio, 'Gunshot, gunfire'), a(audio, 'Machine gun'), a(audio, 'Fusillade'), a(audio, 'Artillery fire'), a(audio, 'Cap gun') * 0.6);
    const boom = Math.max(a(audio, 'Explosion'), a(audio, 'Burst, pop') * 0.5, a(audio, 'Bang') * 0.5);
    const fireworks = Math.max(a(audio, 'Fireworks'), a(audio, 'Firecracker'));
    ev(e, 'gunfire sound', gun); ev(e, 'explosion/bang', boom); ev(e, 'fireworks-like', fireworks);
    // A real shot near a phone clips the mic; a quiet "gunshot" is more likely a TV in another room.
    const loud = audio ? clamp01((audio.peakDb + 30) / 24) : 0;
    if (gun >= 0.1 && audio) e.push(`peak ${Math.round(audio.peakDb) || 0} dBFS`);
    // Real gunfire usually scores on "Explosion" as well, so a boom supports a gunfire class. Fireworks only
    // count against it when they outscore gunfire (calibrated on field recordings; see test/core.test.ts).
    const score = clamp01(1.6 * gun + (gun > 0.05 ? 0.5 : 0.4) * boom - 0.5 * Math.max(0, fireworks - gun)) * (0.6 + 0.4 * loud);
    return { score, subtype: a(audio, 'Machine gun') > 0.3 ? 'automatic fire' : undefined, evidence: e };
  },
  // Weapon agent: video only. Rifles/long guns rate above handguns, which rate above blades.
  weapon(_audio, visual) {
    const e: string[] = [];
    const longGun = v(visual, 'Rifle', 'Shotgun', 'Machine Gun', 'Assault Rifle');
    const gun = v(visual, 'Gun', 'Handgun', 'Firearm', 'Pistol', 'Revolver');
    const generic = Math.max(v(visual, 'Weapon', 'Weaponry'), m(visual, 'Weapons', 'Weapon Violence'));
    const blade = v(visual, 'Knife', 'Blade', 'Dagger', 'Sword', 'Machete');
    ev(e, 'rifle/long gun', longGun); ev(e, 'gun', gun); ev(e, 'weapon', generic); ev(e, 'blade', blade);
    const held = (visual?.persons ?? 0) > 0;
    if (visual && (longGun || gun || generic || blade) >= 0.1) e.push(held ? `${visual.persons} person(s) in frame` : 'no person in frame');
    const raw = Math.max(longGun, gun * 0.95, generic * 0.7, blade * 0.7);
    return {
      score: clamp01(raw * (held ? 1 : 0.75)),
      subtype: longGun >= 0.5 ? 'rifle' : gun >= 0.5 ? 'handgun' : blade >= 0.5 ? 'blade' : undefined, evidence: e,
    };
  },
  // Altercation agent: both. Violence on camera, screaming and impact sounds on the mic.
  altercation(audio, visual) {
    const e: string[] = [];
    const violence = m(visual, 'Physical Violence', 'Violence', 'Graphic Violence');
    const fighting = v(visual, 'Fighting', 'Punching', 'Brawl') ;
    const people = visual?.persons ?? 0;
    const scream = a(audio, 'Screaming');
    const shout = Math.max(a(audio, 'Shout'), a(audio, 'Yell'), a(audio, 'Children shouting'));
    const impact = Math.max(a(audio, 'Slap, smack'), a(audio, 'Whack, thwack'), a(audio, 'Smash, crash'));
    ev(e, 'violence on camera', violence); ev(e, 'fighting', fighting); ev(e, 'screaming', scream); ev(e, 'shouting', shout, 0.2); ev(e, 'impact sounds', impact, 0.2);
    const seen = Math.max(violence, fighting * 0.9) * (people >= 2 ? 1 : 0.7);
    const heard = noisyOr([scream * 0.9, shout * 0.35, impact * 0.4]);
    return { score: visual && audio ? noisyOr([seen, heard]) : visual ? seen : heard, evidence: e };
  },
  // Hazard agent ("others"): fire, smoke, alarms, breaking glass.
  hazard(audio, visual) {
    const e: string[] = [];
    const fire = v(visual, 'Fire', 'Flame', 'Bonfire') ; const smoke = v(visual, 'Smoke');
    const alarm = Math.max(a(audio, 'Smoke detector, smoke alarm'), a(audio, 'Fire alarm'), a(audio, 'Civil defense siren'), a(audio, 'Siren') * 0.6, a(audio, 'Alarm') * 0.5);
    const glass = Math.max(a(audio, 'Shatter'), a(audio, 'Glass') * 0.6, a(audio, 'Breaking') * 0.6);
    const explosion = Math.max(a(audio, 'Explosion'), v(visual, 'Explosion'));
    ev(e, 'fire', fire, 0.5); ev(e, 'smoke', smoke, 0.5); ev(e, 'alarm/siren', alarm, 0.2); ev(e, 'glass breaking', glass, 0.2); ev(e, 'explosion', explosion, 0.2);
    // Rekognition says "Fire" for candles and lighters too, so only strong detections count.
    const seen = Math.max(clamp01((fire - 0.5) * 2) * 0.9, clamp01((smoke - 0.5) * 2) * 0.6);
    const heard = noisyOr([alarm * 0.8, glass * 0.7, explosion * 0.8]);
    return { score: visual && audio ? noisyOr([seen, heard]) : visual ? seen : heard, subtype: seen > heard && seen > 0.3 ? 'fire' : glass > 0.4 ? 'glass break' : undefined, evidence: e };
  },
};
const USES: Record<AgentId, { audio: boolean; visual: boolean }> = {
  gunshot: { audio: true, visual: false }, weapon: { audio: false, visual: true },
  altercation: { audio: true, visual: true }, hazard: { audio: true, visual: true },
};

/** Round 1 with memory: new evidence replaces the held score if stronger, otherwise the held score decays. */
export function observe(node: NodeState, now: number, fresh: { audio?: AudioObs; visual?: VisualObs }): void {
  for (const id of AGENT_IDS) {
    const use = USES[id];
    const prev = node.held[id];
    const carried = prev ? prev.score * decay(now - prev.ts, CFG.holdHalfLifeMs) : 0;
    const hasNew = (use.audio && fresh.audio) || (use.visual && fresh.visual);
    if (!hasNew) continue;
    // Agents that use both senses pair the new observation with the other sense's latest one, if recent.
    const recent = <T extends { ts: number }>(o?: T) => (o && now - o.ts < 6_000 ? o : undefined);
    const r = SPECIALISTS[id](use.audio ? fresh.audio ?? recent(node.audio) : undefined, use.visual ? fresh.visual ?? recent(node.visual) : undefined);
    if (r.score >= carried) node.held[id] = { score: r.score, ts: now, subtype: r.subtype, evidence: r.evidence };
  }
}

const LABEL: Record<AgentId, string> = { gunshot: 'Gunshot', weapon: 'Weapon', altercation: 'Altercation', hazard: 'Hazard' };

/** Current round-1 opinions (held evidence, decayed to now). */
export function initialOpinions(node: NodeState, now: number): Opinion[] {
  return AGENT_IDS.map((id) => {
    const h = node.held[id];
    const s = h ? round2(h.score * decay(now - h.ts, CFG.holdHalfLifeMs)) : 0;
    const conf = round2(clamp01(0.5 + Math.abs(s - 0.5)));
    return {
      agent: id, initial: s, score: s, confidence: conf, subtype: s >= 0.25 ? h?.subtype : undefined,
      evidence: s >= 0.05 ? h?.evidence ?? [] : [],
      rationale: s < 0.05 ? 'Nothing detected.' : `${LABEL[id]} evidence: ${(h?.evidence ?? []).join(', ') || 'weak signal'}.`, by: 'rules',
    };
  });
}

/**
 * Round 2, rule-based. Each agent hears the others' round-1 opinions and the strongest peer node,
 * and lifts its own score when they corroborate it. Always runs; the LLM round refines it when available.
 */
export function deliberate(initial: Opinion[], peerMax: number, peerName?: string): Opinion[] {
  const by = Object.fromEntries(initial.map((o) => [o.agent, o])) as Record<AgentId, Opinion>;
  return initial.map((o) => {
    let s = o.initial; const notes: string[] = [];
    for (const [other, w] of Object.entries(CFG.influence[o.agent]) as [AgentId, number][]) {
      // An agent with no evidence of its own may only be nudged, not talked into a threat it cannot sense.
      const lift = w * by[other].initial * (1 - s) * (o.initial >= CFG.peerMinOwnScore ? 1 : 0.35);
      if (lift >= 0.02) { s += lift; notes.push(`${LABEL[other]} agent reports ${pct(by[other].initial)} (+${pct(lift)})`); }
    }
    if (peerMax >= 0.25 && o.initial >= CFG.peerMinOwnScore) {
      const lift = CFG.peerInfluence * peerMax * (1 - s);
      if (lift >= 0.01) { s += lift; notes.push(`peer node ${peerName ?? ''} at ${pct(peerMax)} (+${pct(lift)})`.replace('  ', ' ')); }
    }
    return { ...o, score: round2(clamp01(s)), rationale: notes.length ? `${o.rationale} Raised after hearing: ${notes.join('; ')}.` : o.rationale };
  });
}
