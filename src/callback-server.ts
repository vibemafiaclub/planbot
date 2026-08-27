import http from 'node:http';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { WebClient } from '@slack/web-api';
import { getJob, deleteJob, LOADING_REACTION } from './job-store.js';
import { setProposal, TICKET_PATTERN } from './jira-comment.js';
import { isUserActive } from './thread-store.js';
import type { Classification, GateLens } from './gate-schema.js';

interface ReplyBody {
  text: string;
  filePaths: string[];
  classification: Classification;
  gateIssues: GateLens[];
}

interface JiraProposalBody {
  ticket: string;
  comment: string;
}

const JIRA_COMMENT_MAX_LEN = 4000;

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
    if (req.method !== 'POST') {
      res.writeHead(404).end('not found');
      return;
    }

    // claude 세션의 Jira 댓글 등록 "제안" 접수 — 즉시 등록하지 않고 스레드에 미리보기를 올려 승인을 기다린다.
    if (req.url?.startsWith('/jira-proposal/')) {
      const token = req.url.replace('/jira-proposal/', '');
      const job = getJob(token);
      if (!job) {
        res.writeHead(404).end('unknown job token (reply_to_slack보다 먼저 호출해야 한다)');
        return;
      }
      try {
        const raw = await readBody(req);
        const body = JSON.parse(raw) as JiraProposalBody;
        const ticket = (body.ticket ?? '').trim().toUpperCase();
        const comment = (body.comment ?? '').trim();
        if (!TICKET_PATTERN.test(ticket)) {
          res.writeHead(400).end(`invalid ticket format: ${ticket.slice(0, 50)}`);
          return;
        }
        if (!comment || comment.length > JIRA_COMMENT_MAX_LEN) {
          res.writeHead(400).end(`comment must be 1~${JIRA_COMMENT_MAX_LEN} chars`);
          return;
        }

        setProposal(job.channel, job.threadTs, {
          ticket,
          comment,
          requesterUserId: job.senderUserId,
          requesterName: job.senderName,
          createdAt: Date.now(),
        });

        // 요청자의 자동 반응이 꺼져 있는 스레드에서는 멘션 없는 답글에 봇이 반응하지 않으므로 승인도 멘션으로 받아야 한다.
        const approveHow = job.senderUserId && isUserActive(job.channel, job.threadTs, job.senderUserId)
          ? '이 스레드에 `등록`이라고 답글을 달면'
          : '이 스레드에 `@planbot 등록`이라고 답글을 달면';
        const who = job.senderUserId ? `<@${job.senderUserId}>님만 승인할 수 있습니다. ` : '';
        await client.chat.postMessage({
          channel: job.channel,
          thread_ts: job.threadTs,
          text: [
            `📝 *${ticket}* 티켓에 아래 내용을 댓글로 등록할까요?`,
            '',
            '```',
            comment,
            '```',
            `${who}${approveHow} 등록되고, \`취소\`라고 답하면 취소됩니다. (30분 뒤 자동 만료)`,
          ].join('\n'),
        });

        res.writeHead(200).end('ok');
      } catch (err) {
        console.error('[planbot] jira proposal error', err);
        res.writeHead(500).end('internal error');
      }
      return;
    }

    if (!req.url?.startsWith('/reply/')) {
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
        // render_diagram이 만든 임시 PNG는 업로드가 끝나면 정리한다 (그 외 경로는 건드리지 않는다)
        const diagramDir = path.join(os.tmpdir(), 'planbot-diagrams');
        for (const p of body.filePaths) {
          if (path.resolve(p).startsWith(diagramDir)) {
            await rm(p, { force: true }).catch(() => {});
            await rm(p.replace(/\.png$/, '.dot'), { force: true }).catch(() => {});
          }
        }
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
