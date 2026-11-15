// Local development server: the same pipeline as AWS, with in-memory stand-ins for
// DynamoDB, Kinesis, EventBridge and SNS. Rekognition is not available locally, so
// camera frames return no labels; use the dashboard's drill buttons for visual threats.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { Yamnet } from '../aws/yamnet';
import { alertText, handleThreatEvent } from '../core/actions';
import { handleDisconnect, handleMessage, processRecords } from '../core/pipeline';
import type { Ctx, MediaRecord } from '../core/types';
import { MemoryStore } from './memory-store';

const PORT = Number(process.env.PORT ?? 8080);
const WEB = join(__dirname, '..', '..', 'web');
const sockets = new Map<string, WebSocket>();
const queues = new Map<string, Promise<void>>(); // one ordered queue per node, like a Kinesis partition key
const ctx: Ctx = {
  store: new MemoryStore(),
  push: { async send(id, msg) { const s = sockets.get(id); if (!s || s.readyState !== s.OPEN) return false; s.send(JSON.stringify(msg)); return true; } },
  vision: { async analyze() { return { labels: {}, moderation: {}, persons: 0 }; } },
  audioModel: new Yamnet(),
  notifier: { async sms(phone, text) { console.log(`[local SNS] SMS to ${phone}: ${text}`); return 'Logged locally (no SMS sent in local mode)'; } },
  joinCode: process.env.JOIN_CODE || undefined,
  async enqueue(rec: MediaRecord) {
    const prev = queues.get(rec.nodeId) ?? Promise.resolve();
    queues.set(rec.nodeId, prev.then(() => processRecords(ctx, [rec])).catch((e) => console.error(e)));
  },
  async emit(ev) {
    console.log(`[local EventBridge] ThreatDetected -> SNS topic: ${alertText(ev)}`);
    await handleThreatEvent(ctx, ev, 'Local mode: the SNS topic broadcast was logged to the server console.');
  },
  now: () => Date.now(),
  log: (msg, extra) => console.log(`[sentinel] ${msg}`, extra ?? ''),
};

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = createServer((req, res) => {
  const path = decodeURIComponent((req.url ?? '/').split('?')[0]);
  if (path === '/config.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(`window.SENTINEL_CONFIG = ${JSON.stringify({ wsUrl: '', joinCodeRequired: !!ctx.joinCode, local: true })};`); return; }
  const file = normalize(join(WEB, path === '/' ? 'index.html' : path));
  if (!file.startsWith(WEB) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end('Not found'); return; }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  createReadStream(file).pipe(res);
});

let nextId = 1;
new WebSocketServer({ server, path: '/ws', maxPayload: 128 * 1024 }).on('connection', (ws) => {
  const id = `local-${nextId++}`;
  sockets.set(id, ws);
  ws.on('message', (data) => {
    let msg: unknown;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    handleMessage(ctx, id, msg).catch((e) => console.error(e));
  });
  ws.on('close', () => { sockets.delete(id); handleDisconnect(ctx, id).catch((e) => console.error(e)); });
});
server.listen(PORT, () => console.log(`Safety Sentinel (local) on http://localhost:${PORT}  — phone page: http://localhost:${PORT}/node.html`));
