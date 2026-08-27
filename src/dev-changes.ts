import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * dev 세션 전후의 planbot 레포 변경을 감지한다. dev 세션은 변경을 로컬 커밋까지 하도록 지시받으므로,
 * 워킹트리 dirty 상태와 세션 중 새로 생긴 커밋의 파일 목록을 함께 본다.
 */
export interface RepoSnapshot {
  head: string | null;
  dirtyFiles: Set<string>;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

function parsePorcelain(output: string): Set<string> {
  const files = new Set<string>();
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    // "XY path" 또는 rename "XY old -> new"
    const body = line.slice(3);
    const renamed = body.split(' -> ');
    files.add((renamed[renamed.length - 1] ?? body).trim());
  }
  return files;
}

export async function snapshotRepo(cwd: string): Promise<RepoSnapshot> {
  try {
    const [head, status] = await Promise.all([
      git(cwd, ['rev-parse', 'HEAD']),
      git(cwd, ['status', '--porcelain']),
    ]);
    return { head: head.trim(), dirtyFiles: parsePorcelain(status) };
  } catch {
    return { head: null, dirtyFiles: new Set() };
  }
}

/** 세션 전후 스냅샷을 비교해 이번 세션에서 바뀐 파일 목록을 구한다 (커밋된 변경 + 새로 dirty해진 파일). */
export async function diffSnapshots(cwd: string, before: RepoSnapshot, after: RepoSnapshot): Promise<string[]> {
  const changed = new Set<string>();
  for (const f of after.dirtyFiles) {
    if (!before.dirtyFiles.has(f)) changed.add(f);
  }
  if (before.head && after.head && before.head !== after.head) {
    try {
      const committed = await git(cwd, ['diff', '--name-only', `${before.head}..${after.head}`]);
      for (const f of committed.split('\n')) {
        if (f.trim()) changed.add(f.trim());
      }
    } catch {
      // diff 실패 시 dirty 비교 결과만 사용
    }
  }
  return [...changed].sort();
}

/** 재시동이 필요한 변경(런타임 코드)과 즉시 반영되는 변경(지침 등)을 나눈다. */
export function classifyChanges(files: string[]): { runtime: string[]; immediate: string[] } {
  const runtime: string[] = [];
  const immediate: string[] = [];
  for (const f of files) {
    const posix = f.replaceAll('\\', '/');
    if (posix.startsWith('src/') || posix === 'package.json' || posix === 'package-lock.json' || posix === 'tsconfig.json') {
      runtime.push(f);
    } else {
      immediate.push(f);
    }
  }
  return { runtime, immediate };
}
