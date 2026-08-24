#!/usr/bin/env node
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
          'C=지라 티켓 번호만, D=질문이 너무 광범위, E=대상 제품 불특정). 반드시 채워야 한다 — 생략 불가.',
        ),
      gate_issues: z
        .array(z.enum(GATE_LENSES))
        .describe(
          '"1. 게이트 체크" 5개 렌즈 중 실제로 걸린 항목의 id 목록. classification이 A(기획 원고 포함)가 ' +
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

const transport = new StdioServerTransport();
await server.connect(transport);
