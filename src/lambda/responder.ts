// EventBridge (ThreatDetected) -> this Lambda. Runs the central action algorithm (custom alert rules).
import type { EventBridgeEvent } from 'aws-lambda';
import { awsCtx } from '../aws/adapters';
import { handleThreatEvent } from '../core/actions';
import type { ThreatEvent } from '../core/types';

const ctx = awsCtx();
export async function handler(event: EventBridgeEvent<'ThreatDetected', ThreatEvent>) {
  await handleThreatEvent(ctx, event.detail, 'EventBridge rule published this alert to the SNS alerts topic (email/SMS subscribers).');
}
