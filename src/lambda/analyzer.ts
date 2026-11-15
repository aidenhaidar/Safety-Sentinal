// Kinesis -> this Lambda. Perception (Rekognition + YAMNet), specialist agents, fusion, EventBridge on detection.
import type { KinesisStreamEvent } from 'aws-lambda';
import { awsCtx } from '../aws/adapters';
import { Yamnet } from '../aws/yamnet';
import { processRecords } from '../core/pipeline';
import type { MediaRecord } from '../core/types';

const ctx = awsCtx({ llm: true, audio: new Yamnet() });
export async function handler(event: KinesisStreamEvent) {
  const records: MediaRecord[] = [];
  for (const r of event.Records) {
    try { records.push(JSON.parse(Buffer.from(r.kinesis.data, 'base64').toString())); } catch { /* skip malformed */ }
  }
  await processRecords(ctx, records);
}
