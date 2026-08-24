#!/usr/bin/env node
// planbot 턴 로그(logs/turns-*.jsonl)를 집계해 텍스트로 출력한다.
// 사용법: node scripts/log-report.mjs [--days=7]
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = process.env.LOG_DIR ?? path.join(__dirname, '..', 'logs');

const days = Number(process.argv.find((a) => a.startsWith('--days='))?.split('=')[1] ?? 7);

function isWithinDays(dateStr, windowDays) {
  const fileDate = new Date(`${dateStr}T00:00:00`);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - windowDays);
  return fileDate >= cutoff;
}

function printCounts(title, counts) {
  console.log(`\n${title}`);
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (sorted.length === 0) {
    console.log('  (없음)');
    return;
  }
  for (const [k, v] of sorted) {
    console.log(`  ${k}: ${v}`);
  }
}

async function main() {
  let files;
  try {
    files = await readdir(LOG_DIR);
  } catch {
    console.log(`로그 디렉터리가 없습니다: ${LOG_DIR}`);
    return;
  }

  const targetFiles = files
    .filter((f) => /^turns-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    .filter((f) => isWithinDays(f.slice(6, 16), days))
    .sort();

  if (targetFiles.length === 0) {
    console.log(`최근 ${days}일 내 로그가 없습니다.`);
    return;
  }

  const entries = [];
  for (const f of targetFiles) {
    const raw = await readFile(path.join(LOG_DIR, f), 'utf-8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        console.error(`[log-report] 파싱 실패, 건너뜀: ${f}`);
      }
    }
  }

  const total = entries.length;
  const okCount = entries.filter((e) => e.status === 'ok').length;
  const errorCount = total - okCount;

  const classificationCounts = {};
  const gateIssueCounts = {};
  const senderCounts = {};
  const latencies = [];

  for (const e of entries) {
    if (e.classification) {
      classificationCounts[e.classification] = (classificationCounts[e.classification] ?? 0) + 1;
    }
    for (const issue of e.gate_issues ?? []) {
      gateIssueCounts[issue] = (gateIssueCounts[issue] ?? 0) + 1;
    }
    const sender = e.sender_name ?? e.sender_user_id ?? '(unknown)';
    senderCounts[sender] = (senderCounts[sender] ?? 0) + 1;
    if (typeof e.latency_ms === 'number') latencies.push(e.latency_ms);
  }

  latencies.sort((a, b) => a - b);
  const avg = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;
  const p50 = latencies.length ? latencies[Math.floor(latencies.length * 0.5)] : 0;
  const p95 = latencies.length ? latencies[Math.floor(latencies.length * 0.95)] : 0;

  console.log(`=== planbot 로그 리포트 (최근 ${days}일, 파일 ${targetFiles.length}개) ===`);
  console.log(`총 턴: ${total} (성공 ${okCount} / 실패 ${errorCount})`);
  console.log(`지연시간(ms): avg=${avg} p50=${p50} p95=${p95}`);
  printCounts('상황 분류(classification)', classificationCounts);
  printCounts('게이트 이슈(gate_issues)', gateIssueCounts);
  printCounts('발신자별 사용량', senderCounts);
}

main();
