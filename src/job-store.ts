import crypto from 'node:crypto';
import type { Classification, GateLens } from './gate-schema.js';

export interface Job {
  token: string;
  channel: string;
  /** null이면 1:1 DM 최상위 대화 — 답장을 스레드가 아닌 채널 최상위로 보낸다 */
  threadTs: string | null;
  triggerMessageTs: string;
  processingMessageTs: string | null;
  done: boolean;
  createdAt: number;
  classification: Classification | null;
  gateIssues: GateLens[];
}

const jobs = new Map<string, Job>();

export function createJob(opts: { channel: string; threadTs: string | null; triggerMessageTs: string }): Job {
  const token = crypto.randomBytes(16).toString('hex');
  const job: Job = {
    token,
    channel: opts.channel,
    threadTs: opts.threadTs,
    triggerMessageTs: opts.triggerMessageTs,
    processingMessageTs: null,
    done: false,
    createdAt: Date.now(),
    classification: null,
    gateIssues: [],
  };
  jobs.set(token, job);
  return job;
}

export function getJob(token: string): Job | undefined {
  return jobs.get(token);
}

export function deleteJob(token: string): void {
  jobs.delete(token);
}
