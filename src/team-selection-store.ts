import type { Team } from './team-registry.js';

export interface PendingSelection {
  userId: string;
  teams: readonly Team[];
  /** 이미 팀이 등록된 사용자에게만 존재 — 이 번호를 고르면 등록 해제 */
  deregisterIndex: number | null;
}

const pending = new Map<string, PendingSelection>();

function key(channel: string, threadTs: string): string {
  return `${channel}:${threadTs}`;
}

export function setPendingSelection(channel: string, threadTs: string, selection: PendingSelection): void {
  pending.set(key(channel, threadTs), selection);
}

export function getPendingSelection(channel: string, threadTs: string): PendingSelection | undefined {
  return pending.get(key(channel, threadTs));
}

export function clearPendingSelection(channel: string, threadTs: string): void {
  pending.delete(key(channel, threadTs));
}
