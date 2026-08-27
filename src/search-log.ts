import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WebClient } from '@slack/web-api';
import type { TurnLogEntry } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = process.env['LOG_DIR'] ?? path.join(__dirname, '..', 'logs');

/** 프롬프트가 비대해지지 않도록 최근 항목만 검색 대상으로 삼는다 (최신순 우선). */
const MAX_CANDIDATES = 400;

export interface SearchCandidate {
  sender: string;
  date: string;
  question: string;
  permalink: string;
}

// 채널 공개 여부 캐시 — search 한 번에 같은 채널을 여러 번 조회하지 않기 위함
const channelPublicCache = new Map<string, boolean>();

async function isPublicChannel(client: WebClient, channel: string): Promise<boolean> {
  if (channel.startsWith('D')) return false; // DM은 조회 대상에서 제외
  const cached = channelPublicCache.get(channel);
  if (cached !== undefined) return cached;
  let isPublic = false;
  try {
    const info = await client.conversations.info({ channel });
    isPublic = Boolean(info.channel?.is_channel) && !info.channel?.is_private;
  } catch {
    // 조회 실패(봇이 못 보는 채널 등)는 안전하게 비공개 취급
    isPublic = false;
  }
  channelPublicCache.set(channel, isPublic);
  return isPublic;
}

let workspaceUrlCache: string | null = null;
async function getWorkspaceUrl(client: WebClient): Promise<string> {
  if (workspaceUrlCache) return workspaceUrlCache;
  const auth = await client.auth.test();
  workspaceUrlCache = ((auth as { url?: string }).url ?? '').replace(/\/+$/, '') + '/';
  return workspaceUrlCache;
}

function buildPermalink(baseUrl: string, entry: TurnLogEntry): string {
  const msgTs = entry.trigger_ts.replace('.', '');
  const link = `${baseUrl}archives/${entry.channel}/p${msgTs}`;
  return entry.trigger_ts !== entry.thread_ts
    ? `${link}?thread_ts=${entry.thread_ts}&cid=${entry.channel}`
    : link;
}

/** search/dev/team/help 커맨드성 턴은 "질의 기록"이 아니므로 제외한다 (mode 필드가 없는 과거 로그 대비 텍스트 휴리스틱 병행). */
function isCommandTurn(entry: TurnLogEntry): boolean {
  if (entry.mode && entry.mode !== 'qa' && entry.mode !== 'feedback') return true;
  const stripped = entry.question_text.replace(/<@[A-Z0-9]+>/g, '').trim();
  const firstWord = (stripped.split(/\s+/)[0] ?? '').toLowerCase();
  return ['search', 'team', 'help', 'dev'].includes(firstWord);
}

/**
 * 과거 질의 로그에서 search 커맨드의 검색 대상 후보를 수집한다.
 * 공개 채널에서 접수된 질의만 포함한다 — DM·비공개 채널 질의는 다른 사용자에게 노출하지 않는다.
 */
export async function collectSearchCandidates(client: WebClient): Promise<SearchCandidate[]> {
  let files: string[];
  try {
    files = (await readdir(LOG_DIR)).filter((f) => /^turns-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
  } catch {
    return [];
  }

  const entries: TurnLogEntry[] = [];
  for (const file of files) {
    const raw = await readFile(path.join(LOG_DIR, file), 'utf-8').catch(() => '');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as TurnLogEntry);
      } catch {
        // 파손 라인 무시
      }
    }
  }

  const recent = entries
    .filter((e) => e.status === 'ok' && e.question_text?.trim() && !isCommandTurn(e))
    .slice(-MAX_CANDIDATES * 2); // 채널 필터로 줄어들 것을 감안해 여유 있게 자른다

  const baseUrl = await getWorkspaceUrl(client);
  const candidates: SearchCandidate[] = [];
  for (const entry of recent) {
    if (!(await isPublicChannel(client, entry.channel))) continue;
    candidates.push({
      sender: entry.sender_name ?? '(알 수 없음)',
      date: entry.ts.slice(0, 16).replace('T', ' '),
      question: entry.question_text.replace(/<@[A-Z0-9]+>/g, '').trim(),
      permalink: buildPermalink(baseUrl, entry),
    });
  }
  return candidates.slice(-MAX_CANDIDATES);
}

export function candidatesToJsonl(candidates: SearchCandidate[]): string {
  return candidates.map((c) => JSON.stringify(c)).join('\n');
}
