#!/usr/bin/env node
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { CLASSIFICATIONS, GATE_LENSES } from './gate-schema.js';

const CALLBACK_URL = process.env['CALLBACK_URL'];
if (!CALLBACK_URL) {
  console.error('[planbot-mcp] CALLBACK_URL env var missing');
  process.exit(1);
}

const server = new McpServer({ name: 'planbot', version: '1.0.0' });

server.registerTool(
  'reply_to_slack',
  {
    title: '슬랙 답변 전송',
    description:
      '충분히 탐색을 마쳤을 때, 기획자/영업팀의 질문에 대한 최종 답변을 슬랙 스레드로 전송한다. ' +
      '이 툴을 호출해야만 사용자에게 답변이 전달된다 — stdout에 답변을 출력하는 것만으로는 전달되지 않는다.',
    inputSchema: {
      text: z.string().describe('슬랙 스레드에 보낼 답변 본문 (마크다운 X, 슬랙 mrkdwn 사용)'),
      file_paths: z
        .array(z.string())
        .optional()
        .describe('함께 첨부할 로컬 파일 절대경로 목록 (선택)'),
      classification: z
        .enum(CLASSIFICATIONS)
        .describe(
          '시스템 프롬프트 "0. 상황 분류"에서 판단한 결과 (A=기획 원고 포함, B=순수 질문, ' +
          'C=지라 티켓 번호만, D=질문이 너무 광범위, E=대상 제품 불특정, F=`feedback` 커맨드). ' +
          '반드시 채워야 한다 — 생략 불가.',
        ),
      gate_issues: z
        .array(z.enum(GATE_LENSES))
        .describe(
          '"게이트 체크" 렌즈 중 실제로 걸린 항목의 id 목록. classification이 A·F가 ' +
          '아니었거나, 체크했지만 걸린 게 없으면 빈 배열([])을 넣는다 — 필드 자체를 생략하지 않는다.',
        ),
    },
  },
  async ({ text, file_paths, classification, gate_issues }) => {
    const res = await fetch(CALLBACK_URL!, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, filePaths: file_paths ?? [], classification, gateIssues: gate_issues }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return {
        content: [{ type: 'text', text: `전송 실패 (${res.status}): ${body.slice(0, 300)}` }],
        isError: true,
      };
    }
    return { content: [{ type: 'text', text: '슬랙 전송 완료' }] };
  },
);

server.registerTool(
  'propose_jira_comment',
  {
    title: 'Jira 댓글 등록 제안',
    description:
      '기획자가 게이트 지적을 바탕으로 확정한 보완 내용을 Jira 티켓에 댓글로 남기도록 "제안"한다. ' +
      '이 툴은 즉시 등록하지 않는다 — 슬랙 스레드에 미리보기가 올라가고, 요청자가 `등록`이라고 답해야 실제로 등록된다. ' +
      '반드시 reply_to_slack보다 **먼저** 호출할 것 (reply 후에는 세션이 정리되어 제안이 접수되지 않는다). ' +
      '사용자가 명시적으로 티켓에 남기길 요청한 경우에만 호출한다.',
    inputSchema: {
      ticket: z
        .string()
        .describe('댓글을 달 Jira 티켓 번호 (예: PROJ-1234). 스레드에서 확인된 실제 티켓만 사용.'),
      comment: z
        .string()
        .describe(
          'Jira에 남길 댓글 본문. AI 지적의 나열이 아니라, 기획자가 확정한 보완 맥락을 개발자가 읽을 문서로 정리한 것. ' +
          'Jira 위키마크업/플레인 텍스트로 작성 (슬랙 mrkdwn 금지).',
        ),
    },
  },
  async ({ ticket, comment }) => {
    const proposalUrl = CALLBACK_URL!.replace('/reply/', '/jira-proposal/');
    const res = await fetch(proposalUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticket, comment }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return {
        content: [{ type: 'text', text: `제안 접수 실패 (${res.status}): ${body.slice(0, 300)}` }],
        isError: true,
      };
    }
    return {
      content: [{
        type: 'text',
        text: '제안 접수 완료 — 스레드에 미리보기가 게시되었고, 요청자가 `등록`으로 승인하면 실제 등록된다. ' +
          '이어서 reply_to_slack 답변에 이 사실(승인해야 등록됨)을 안내하라.',
      }],
    };
  },
);

const GRAPHVIZ_BIN = process.env['GRAPHVIZ_BIN'] ?? 'dot';
const DIAGRAM_FONT = process.env['DIAGRAM_FONT'] ?? 'Malgun Gothic';
// 렌더 결과를 모아두는 디렉터리 — callback-server가 슬랙 업로드 후 같은 경로 규칙으로 파일을 정리한다.
// (import로 공유하지 않는다: 이 모듈은 최상위에서 CALLBACK_URL을 요구하며 즉시 MCP 서버로 기동되기 때문)
const DIAGRAM_TMP_DIR = path.join(os.tmpdir(), 'planbot-diagrams');

server.registerTool(
  'render_diagram',
  {
    title: '작동 흐름 다이어그램 렌더링',
    description:
      'Graphviz DOT 소스를 PNG로 렌더링하고 파일 절대경로를 반환한다. ' +
      '반환된 경로를 reply_to_slack의 file_paths에 넣으면 슬랙에 이미지로 첨부된다. ' +
      '렌더 실패 시 오류 메시지가 반환되므로 DOT를 고쳐 재호출할 수 있다.',
    inputSchema: {
      dot: z
        .string()
        .describe(
          'Graphviz DOT 소스 (예: digraph { rankdir=LR; "주문 수집" -> "재고 확인" }). ' +
          'fontname은 지정하지 말 것 — 시스템이 한글 폰트를 자동 적용한다.',
        ),
    },
  },
  async ({ dot }) => {
    await mkdir(DIAGRAM_TMP_DIR, { recursive: true });
    const base = path.join(DIAGRAM_TMP_DIR, `diagram-${crypto.randomBytes(6).toString('hex')}`);
    const dotPath = `${base}.dot`;
    const pngPath = `${base}.png`;
    await writeFile(dotPath, dot, 'utf-8');

    const result = await new Promise<{ code: number | null; stderr: string; spawnError?: string }>((resolve) => {
      // -G/-N/-E fontname은 기본값 주입이라 소스에 명시된 속성이 있으면 그쪽이 우선한다.
      const proc = spawn(GRAPHVIZ_BIN, [
        '-Tpng',
        `-Gfontname=${DIAGRAM_FONT}`,
        `-Nfontname=${DIAGRAM_FONT}`,
        `-Efontname=${DIAGRAM_FONT}`,
        '-o', pngPath,
        dotPath,
      ]);
      let stderr = '';
      proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      proc.on('close', (code) => resolve({ code, stderr }));
      proc.on('error', (err) => resolve({ code: null, stderr, spawnError: String(err) }));
    });

    if (result.spawnError) {
      return {
        content: [{
          type: 'text',
          text: `Graphviz 실행 실패: ${result.spawnError} — 원격 PC에 Graphviz(dot)가 설치돼 있지 않거나 ` +
            'GRAPHVIZ_BIN 경로가 잘못됐을 수 있다. 다이어그램 없이 텍스트로만 답변하라.',
        }],
        isError: true,
      };
    }
    if (result.code !== 0) {
      return {
        content: [{
          type: 'text',
          text: `DOT 렌더 실패 (exit ${result.code}): ${result.stderr.slice(0, 500)}\nDOT 문법을 고쳐 다시 호출하라 (최대 2회).`,
        }],
        isError: true,
      };
    }
    return { content: [{ type: 'text', text: `렌더 완료: ${pngPath} — 이 경로를 reply_to_slack의 file_paths에 넣어라.` }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
