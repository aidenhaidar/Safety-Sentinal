// API Gateway WebSocket -> this Lambda. Registers phones/dashboards and forwards media to Kinesis.
import type { APIGatewayProxyWebsocketEventV2 } from 'aws-lambda';
import { awsCtx } from '../aws/adapters';
import { handleDisconnect, handleMessage } from '../core/pipeline';

const ctx = awsCtx();
export async function handler(event: APIGatewayProxyWebsocketEventV2) {
  const { routeKey, connectionId, domainName, stage } = event.requestContext;
  process.env.WS_ENDPOINT ??= `https://${domainName}/${stage}`;
  try {
    if (routeKey === '$disconnect') await handleDisconnect(ctx, connectionId);
    else if (routeKey !== '$connect') await handleMessage(ctx, connectionId, JSON.parse(event.body ?? '{}'));
  } catch (e) { ctx.log('ingest error', { routeKey, error: (e as Error).message }); }
  return { statusCode: 200 };
}
