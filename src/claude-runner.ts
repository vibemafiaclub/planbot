import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLAUDE_BIN = process.env['CLAUDE_BIN'] ?? 'claude';
const REPO_ROOT = process.env['REPO_ROOT'] ?? process.cwd();
const CALLBACK_PORT = process.env['CALLBACK_PORT'] ?? '8788';
const TIMEOUT_MS = Number(process.env['CLAUDE_TIMEOUT_MS'] ?? 1_800_000);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_ENTRY = path.join(__dirname, 'mcp-server.js');

/**
 * 이 봇의 답변 채널은 MCP 콜백(reply_to_slack)이다.
 * claude가 프로세스를 정상 종료해도 그 stdout은 사용하지 않는다 — 관측/디버깅용 로그일 뿐.
 *
 * --dangerously-skip-permissions는 쓰지 않는다. 슬랙 스레드 텍스트/첨부가 그대로 프롬프트에 들어가므로
 * 프롬프트 인젝션에 노출돼 있고, headless(--print)에서는 화이트리스트 밖 툴이 조용히 거부되므로
 * --allowedTools만으로 승인 없이도 안전하게 도구 범위를 좁힐 수 있다.
 */
export async function runGatebotSession(opts: { prompt: string; token: string }): Promise<void> {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'planbot-'));
  const mcpConfigPath = path.join(tmpDir, 'mcp-config.json');

  const mcpConfig = {
    mcpServers: {
      planbot: {
        command: 'node',
        args: [MCP_SERVER_ENTRY],
        env: {
          CALLBACK_URL: `http://127.0.0.1:${CALLBACK_PORT}/reply/${opts.token}`,
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
        '--model', 'sonnet',
        '--allowedTools', 'Read,Grep,Glob,Bash(jira issue view:*),mcp__planbot__reply_to_slack',
        '--output-format=text',
        '--mcp-config', mcpConfigPath,
        '--strict-mcp-config',
      ];

      const proc = spawn(CLAUDE_BIN, args, {
        cwd: REPO_ROOT,
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
