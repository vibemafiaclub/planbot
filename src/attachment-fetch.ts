import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const MAX_FILE_BYTES = 20 * 1024 * 1024; // 20MB — 그 이상은 다운로드하지 않고 파일명만 남긴다

export interface SlackFileRef {
  id?: string;
  name?: string;
  url_private?: string;
  size?: number;
}

function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[^\w.\-가-힣 ]/g, '_').slice(0, 200);
  return cleaned || 'file';
}

/**
 * 스레드에 첨부된 파일들을 실제로 다운로드해 임시 디렉터리에 저장한다.
 * claude 프로세스가 --dangerously-skip-permissions로 실행되므로 절대경로만 넘기면
 * 파일 내용을 직접 Read할 수 있다 — 첨부파일 이름만으로는 기획서 내용(게이트 체크 대상)을 볼 수 없어서 필요.
 */
export async function downloadSlackFiles(
  files: SlackFileRef[],
  botToken: string,
): Promise<{ tmpDir: string | null; localPathByFileId: Map<string, string> }> {
  const localPathByFileId = new Map<string, string>();
  if (files.length === 0) return { tmpDir: null, localPathByFileId };

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'planbot-files-'));

  for (const f of files) {
    if (!f.url_private || !f.id) continue;
    if (f.size && f.size > MAX_FILE_BYTES) continue;
    try {
      const res = await fetch(f.url_private, {
        headers: { Authorization: `Bearer ${botToken}` },
      });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      const fileName = sanitizeFileName(f.name ?? f.id);
      const localPath = path.join(tmpDir, `${f.id}-${fileName}`);
      await writeFile(localPath, buf);
      localPathByFileId.set(f.id, localPath);
    } catch (err) {
      console.error('[planbot] attachment download failed', f.name, err);
    }
  }

  return { tmpDir, localPathByFileId };
}
