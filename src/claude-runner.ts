import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLAUDE_BIN = process.env['CLAUDE_BIN'] ?? 'claude';
export const REPO_ROOT = process.env['REPO_ROOT'] ?? process.cwd();
const CALLBACK_PORT = process.env['CALLBACK_PORT'] ?? '8788';
const TIMEOUT_MS = Number(process.env['CLAUDE_TIMEOUT_MS'] ?? 1_800_000);
const CLAUDE_MODEL = process.env['CLAUDE_MODEL'] ?? 'sonnet';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_ENTRY = path.join(__dirname, 'mcp-server.js');
/** planbot 앱 자체의 루트 — dev 모드 세션의 cwd이자 쓰기 허용 범위. */
export const PLANBOT_ROOT = path.join(__dirname, '..');

/** qa/feedback 세션의 기본 도구 화이트리스트. Write·Edit·임의 Bash는 의도적으로 없다. */
export const DEFAULT_ALLOWED_TOOLS = [
  'Read',
  'Grep',
  'Glob',
  'Bash(jira issue view:*)',
  'mcp__planbot__reply_to_slack',
  'mcp__planbot__propose_jira_comment',
  'mcp__planbot__render_diagram',
];

/** search 세션은 후보가 전부 프롬프트에 들어가므로 레포 접근이 필요 없다. */
export const SEARCH_ALLOWED_TOOLS = ['mcp__planbot__reply_to_slack'];

/** 절대경로 permission rule용 — Windows 역슬래시를 슬래시로 바꾸고 `//` 접두를 붙인다. */
function toAbsoluteRulePath(p: string): string {
  return '//' + path.resolve(p).replaceAll('\\', '/').replace(/^\/+/, '');
}

/**
 * dev 모드 도구: planbot 루트는 전부 쓰기 가능, 클라이언트 레포(REPO_ROOT)는 CLAUDE.md만 쓰기 가능.
 * Bash는 무제한이다(빌드·git 커밋에 필요) — Bash로 경로 제한을 우회할 수 있다는 한계는 관리자 전용
 * 커맨드라는 전제로 수용한다 (dev는 화이트리스트 사용자만 호출 가능).
 */
export function devAllowedTools(): string[] {
  const pb = toAbsoluteRulePath(PLANBOT_ROOT);
  const rr = toAbsoluteRulePath(REPO_ROOT);
  return [
    'Read',
    'Grep',
    'Glob',
    'Bash',
    `Edit(${pb}/**)`,
    `Write(${pb}/**)`,
    `Edit(${rr}/**/CLAUDE.md)`,
    `Write(${rr}/**/CLAUDE.md)`,
    'mcp__planbot__reply_to_slack',
    'mcp__planbot__render_diagram',
  ];
}

export interface SessionOptions {
  prompt: string;
  token: string;
  /** 기본값 DEFAULT_ALLOWED_TOOLS */
  allowedTools?: string[];
  /** 기본값 REPO_ROOT */
  cwd?: string;
  /** cwd 밖에서 추가로 접근할 디렉터리 (--add-dir) */
  addDirs?: string[];
}

/**
 * 이 봇의 답변 채널은 MCP 콜백(reply_to_slack)이다.
 * claude가 프로세스를 정상 종료해도 그 stdout은 사용하지 않는다 — 관측/디버깅용 로그일 뿐.
 *
 * --dangerously-skip-permissions는 쓰지 않는다. 슬랙 스레드 텍스트/첨부가 그대로 프롬프트에 들어가므로
 * 프롬프트 인젝션에 노출돼 있고, headless(--print)에서는 화이트리스트 밖 툴이 조용히 거부되므로
 * --allowedTools만으로 승인 없이도 안전하게 도구 범위를 좁힐 수 있다.
 */
export async function runGatebotSession(opts: SessionOptions): Promise<void> {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'planbot-'));
  const mcpConfigPath = path.join(tmpDir, 'mcp-config.json');

  const mcpConfig = {
    mcpServers: {
      planbot: {
        // PATH의 'node'가 아니라 지금 이 프로세스를 띄운 node 실행 파일 절대경로를 쓴다
        // — 원격 PC에서 claude가 상속받은 PATH에 node가 없어도 MCP 서버 spawn이 실패하지 않는다.
        command: process.execPath,
        args: [MCP_SERVER_ENTRY],
        env: {
          CALLBACK_URL: `http://127.0.0.1:${CALLBACK_PORT}/reply/${opts.token}`,
          ...(process.env['GRAPHVIZ_BIN'] ? { GRAPHVIZ_BIN: process.env['GRAPHVIZ_BIN'] } : {}),
          ...(process.env['DIAGRAM_FONT'] ? { DIAGRAM_FONT: process.env['DIAGRAM_FONT'] } : {}),
        },
      },
    },
  };
  await writeFile(mcpConfigPath, JSON.stringify(mcpConfig, null, 2), 'utf-8');

  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new Error(`claude timed out after ${TIMEOUT_MS}ms`));
      }, TIMEOUT_MS);

      const args = [
        '--print',
        '--model', CLAUDE_MODEL,
        '--allowedTools', (opts.allowedTools ?? DEFAULT_ALLOWED_TOOLS).join(','),
        '--output-format=text',
        '--mcp-config', mcpConfigPath,
        '--strict-mcp-config',
      ];
      for (const dir of opts.addDirs ?? []) {
        args.push('--add-dir', dir);
      }

      const proc = spawn(CLAUDE_BIN, args, {
        cwd: opts.cwd ?? REPO_ROOT,
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      proc.stdin.write(opts.prompt);
      proc.stdin.end();

      let stderr = '';
      proc.stdout.on('data', () => { /* 사용 안 함 — 답변은 reply_to_slack MCP 콜백으로 전송됨 */ });
      proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`claude exited ${code}: ${stderr.slice(0, 500)}`));
          return;
        }
        resolve();
      });
      proc.on('error', (err) => { clearTimeout(timer); reject(err); });
    });
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}
