import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 시스템 프롬프트 본문은 코드가 아니라 `prompts/*.md`에 둔다. 매 턴 spawn 직전에 파일을 새로 읽으므로,
 * dev 커맨드로 지침을 수정하면 **재빌드·재시동 없이 다음 질의부터 즉시 반영**된다.
 * 렌즈 id 등 코드와 공유하는 상수는 gate-schema.ts가 기준 — prompts/_gate-lenses.md와 드리프트 주의.
 */
const PROMPTS_DIR = process.env['PROMPTS_DIR'] ?? path.join(__dirname, '..', 'prompts');

const INCLUDE_PATTERN = /\{\{include:([a-zA-Z0-9._-]+)\}\}/g;

async function renderTemplate(name: string, vars: Record<string, string>): Promise<string> {
  let text = await readFile(path.join(PROMPTS_DIR, name), 'utf-8');

  // 1단계 include만 지원 (partial 안에서 다시 include하지 않는다)
  const includeNames = [...text.matchAll(INCLUDE_PATTERN)].map((m) => m[1]);
  for (const inc of new Set(includeNames)) {
    const partial = (await readFile(path.join(PROMPTS_DIR, inc), 'utf-8')).trim();
    text = text.replaceAll(`{{include:${inc}}}`, partial);
  }

  for (const [key, value] of Object.entries(vars)) {
    text = text.replaceAll(`{{${key}}}`, value);
  }
  return text;
}

function buildTeamHintLine(senderTeam: string | null, senderTeamRepos: string[] | null): string {
  return senderTeam
    ? `이번 요청을 보낸 사람이 \`/planbot-team\`으로 등록해둔 소속팀: **${senderTeam}** (담당 레포: ${(senderTeamRepos ?? []).join(', ')}). ` +
      '(E) 판단 및 탐색 범위 힌트로만 쓴다 — 스레드에 다른 제품/레포가 명시돼 있으면 그게 항상 우선이다.'
    : '이번 요청을 보낸 사람은 소속팀을 등록하지 않았다 — (E) 판단이나 탐색 범위 힌트로 쓸 근거가 없다.';
}

export async function buildPrompt(
  threadContext: string,
  senderTeam: string | null,
  senderTeamRepos: string[] | null,
  mode: 'qa' | 'feedback' = 'qa',
): Promise<string> {
  return mode === 'feedback'
    ? renderTemplate('feedback.md', { THREAD_CONTEXT: threadContext })
    : renderTemplate('qa.md', {
        THREAD_CONTEXT: threadContext,
        TEAM_HINT: buildTeamHintLine(senderTeam, senderTeamRepos),
      });
}

export async function buildDevPrompt(
  threadContext: string,
  planbotRoot: string,
  repoRoot: string,
): Promise<string> {
  return renderTemplate('dev.md', {
    THREAD_CONTEXT: threadContext,
    PLANBOT_ROOT: planbotRoot,
    REPO_ROOT: repoRoot,
  });
}

export async function buildSearchPrompt(query: string, candidatesJsonl: string): Promise<string> {
  return renderTemplate('search.md', { QUERY: query, CANDIDATES: candidatesJsonl });
}
