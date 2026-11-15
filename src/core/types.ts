export type AgentId = 'gunshot' | 'weapon' | 'altercation' | 'hazard';
export const AGENT_IDS: AgentId[] = ['gunshot', 'weapon', 'altercation', 'hazard'];
export type Level = 'SAFE' | 'ELEVATED' | 'HIGH' | 'CRITICAL';
export const LEVELS: Level[] = ['SAFE', 'ELEVATED', 'HIGH', 'CRITICAL'];
export type Tier = 'critical' | 'standard' | 'peripheral';

/** What the audio model heard in one clip. `classes` maps YAMNet class name -> score 0..1. */
export interface AudioObs { ts: number; classes: Record<string, number>; peakDb: number; rmsDb: number; crest: number }
/** What Rekognition saw in one frame. Confidences are 0..100. */
export interface VisualObs { ts: number; labels: Record<string, number>; moderation: Record<string, number>; persons: number }

export interface Opinion {
  agent: AgentId;
  /** Score from the agent's own evidence only (round 1). */
  initial: number;
  /** Score after hearing the other agents and peer nodes (round 2). */
  score: number;
  confidence: number;
  subtype?: string;
  evidence: string[];
  rationale: string;
  /** Who revised it: fixed rules, or the LLM specialist. */
  by: 'rules' | 'llm';
}

export interface NodeState {
  nodeId: string; name: string; zone: string; tier: Tier;
  connectionId?: string; online: boolean; joinedAt: number; lastSeen: number;
  audio?: AudioObs; visual?: VisualObs;
  /** Decaying per-agent evidence memory, so a one-second bang is not forgotten a second later. */
  held: Partial<Record<AgentId, { score: number; ts: number; subtype?: string; evidence: string[] }>>;
  opinions: Opinion[]; score: number; level: Level; scoredAt: number;
  llmAt?: number; llmStatus?: string;
  /** Drill mode: observations were injected from the dashboard, not sensed. */
  simUntil?: number;
  lastDirectiveAt?: number;
}

export interface ZoneState { zone: string; score: number; level: Level; contributors: { nodeId: string; name: string; tier: Tier; contribution: number }[]; lastAlertAt?: number; lastAlertLevel?: Level }

export type ActionKind = 'sms' | 'broadcast' | 'dispatch';
export interface AlertRule {
  id: string; name: string; enabled: boolean;
  minLevel: Level;
  /** Empty = any threat type. */
  threats: AgentId[];
  action: ActionKind;
  /** E.164 phone number for `sms`. */
  target?: string;
}

export interface ThreatEvent {
  incidentId: string; ts: number; mode: 'LIVE' | 'DRILL';
  zone: string; level: Level; zoneScore: number;
  nodeId: string; nodeName: string; nodeScore: number;
  threat: AgentId; subtype?: string; summary: string;
  opinions: Pick<Opinion, 'agent' | 'score' | 'rationale'>[];
  corroboratingNodes: string[];
}
export interface ActionResult { ruleId: string; ruleName: string; action: ActionKind; target?: string; status: 'sent' | 'simulated' | 'failed'; detail: string }
export interface Incident extends ThreatEvent { actions: ActionResult[] }

export interface Conn { connectionId: string; role: 'node' | 'dashboard'; nodeId?: string }

export type MediaRecord =
  | { type: 'frame'; nodeId: string; ts: number; jpeg: string }
  | { type: 'audio'; nodeId: string; ts: number; mulaw: string }
  | { type: 'sim'; nodeId: string; ts: number; scenario: string };

/** Everything the pipeline needs from the outside world. AWS and local dev each provide one. */
export interface Ctx {
  store: Store; push: Push; vision: Vision; audioModel: AudioModel; llm?: Llm;
  enqueue(rec: MediaRecord): Promise<void>;
  emit(ev: ThreatEvent): Promise<void>;
  notifier: Notifier;
  joinCode?: string;
  now(): number;
  log(msg: string, extra?: unknown): void;
}
export interface Store {
  getConn(id: string): Promise<Conn | undefined>; putConn(c: Conn): Promise<void>; delConn(id: string): Promise<void>; listConns(): Promise<Conn[]>;
  getNode(id: string): Promise<NodeState | undefined>; putNode(n: NodeState): Promise<void>; listNodes(): Promise<NodeState[]>;
  getZone(zone: string): Promise<ZoneState | undefined>; putZone(z: ZoneState): Promise<void>;
  getRules(): Promise<AlertRule[] | undefined>; putRules(r: AlertRule[]): Promise<void>;
  putIncident(i: Incident): Promise<void>; listIncidents(limit: number): Promise<Incident[]>;
}
export interface Push { send(connectionId: string, msg: unknown): Promise<boolean> }
export interface Vision { analyze(jpeg: Buffer): Promise<Omit<VisualObs, 'ts'>> }
export interface AudioModel { classify(pcm: Float32Array): Promise<Record<string, number>> }
export interface Llm { complete(system: string, user: string): Promise<string> }
export interface Notifier { sms(phone: string, text: string): Promise<string> }
