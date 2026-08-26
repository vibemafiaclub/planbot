import http from 'node:http';
import type { WebClient } from '@slack/web-api';
import { getJob, deleteJob, LOADING_REACTION } from './job-store.js';
import type { Classification, GateLens } from './gate-schema.js';

interface ReplyBody {
  text: string;
  filePaths: string[];
  classification: Classification;
  gateIssues: GateLens[];
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export function startCallbackServer(client: WebClient, port: number): void {
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST' || !req.url?.startsWith('/reply/')) {
      res.writeHead(404).end('not found');
      return;
    }
    const token = req.url.replace('/reply/', '');
    const job = getJob(token);
    if (!job) {
      res.writeHead(404).end('unknown job token');
      return;
    }

    try {
      const raw = await readBody(req);
      const body = JSON.parse(raw) as ReplyBody;

      job.classification = body.classification ?? null;
      job.gateIssues = body.gateIssues ?? [];

      if (body.filePaths && body.filePaths.length > 0) {
        await client.filesUploadV2({
          channel_id: job.channel,
          thread_ts: job.threadTs,
          initial_comment: body.text,
          file_uploads: body.filePaths.map((p) => ({ file: p })),
        });
      } else {
        await client.chat.postMessage({
          channel: job.channel,
          thread_ts: job.threadTs,
          text: body.text,
        });
      }

      if (job.processingMessageTs) {
        await client.chat.delete({ channel: job.channel, ts: job.processingMessageTs }).catch(() => {});
      }
      await client.reactions.remove({
        channel: job.channel,
        timestamp: job.triggerMessageTs,
        name: LOADING_REACTION,
      }).catch(() => {});

      job.done = true;
      deleteJob(token);
      res.writeHead(200).end('ok');
    } catch (err) {
      console.error('[planbot] callback error', err);
      res.writeHead(500).end('internal error');
    }
  });
  server.listen(port, () => {
    console.log(`[planbot] callback server listening on :${port}`);
  });
}
