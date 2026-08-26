import crypto from 'node:crypto';
import type { Classification, GateLens } from './gate-schema.js';

export interface Job {
  token: string;
  channel: string;
  threadTs: string;
  triggerMessageTs: string;
  processingMessageTs: string | null;
  /** 이 턴을 트리거한 발화자 — Jira 댓글 제안의 승인 권한자 판별에 사용 */
  senderUserId: string | null;
  senderName: string | null;
  done: boolean;
  createdAt: number;
  classification: Classification | null;
  gateIssues: GateLens[];
}

/**
 * 처리중 표시용 리액션 이모지 이름. 트리거 메시지에 처리 시작 시 붙이고, 성공/실패/무응답
 * 어느 경로로 끝나든 제거한다. 워크스페이스에 이 이름의 커스텀 이모지가 등록돼 있어야 한다.
 */
export const LOADING_REACTION = process.env['LOADING_REACTION'] ?? 'loading';

const jobs = new Map<string, Job>();

export function createJob(opts: { channel: string; threadTs: string; triggerMessageTs: string }): Job {
  const token = crypto.randomBytes(16).toString('hex');
  const job: Job = {
    token,
    channel: opts.channel,
    threadTs: opts.threadTs,
    triggerMessageTs: opts.triggerMessageTs,
    processingMessageTs: null,
    senderUserId: null,
    senderName: null,
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
