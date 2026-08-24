const activeThreads = new Set<string>();
const turnCounters = new Map<string, number>();

function key(channel: string, threadTs: string): string {
  return `${channel}:${threadTs}`;
}

export function markThreadActive(channel: string, threadTs: string): void {
  activeThreads.add(key(channel, threadTs));
}

export function isThreadActive(channel: string, threadTs: string): boolean {
  return activeThreads.has(key(channel, threadTs));
}

/** 스레드별 턴 번호를 1부터 증가시켜 반환한다 (로그에서 같은 스레드의 턴 순서를 추적하기 위함). */
export function nextTurnIndex(channel: string, threadTs: string): number {
  const k = key(channel, threadTs);
  const next = (turnCounters.get(k) ?? 0) + 1;
  turnCounters.set(k, next);
  return next;
}
