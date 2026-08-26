import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Classification, GateLens } from './gate-schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = process.env['LOG_DIR'] ?? path.join(__dirname, '..', 'logs');

const QUESTION_TEXT_MAX_LEN = 500;

export interface TurnLogEntry {
  ts: string;
  channel: string;
  thread_ts: string;
  trigger_ts: string;
  turn_index: number;
  sender_user_id: string | null;
  sender_name: string | null;
  question_text: string;
  classification: Classification | null;
  gate_issues: GateLens[];
  latency_ms: number;
  status: 'ok' | 'error' | 'no_reply';
  error?: string;
}

/**
 * 턴 하나를 JSONL 한 줄로 append한다. 파일명은 날짜별로 자연 분할된다(logs/turns-YYYY-MM-DD.jsonl).
 * 실제 기획 내용(질문 원문)이 들어가므로 이 디렉터리는 반드시 .gitignore 대상이어야 한다.
 */
export async function logTurn(entry: Omit<TurnLogEntry, 'question_text'> & { question_text: string }): Promise<void> {
  await mkdir(LOG_DIR, { recursive: true });
  const dateStr = entry.ts.slice(0, 10);
  const filePath = path.join(LOG_DIR, `turns-${dateStr}.jsonl`);
  const truncated: TurnLogEntry = {
    ...entry,
    question_text: entry.question_text.slice(0, QUESTION_TEXT_MAX_LEN),
  };
  await appendFile(filePath, JSON.stringify(truncated) + '\n', 'utf-8').catch((err) => {
    console.error('[planbot] log write failed', err);
  });
}
