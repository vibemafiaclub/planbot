import 'dotenv/config';
import { rm } from 'node:fs/promises';
import pkg from '@slack/bolt';
const { App } = pkg;
import { createJob } from './job-store.js';
import { runGatebotSession } from './claude-runner.js';
import { startCallbackServer } from './callback-server.js';
import { buildPrompt } from './system-prompt.js';
import { downloadSlackFiles, type SlackFileRef } from './attachment-fetch.js';
import { markThreadActive, isThreadActive, nextTurnIndex } from './thread-store.js';
import { logTurn } from './logger.js';
import { getTeam, setTeam, clearTeam, TEAMS, TEAM_REPOS } from './team-registry.js';
import { setPendingSelection, getPendingSelection, clearPendingSelection } from './team-selection-store.js';

const PROCESSING_TEXT = '(기획봇이 요청을 처리중입니다. 잠시만 기다려주세요.)';

const app = new pkg.App({
  token: process.env['SLACK_BOT_TOKEN'],
  appToken: process.env['SLACK_APP_TOKEN'],
  signingSecret: process.env['SLACK_SIGNING_SECRET'],
  socketMode: true,
});

const SLACK_BOT_TOKEN = process.env['SLACK_BOT_TOKEN']!;

let botUserId: string | null = null;
async function getBotUserId(): Promise<string> {
  if (botUserId) return botUserId;
  const auth = await app.client.auth.test();
  botUserId = auth.user_id as string;
  return botUserId;
}

const userNameCache = new Map<string, string>();
async function resolveUserName(userId: string): Promise<string> {
  if (userNameCache.has(userId)) return userNameCache.get(userId)!;
  try {
    const info = await app.client.users.info({ user: userId });
    const name = info.user?.real_name ?? info.user?.name ?? userId;
    userNameCache.set(userId, name);
    return name;
  } catch {
    return userId;
  }
}

async function buildThreadContext(
  channel: string,
  threadTs: string,
): Promise<{ text: string; filesTmpDir: string | null }> {
  const replies = await app.client.conversations.replies({ channel, ts: threadTs });
  const messages = replies.messages ?? [];

  const allFiles: SlackFileRef[] = [];
  for (const msg of messages) {
    if (msg.files) allFiles.push(...(msg.files as SlackFileRef[]));
  }
  const { tmpDir: filesTmpDir, localPathByFileId } = await downloadSlackFiles(allFiles, SLACK_BOT_TOKEN);

  const lines: string[] = [];
  for (const msg of messages) {
    const author = msg.user ? await resolveUserName(msg.user) : (msg.bot_id ? '(bot)' : '(unknown)');
    const text = msg.text ?? '';
    const files = (msg.files as SlackFileRef[] | undefined ?? [])
      .map((f) => {
        const localPath = f.id ? localPathByFileId.get(f.id) : undefined;
        return localPath
          ? `[첨부: ${f.name ?? f.id} → 로컬 절대경로(Read로 직접 열어볼 것): ${localPath}]`
          : `[첨부: ${f.name ?? f.id} (다운로드 실패 또는 20MB 초과 — 내용 확인 불가, 필요하면 사용자에게 텍스트로 요약 요청)]`;
      })
      .join(' ');
    const reactions = (msg.reactions ?? [])
      .map((r) => `:${r.name}:x${r.count}`)
      .join(' ');
    lines.push(`- ${author}: ${text}${files ? ' ' + files : ''}${reactions ? ` (반응: ${reactions})` : ''}`);
  }
  return { text: lines.join('\n'), filesTmpDir };
}

async function handleTurn(opts: {
  channel: string;
  threadTs: string;
  triggerMessageTs: string;
  senderUserId: string | null;
  triggerText: string;
}): Promise<void> {
  const { channel, threadTs, triggerMessageTs, senderUserId, triggerText } = opts;
  markThreadActive(channel, threadTs);
  const turnIndex = nextTurnIndex(channel, threadTs);
  const startedAt = Date.now();

  const logBase = {
    ts: new Date(startedAt).toISOString(),
    channel,
    thread_ts: threadTs,
    trigger_ts: triggerMessageTs,
    turn_index: turnIndex,
    question_text: triggerText,
  };

  try {
    await app.client.reactions.add({ channel, timestamp: triggerMessageTs, name: 'eyes' }).catch(() => {});

    const processingMsg = await app.client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: PROCESSING_TEXT,
    });

    const job = createJob({ channel, threadTs, triggerMessageTs });
    job.processingMessageTs = processingMsg.ts ?? null;

    const [{ text: threadContext, filesTmpDir }, senderName, senderTeam] = await Promise.all([
      buildThreadContext(channel, threadTs),
      senderUserId ? resolveUserName(senderUserId) : Promise.resolve(null),
      senderUserId ? getTeam(senderUserId) : Promise.resolve(null),
    ]);
    const senderTeamRepos = senderTeam ? TEAM_REPOS[senderTeam] : null;
    const prompt = buildPrompt(threadContext, senderTeam, senderTeamRepos);

    runGatebotSession({ prompt, token: job.token })
      .then(async () => {
        await logTurn({
          ...logBase,
          sender_user_id: senderUserId,
          sender_name: senderName,
          classification: job.classification,
          gate_issues: job.gateIssues,
          latency_ms: Date.now() - startedAt,
          status: 'ok',
        });
      })
      .catch(async (err) => {
        console.error('[planbot] session failed', err);
        await app.client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text: `⚠️ 처리 중 오류가 발생했습니다: ${String(err?.message ?? err)}`,
        }).catch(() => {});
        if (job.processingMessageTs) {
          await app.client.chat.delete({ channel, ts: job.processingMessageTs }).catch(() => {});
        }
        await logTurn({
          ...logBase,
          sender_user_id: senderUserId,
          sender_name: senderName,
          classification: job.classification,
          gate_issues: job.gateIssues,
          latency_ms: Date.now() - startedAt,
          status: 'error',
          error: String(err?.message ?? err),
        });
      })
      .finally(async () => {
        if (filesTmpDir) await rm(filesTmpDir, { recursive: true, force: true }).catch(() => {});
      });
  } catch (err) {
    console.error('[planbot] handleTurn error', err);
    await logTurn({
      ...logBase,
      sender_user_id: senderUserId,
      sender_name: null,
      classification: null,
      gate_issues: [],
      latency_ms: Date.now() - startedAt,
      status: 'error',
      error: String((err as Error)?.message ?? err),
    });
  }
}

// 스레드에서 처음 멘션됐을 때 — 스레드를 "활성"으로 등록하고 응답
app.event('app_mention', async ({ event }) => {
  const channel = event.channel;
  const threadTs = event.thread_ts ?? event.ts;
  await handleTurn({
    channel,
    threadTs,
    triggerMessageTs: event.ts,
    senderUserId: event.user ?? null,
    triggerText: event.text ?? '',
  });
});

// 이미 활성화된 스레드 안에서는 재멘션 없이 답글만 달아도 다음 턴으로 이어간다
app.message(async ({ message }) => {
  const m = message as { subtype?: string; bot_id?: string; channel?: string; thread_ts?: string; ts?: string; text?: string; user?: string };
  if (m.subtype || m.bot_id) return; // 봇 자신의 메시지·시스템 메시지는 무시
  if (!m.channel || !m.thread_ts || !m.ts) return; // 스레드 답글이 아니면 무시
  if (!isThreadActive(m.channel, m.thread_ts)) return; // 봇이 관여 중인 스레드가 아니면 무시

  const botId = await getBotUserId();
  if (m.text?.includes(`<@${botId}>`)) return; // 멘션 포함 메시지는 app_mention 핸들러가 이미 처리함

  await handleTurn({
    channel: m.channel,
    threadTs: m.thread_ts,
    triggerMessageTs: m.ts,
    senderUserId: m.user ?? null,
    triggerText: m.text ?? '',
  });
});

// 발신자가 본인 소속 팀을 스스로 등록한다. 이후 이 사람이 대상 제품을 명시하지 않고 질문하면
// (0번 상황분류 E) 이 팀을 힌트로 사용한다 — 다우 쪽에 전체 인원 명단을 별도로 받을 필요가 없다.
// UX: /planbot-team 만 입력 → 번호 매긴 팀 목록을 스레드로 올림 → 사용자가 번호로 답글 → 등록.
app.command('/planbot-team', async ({ command, ack }) => {
  await ack();

  const currentTeam = await getTeam(command.user_id);
  const teams = TEAMS;
  const deregisterIndex = currentTeam ? teams.length + 1 : null;

  const lines = [
    `<@${command.user_id}>님, 소속팀을 선택해주세요. 이 스레드에 번호로 답글을 달아주세요.`,
    ...teams.map((t, i) => `${i + 1}. ${t}`),
  ];
  if (deregisterIndex) {
    lines.push(`${deregisterIndex}. 지금 팀 해제 (현재 등록: ${currentTeam})`);
  }

  const posted = await app.client.chat.postMessage({
    channel: command.channel_id,
    text: lines.join('\n'),
  });

  if (posted.ts) {
    setPendingSelection(command.channel_id, posted.ts, {
      userId: command.user_id,
      teams,
      deregisterIndex,
    });
  }
});

// 위 스레드에 번호로 답글이 오면 그 번호로 팀을 등록/해제한다. Q&A 흐름과는 별개 — 게이트봇 세션을 띄우지 않는다.
app.message(async ({ message }) => {
  const m = message as { subtype?: string; bot_id?: string; channel?: string; thread_ts?: string; ts?: string; text?: string; user?: string };
  if (m.subtype || m.bot_id || !m.channel || !m.thread_ts || !m.user) return;

  const pending = getPendingSelection(m.channel, m.thread_ts);
  if (!pending) return;

  if (m.user !== pending.userId) {
    await app.client.chat.postMessage({
      channel: m.channel,
      thread_ts: m.thread_ts,
      text: '이 선택은 커맨드를 실행한 본인만 응답할 수 있습니다.',
    });
    return;
  }

  const maxIndex = pending.deregisterIndex ?? pending.teams.length;
  const num = Number(m.text?.trim());
  if (!Number.isInteger(num) || num < 1 || num > maxIndex) {
    await app.client.chat.postMessage({
      channel: m.channel,
      thread_ts: m.thread_ts,
      text: `1~${maxIndex} 사이 번호로 답해주세요.`,
    });
    return;
  }

  if (pending.deregisterIndex && num === pending.deregisterIndex) {
    await clearTeam(pending.userId);
    await app.client.chat.postMessage({ channel: m.channel, thread_ts: m.thread_ts, text: '팀 등록을 해제했습니다.' });
  } else {
    const team = pending.teams[num - 1];
    await setTeam(pending.userId, team);
    await app.client.chat.postMessage({
      channel: m.channel,
      thread_ts: m.thread_ts,
      text: `등록 완료: *${team}*. 대상 제품을 밝히지 않고 질문해도 이 팀을 참고합니다 (메시지에 다른 제품이 명시되면 그게 항상 우선됩니다).`,
    });
  }
  clearPendingSelection(m.channel, m.thread_ts);
});

const CALLBACK_PORT = Number(process.env['CALLBACK_PORT'] ?? 8788);
startCallbackServer(app.client as unknown as import('@slack/web-api').WebClient, CALLBACK_PORT);

await app.start();
await getBotUserId();
console.log('[planbot] Slack Socket Mode app started');
