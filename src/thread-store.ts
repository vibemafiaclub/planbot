import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type ThreadMode = 'qa' | 'feedback' | 'dev';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env['DATA_DIR'] ?? path.join(__dirname, '..', 'data');
const STATE_PATH = path.join(DATA_DIR, 'thread-state.json');

/** 채널 스레드에서 자동 반응(재멘션 불필요)이 유지되는 최대 유휴 시간. DM에는 적용하지 않는다. */
const AUTO_REPLY_TTL_MS = Number(process.env['AUTO_REPLY_TTL_MS'] ?? 86_400_000);
/** 이 기간 이상 업데이트가 없는 스레드 상태는 로드 시 정리한다. */
const STATE_RETENTION_MS = 45 * 86_400_000;

/**
 * 스레드 하나의 상태. 예전에는 스레드 단위 "활성" 플래그였지만, 지금은 **사용자 단위** 자동 반응이다:
 * planbot을 멘션한 사용자만 activeUsers에 올라가고, 그 사용자의 재멘션 없는 답글에만 반응한다.
 * 같은 스레드의 다른 사람 답글에는 반응하지 않는다 (사람 간 대화에 봇이 끼어드는 것 방지).
 * 사용자가 다른 사용자/봇/@here 등을 멘션하면 그 사용자의 자동 반응이 꺼지고, planbot을 재멘션하면 다시 켜진다.
 */
interface ThreadState {
  mode: ThreadMode;
  isDm: boolean;
  /** userId -> 마지막 활동(ms). TTL 판정 기준. */
  activeUsers: Record<string, number>;
  turnCounter: number;
  updatedAt: number;
}

const states = new Map<string, ThreadState>();

function key(channel: string, threadTs: string): string {
  return `${channel}:${threadTs}`;
}

/** 봇 재시동 후에도 진행 중이던 스레드 대화가 끊기지 않도록 디스크에서 복구한다. 부팅 시 1회 호출. */
export async function loadThreadStates(): Promise<void> {
  try {
    const raw = await readFile(STATE_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, ThreadState>;
    const cutoff = Date.now() - STATE_RETENTION_MS;
    for (const [k, v] of Object.entries(parsed)) {
      if ((v.updatedAt ?? 0) >= cutoff) states.set(k, v);
    }
  } catch {
    // 파일 없음/파손 — 빈 상태로 시작
  }
}

let saveTimer: NodeJS.Timeout | null = null;
function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void (async () => {
      try {
        await mkdir(DATA_DIR, { recursive: true });
        await writeFile(STATE_PATH, JSON.stringify(Object.fromEntries(states), null, 2), 'utf-8');
      } catch (err) {
        console.error('[planbot] thread-state save failed', err);
      }
    })();
  }, 500);
}

/** mode는 스레드 상태가 처음 만들어질 때만 기록한다 — 이후에 다시 불러도 무시된다. */
export function ensureThread(channel: string, threadTs: string, mode: ThreadMode, isDm: boolean): ThreadState {
  const k = key(channel, threadTs);
  let state = states.get(k);
  if (!state) {
    state = { mode, isDm, activeUsers: {}, turnCounter: 0, updatedAt: Date.now() };
    states.set(k, state);
    scheduleSave();
  }
  return state;
}

export function getThreadMode(channel: string, threadTs: string): ThreadMode {
  return states.get(key(channel, threadTs))?.mode ?? 'qa';
}

/** 해당 사용자의 자동 반응을 켜거나 활동 시각을 갱신한다. 턴이 처리될 때마다 호출된다. */
export function activateUser(channel: string, threadTs: string, userId: string): void {
  const state = states.get(key(channel, threadTs));
  if (!state) return;
  state.activeUsers[userId] = Date.now();
  state.updatedAt = Date.now();
  scheduleSave();
}

/** 사용자가 다른 사용자/봇을 멘션했을 때 자동 반응을 끈다. planbot 재멘션 전까지 이 사용자에겐 반응하지 않는다. */
export function deactivateUser(channel: string, threadTs: string, userId: string): void {
  const state = states.get(key(channel, threadTs));
  if (!state) return;
  delete state.activeUsers[userId];
  state.updatedAt = Date.now();
  scheduleSave();
}

/**
 * 이 사용자의 재멘션 없는 답글에 반응해야 하는가.
 * DM 스레드는 항상 true. 채널 스레드는 활성 사용자이면서 TTL(기본 24시간)이 지나지 않았을 때만 true —
 * 오래 잠들어 있던 스레드에 사용자가 딴 얘기를 답글로 달았을 때 봇이 되살아나는 것을 막는다.
 */
export function isUserActive(channel: string, threadTs: string, userId: string): boolean {
  const state = states.get(key(channel, threadTs));
  if (!state) return false;
  if (state.isDm) return true;
  const last = state.activeUsers[userId];
  if (last === undefined) return false;
  if (Date.now() - last > AUTO_REPLY_TTL_MS) {
    delete state.activeUsers[userId];
    scheduleSave();
    return false;
  }
  return true;
}

/** 봇이 응답한 적 있는(상태가 만들어진) 스레드인가 — 승인 안내 문구 분기 등에 사용. */
export function isThreadKnown(channel: string, threadTs: string): boolean {
  return states.has(key(channel, threadTs));
}

/** 스레드별 턴 번호를 1부터 증가시켜 반환한다 (로그에서 같은 스레드의 턴 순서를 추적하기 위함). */
export function nextTurnIndex(channel: string, threadTs: string): number {
  const state = states.get(key(channel, threadTs));
  if (!state) return 1;
  state.turnCounter += 1;
  state.updatedAt = Date.now();
  scheduleSave();
  return state.turnCounter;
}
