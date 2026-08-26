import { spawn } from 'node:child_process';

/**
 * Jira 댓글 등록 제안(승인 대기)과 실제 등록 실행.
 *
 * 안전 원칙: claude 세션은 댓글을 "제안"만 할 수 있고(propose_jira_comment MCP 툴),
 * 실제 `jira issue comment add` 실행은 요청자가 슬랙에서 `등록`으로 승인했을 때
 * 메인 프로세스가 수행한다. claude의 allowedTools에는 Jira 쓰기 명령이 없으므로,
 * 프롬프트 인젝션이 있어도 사람 승인 없이는 Jira에 아무것도 남길 수 없다.
 */

const JIRA_BIN = process.env['JIRA_BIN'] ?? 'jira';
const JIRA_TIMEOUT_MS = 60_000;

/** 예: SABANG-1234, PROJ-1 — jira-cli에 넘기기 전 형식 검증 (임의 인자 주입 방지) */
export const TICKET_PATTERN = /^[A-Za-z][A-Za-z0-9]{1,19}-\d{1,10}$/;

export interface JiraCommentProposal {
  ticket: string;
  comment: string;
  /** 이 제안을 만들게 한 턴의 발화자 — 이 사람만 승인/취소할 수 있다 */
  requesterUserId: string | null;
  requesterName: string | null;
  createdAt: number;
}

const PROPOSAL_TTL_MS = 30 * 60 * 1000;

const proposals = new Map<string, JiraCommentProposal>();

function key(channel: string, threadTs: string): string {
  return `${channel}:${threadTs}`;
}

/** 스레드당 하나만 유지 — 새 제안이 오면 이전 제안은 덮어쓴다. */
export function setProposal(channel: string, threadTs: string, proposal: JiraCommentProposal): void {
  proposals.set(key(channel, threadTs), proposal);
}

export function getProposal(channel: string, threadTs: string): JiraCommentProposal | undefined {
  const p = proposals.get(key(channel, threadTs));
  if (!p) return undefined;
  if (Date.now() - p.createdAt > PROPOSAL_TTL_MS) {
    proposals.delete(key(channel, threadTs));
    return undefined;
  }
  return p;
}

export function clearProposal(channel: string, threadTs: string): void {
  proposals.delete(key(channel, threadTs));
}

/**
 * jira-cli로 실제 댓글을 등록한다. 승인된 제안에 대해서만 호출할 것.
 * body는 args 배열로 전달되므로(shell 미사용) 내용에 무엇이 들어 있어도 명령 주입은 불가능하다.
 */
export function addJiraComment(ticket: string, body: string): Promise<void> {
  if (!TICKET_PATTERN.test(ticket)) {
    return Promise.reject(new Error(`잘못된 티켓 형식: ${ticket}`));
  }
  return new Promise<void>((resolve, reject) => {
    const proc = spawn(JIRA_BIN, ['issue', 'comment', 'add', ticket, body], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`jira comment add timed out after ${JIRA_TIMEOUT_MS}ms`));
    }, JIRA_TIMEOUT_MS);

    let stderr = '';
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`jira exited ${code}: ${stderr.slice(0, 500)}`));
        return;
      }
      resolve();
    });
    proc.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}
