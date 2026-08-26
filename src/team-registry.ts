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
 * 팀이 담당하는 REPO_ROOT 하위 레포 경로 — 팀이 정해지면 어느 레포부터 탐색할지 힌트로 쓴다.
 * 실 배포 시 REPO_ROOT 아래 실제 폴더 구조에 맞게 교체할 것 (팀 폴더 1단계일 수도, 팀 폴더 안에
 * workspace/레포 2단계로 중첩돼 있을 수도 있다 — 배포 환경마다 다르다).
 */
export const TEAM_REPOS: Record<Team, string[]> = {
  팀A: ['repo-a1', 'repo-a2'],
  팀B: ['repo-b1'],
  팀C: ['repo-c1', 'repo-c2'],
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
