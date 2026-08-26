import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env['DATA_DIR'] ?? path.join(__dirname, '..', 'data');
const REGISTRY_PATH = path.join(DATA_DIR, 'team-registry.json');

/**
 * TEAMS는 클라이언트 조직 고유 정보다. public repo(vibemafiaclub/planbot)로 동기화할 때는
 * 실제 팀명을 일반화된 placeholder로 교체해서 push한다 — 이 파일 자체는 커밋 대상이지만
 * 내용은 배포처마다 갈아끼우는 설정으로 취급한다. 사용자가 등록한 실제 매핑(누가 어느 팀인지)은
 * team-registry.json에 런타임 저장되며, 그건 data/와 함께 gitignore 대상이다.
 */
export const TEAMS = ['팀A', '팀B', '팀C'] as const;
export type Team = (typeof TEAMS)[number];

/**
 * 팀이 담당하는 REPO_ROOT(=Desktop/repos) 하위 레포 경로 — 팀이 정해지면 어느 레포부터 탐색할지 힌트로 쓴다.
 * 원격 PC 실제 구조는 `{팀 폴더}/{workspace}/{레포}` 2단계 중첩. consulting-export-full은 무시 대상이라 제외.
 */
export const TEAM_REPOS: Record<Team, string[]> = {
  팀A: [
    'org-a/workspace-a1/repo-a1',
    'org-a/workspace-a1/repo-a1-sdk',
    'org-a/workspace-a2/repo-a2',
    'org-a/workspace-a2/repo-a3',
    'org-a/workspace-a2/repo-a4',
  ],
  팀B: [
    'org-b/workspace-b1/repo-b1',
    'org-b/workspace-b1/repo-b2',
    'org-b/workspace-b1/repo-b3',
    'org-b/workspace-b1/repo-b4',
    'org-b/workspace-b1/repo-b5',
    'org-b/workspace-b1/repo-b6',
  ],
  팀C: [
    'org-c/workspace-c1/repo-c1',
    'org-c/workspace-c1/repo-c2',
    'org-c/workspace-c1/repo-c3',
    'org-c/workspace-c2/repo-c4',
    'org-c/workspace-c2/repo-c5',
    'org-c/workspace-c2/repo-c6',
    'org-c/workspace-c2/repo-c7',
  ],
};

type Registry = Record<string, Team>; // slack user_id -> team

let cache: Registry | null = null;

async function load(): Promise<Registry> {
  if (cache) return cache;
  try {
    const raw = await readFile(REGISTRY_PATH, 'utf-8');
    cache = JSON.parse(raw) as Registry;
  } catch {
    cache = {};
  }
  return cache;
}

async function save(registry: Registry): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(REGISTRY_PATH, JSON.stringify(registry, null, 2), 'utf-8');
}

export async function getTeam(userId: string): Promise<Team | null> {
  const registry = await load();
  return registry[userId] ?? null;
}

export async function setTeam(userId: string, team: Team): Promise<void> {
  const registry = await load();
  registry[userId] = team;
  cache = registry;
  await save(registry);
}

export async function clearTeam(userId: string): Promise<void> {
  const registry = await load();
  delete registry[userId];
  cache = registry;
  await save(registry);
}

export function isValidTeam(input: string): input is Team {
  return (TEAMS as readonly string[]).includes(input);
}
