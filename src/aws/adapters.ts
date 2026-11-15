import { AnthropicBedrockMantle } from '@anthropic-ai/bedrock-sdk';
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { KinesisClient, PutRecordCommand } from '@aws-sdk/client-kinesis';
import { DetectLabelsCommand, DetectModerationLabelsCommand, RekognitionClient } from '@aws-sdk/client-rekognition';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { AlertRule, Conn, Ctx, Incident, Llm, MediaRecord, NodeState, Notifier, Push, Store, ThreatEvent, Vision, ZoneState } from '../core/types';

const env = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`missing env ${k}`); return v; };
const ttl = (hours: number) => Math.floor(Date.now() / 1000) + hours * 3600;

/** Single DynamoDB table. pk is the item kind, sk its id. */
export class DynamoStore implements Store {
  private doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
  private table = env('TABLE');
  private async get<T>(pk: string, sk: string) { return (await this.doc.send(new GetCommand({ TableName: this.table, Key: { pk, sk }, ConsistentRead: true }))).Item?.data as T | undefined; }
  private async put(pk: string, sk: string, data: unknown, hours: number) { await this.doc.send(new PutCommand({ TableName: this.table, Item: { pk, sk, data, ttl: ttl(hours) } })); }
  private async list<T>(pk: string, limit?: number, newestFirst = false) {
    const out: T[] = []; let key: Record<string, unknown> | undefined;
    do {
      const r = await this.doc.send(new QueryCommand({ TableName: this.table, KeyConditionExpression: 'pk = :p', ExpressionAttributeValues: { ':p': pk }, ExclusiveStartKey: key, Limit: limit, ScanIndexForward: !newestFirst, ConsistentRead: true }));
      out.push(...(r.Items ?? []).map((i) => i.data as T)); key = r.LastEvaluatedKey;
    } while (key && (!limit || out.length < limit));
    return limit ? out.slice(0, limit) : out;
  }
  getConn(id: string) { return this.get<Conn>('CONN', id); }
  putConn(c: Conn) { return this.put('CONN', c.connectionId, c, 3); }
  async delConn(id: string) { await this.doc.send(new DeleteCommand({ TableName: this.table, Key: { pk: 'CONN', sk: id } })); }
  listConns() { return this.list<Conn>('CONN'); }
  getNode(id: string) { return this.get<NodeState>('NODE', id); }
  putNode(n: NodeState) { return this.put('NODE', n.nodeId, n, 2); }
  listNodes() { return this.list<NodeState>('NODE'); }
  getZone(zone: string) { return this.get<ZoneState>('ZONE', zone); }
  putZone(z: ZoneState) { return this.put('ZONE', z.zone, z, 2); }
  getRules() { return this.get<AlertRule[]>('CONFIG', 'rules'); }
  putRules(r: AlertRule[]) { return this.put('CONFIG', 'rules', r, 24 * 365); }
  putIncident(i: Incident) { return this.put('INCIDENT', `${new Date(i.ts).toISOString()}#${i.incidentId}`, i, 24 * 30); }
  listIncidents(limit: number) { return this.list<Incident>('INCIDENT', limit, true); }
}

/** Pushes to browsers over the API Gateway WebSocket. Returns false when the connection is gone. */
export class WsPush implements Push {
  private api?: ApiGatewayManagementApiClient;
  async send(connectionId: string, msg: unknown): Promise<boolean> {
    // Created on first use: the ingest Lambda only learns its endpoint from the first request.
    this.api ??= new ApiGatewayManagementApiClient({ endpoint: env('WS_ENDPOINT') });
    try { await this.api.send(new PostToConnectionCommand({ ConnectionId: connectionId, Data: Buffer.from(JSON.stringify(msg)) })); return true; }
    catch (e) { const n = (e as { name?: string }).name; if (n === 'GoneException' || n === 'BadRequestException') return false; console.warn('push failed', n); return true; }
  }
}

/** Amazon Rekognition: object labels (weapons, fire, people) and moderation labels (violence, weapons). */
export class RekognitionVision implements Vision {
  private rek = new RekognitionClient({});
  async analyze(jpeg: Buffer) {
    const [l, m] = await Promise.all([
      this.rek.send(new DetectLabelsCommand({ Image: { Bytes: jpeg }, MaxLabels: 40, MinConfidence: 50 })),
      this.rek.send(new DetectModerationLabelsCommand({ Image: { Bytes: jpeg }, MinConfidence: 40 })),
    ]);
    const labels: Record<string, number> = {}; let persons = 0;
    for (const x of l.Labels ?? []) {
      if (!x.Name) continue;
      labels[x.Name] = Math.round(x.Confidence ?? 0);
      if (x.Name === 'Person') persons = Math.max(1, x.Instances?.length ?? 0);
    }
    const moderation: Record<string, number> = {};
    for (const x of m.ModerationLabels ?? []) if (x.Name) moderation[x.Name] = Math.round(x.Confidence ?? 0);
    return { labels, moderation, persons };
  }
}

/** Claude on Amazon Bedrock, used by the specialist agents' second round. */
export class BedrockLlm implements Llm {
  private client = new AnthropicBedrockMantle({ awsRegion: process.env.BEDROCK_REGION || process.env.AWS_REGION, maxRetries: 0, timeout: 10_000 });
  private model = env('BEDROCK_MODEL_ID');
  async complete(system: string, user: string): Promise<string> {
    const msg = await this.client.messages.create({
      model: this.model, max_tokens: 2000, system, messages: [{ role: 'user', content: user }],
      output_config: { effort: 'low' },
    });
    if (msg.stop_reason === 'refusal') throw new Error('model declined');
    const text = msg.content.find((b) => b.type === 'text');
    if (!text || text.type !== 'text') throw new Error('empty reply');
    return text.text;
  }
}

export class SnsNotifier implements Notifier {
  private sns = new SNSClient({});
  async sms(phone: string, text: string) {
    const r = await this.sns.send(new PublishCommand({ PhoneNumber: phone, Message: text.slice(0, 600), MessageAttributes: { 'AWS.SNS.SMS.SMSType': { DataType: 'String', StringValue: 'Transactional' } } }));
    return `SNS accepted SMS (${r.MessageId})`;
  }
}

export function awsCtx(opts: { llm?: boolean; audio?: Ctx['audioModel'] } = {}): Ctx {
  const kinesis = new KinesisClient({}); const eb = new EventBridgeClient({});
  const none = { classify: async () => ({}) };
  return {
    store: new DynamoStore(), push: new WsPush(), vision: new RekognitionVision(), audioModel: opts.audio ?? none,
    llm: opts.llm && process.env.BEDROCK_MODEL_ID ? new BedrockLlm() : undefined, notifier: new SnsNotifier(),
    joinCode: process.env.JOIN_CODE || undefined,
    async enqueue(rec: MediaRecord) { await kinesis.send(new PutRecordCommand({ StreamName: env('STREAM'), PartitionKey: rec.nodeId, Data: Buffer.from(JSON.stringify(rec)) })); },
    async emit(ev: ThreatEvent) {
      const r = await eb.send(new PutEventsCommand({ Entries: [{ EventBusName: env('BUS'), Source: 'safety.sentinel', DetailType: 'ThreatDetected', Detail: JSON.stringify({ ...ev, text: `${ev.mode === 'DRILL' ? '[DRILL] ' : ''}SAFETY SENTINEL ${ev.level}: ${ev.summary}` }) }] }));
      if (r.FailedEntryCount) throw new Error(`EventBridge rejected event: ${r.Entries?.[0]?.ErrorMessage}`);
    },
    now: () => Date.now(),
    log: (msg, extra) => console.log(JSON.stringify({ msg, ...(extra as object) })),
  };
}
