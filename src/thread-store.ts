export type ThreadMode = 'qa' | 'feedback';

const activeThreads = new Set<string>();
const threadModes = new Map<string, ThreadMode>();
const turnCounters = new Map<string, number>();

function key(channel: string, threadTs: string): string {
  return `${channel}:${threadTs}`;
}

/** mode는 스레드가 처음 활성화될 때만 기록한다 — 이후 턴에서 다시 부르면 무시된다. */
export function markThreadActive(channel: string, threadTs: string, mode: ThreadMode): void {
  const k = key(channel, threadTs);
  activeThreads.add(k);
  if (!threadModes.has(k)) threadModes.set(k, mode);
}

export function isThreadActive(channel: string, threadTs: string): boolean {
  return activeThreads.has(key(channel, threadTs));
}

export function getThreadMode(channel: string, threadTs: string): ThreadMode {
  return threadModes.get(key(channel, threadTs)) ?? 'qa';
}

/** 스레드별 턴 번호를 1부터 증가시켜 반환한다 (로그에서 같은 스레드의 턴 순서를 추적하기 위함). */
export function nextTurnIndex(channel: string, threadTs: string): number {
  const k = key(channel, threadTs);
  const next = (turnCounters.get(k) ?? 0) + 1;
  turnCounters.set(k, next);
  return next;
}
