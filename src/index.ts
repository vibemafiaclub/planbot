import 'dotenv/config';
import { rm } from 'node:fs/promises';
import pkg from '@slack/bolt';
const { App } = pkg;
import { createJob } from './job-store.js';
import { runGatebotSession } from './claude-runner.js';
import { startCallbackServer } from './callback-server.js';
import { buildPrompt } from './system-prompt.js';
import { downloadSlackFiles, type SlackFileRef } from './attachment-fetch.js';
import { markThreadActive, isThreadActive, nextTurnIndex, getThreadMode, type ThreadMode } from './thread-store.js';
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

interface ContextMessage {
  user?: string;
  bot_id?: string;
  text?: string;
  files?: SlackFileRef[];
  reactions?: { name?: string; count?: number }[];
}

async function renderMessages(
  messages: ContextMessage[],
): Promise<{ text: string; filesTmpDir: string | null }> {
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

async function buildThreadContext(
  channel: string,
  threadTs: string,
): Promise<{ text: string; filesTmpDir: string | null }> {
  const replies = await app.client.conversations.replies({ channel, ts: threadTs });
  return renderMessages((replies.messages ?? []) as ContextMessage[]);
}

// 1:1 DM은 스레드 강제 없이 채널 자체를 하나의 연속 대화로 취급한다.
// conversations.history는 최신순으로 오므로 뒤집어서 시간순으로 만든다.
const DM_HISTORY_LIMIT = 30;
async function buildDmContext(channel: string): Promise<{ text: string; filesTmpDir: string | null }> {
  const history = await app.client.conversations.history({ channel, limit: DM_HISTORY_LIMIT });
  const messages = ((history.messages ?? []) as ContextMessage[])
    .slice()
    .reverse()
    .filter((m) => m.text !== PROCESSING_TEXT); // 진행중 표시 메시지는 컨텍스트에서 제외
  return renderMessages(messages);
}

/**
 * 멘션 뒤 첫 단어로 커맨드를 판별한다.
 * - `feedback`: 그 스레드는 끝까지 피드백 전용 모드로 고정된다 (thread-store.ts가 최초 1회만 mode를 기록).
 * - `team`: 게이트봇 세션을 띄우지 않는 팀 등록 플로우로 분기된다 (`/planbot-team` 대체).
 * - 그 외: 일반 Q&A.
 */
function detectMentionCommand(triggerText: string, botUserId: string): 'feedback' | 'team' | null {
  const stripped = triggerText.replace(`<@${botUserId}>`, '').trim();
  const firstWord = (stripped.split(/\s+/)[0] ?? '').toLowerCase();
  if (firstWord === 'feedback') return 'feedback';
  if (firstWord === 'team') return 'team';
  return null;
}

async function handleTurn(opts: {
  channel: string;
  /** null이면 1:1 DM 최상위 대화 — 스레드 대신 DM 히스토리를 컨텍스트로 쓰고 최상위로 답장한다 */
  threadTs: string | null;
  triggerMessageTs: string;
  senderUserId: string | null;
  triggerText: string;
  initialMode: ThreadMode;
}): Promise<void> {
  const { channel, threadTs, triggerMessageTs, senderUserId, triggerText, initialMode } = opts;
  let mode: ThreadMode;
  if (threadTs === null) {
    // DM 연속 대화는 스레드처럼 모드를 고정하지 않는다 — 매 메시지 첫 단어(feedback)로 그 턴의 모드가 결정된다.
    mode = initialMode;
  } else {
    markThreadActive(channel, threadTs, initialMode);
    mode = getThreadMode(channel, threadTs);
  }
  const turnIndex = nextTurnIndex(channel, threadTs ?? 'dm');
  const startedAt = Date.now();

  const logBase = {
    ts: new Date(startedAt).toISOString(),
    channel,
    thread_ts: threadTs ?? '(dm)',
    trigger_ts: triggerMessageTs,
    turn_index: turnIndex,
    question_text: triggerText,
  };

  try {
    await app.client.reactions.add({ channel, timestamp: triggerMessageTs, name: 'eyes' }).catch(() => {});

    const processingMsg = await app.client.chat.postMessage({
      channel,
      thread_ts: threadTs ?? undefined,
      text: PROCESSING_TEXT,
    });

    const job = createJob({ channel, threadTs, triggerMessageTs });
    job.processingMessageTs = processingMsg.ts ?? null;

    const [{ text: threadContext, filesTmpDir }, senderName, senderTeam] = await Promise.all([
      threadTs === null ? buildDmContext(channel) : buildThreadContext(channel, threadTs),
      senderUserId ? resolveUserName(senderUserId) : Promise.resolve(null),
      senderUserId ? getTeam(senderUserId) : Promise.resolve(null),
    ]);
    const senderTeamRepos = senderTeam ? TEAM_REPOS[senderTeam] : null;
    const prompt = buildPrompt(threadContext, senderTeam, senderTeamRepos, mode);

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
          thread_ts: threadTs ?? undefined,
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

// DM(1:1)에서는 스레드가 없으므로 채널당 하나의 고정 키로 대기 중인 팀 선택을 관리한다.
// DM 채널은 사용자별로 유일하므로 충돌하지 않는다.
const DM_SELECTION_KEY = 'dm-team-selection';

// 발신자가 본인 소속 팀을 스스로 등록한다. 이후 이 사람이 대상 제품을 명시하지 않고 질문하면
// (0번 상황분류 E) 이 팀을 힌트로 사용한다 — 클라이언트 쪽에 전체 인원 명단을 별도로 받을 필요가 없다.
// UX(채널): `@planbot team` 멘션 → 유저 메시지에 답글로 번호 매긴 팀 목록 → 그 스레드에 번호로 답글 → 등록.
// UX(DM): `team` 메시지 → 최상위로 번호 목록 → 최상위로 번호 답장 → 등록.
async function startTeamSelection(channel: string, userId: string, triggerTs: string | null): Promise<void> {
  const currentTeam = await getTeam(userId);
  const teams = TEAMS;
  const deregisterIndex = currentTeam ? teams.length + 1 : null;
  const isDm = triggerTs === null;

  const lines = [
    isDm
      ? `<@${userId}>님, 소속팀을 선택해주세요. 번호로 답장해주세요.`
      : `<@${userId}>님, 소속팀을 선택해주세요. 이 스레드에 번호로 답글을 달아주세요.`,
    ...teams.map((t, i) => `${i + 1}. ${t}`),
  ];
  if (deregisterIndex) {
    lines.push(`${deregisterIndex}. 지금 팀 해제 (현재 등록: ${currentTeam})`);
  }

  await app.client.chat.postMessage({ channel, thread_ts: triggerTs ?? undefined, text: lines.join('\n') });

  // 채널: 스레드 루트는 유저의 원본 멘션 메시지(triggerTs)다 — 이후 번호 답글도 같은 thread_ts로 온다.
  // DM: 고정 키로 등록하고 다음 최상위 메시지에서 번호를 받는다.
  setPendingSelection(channel, triggerTs ?? DM_SELECTION_KEY, { userId, teams, deregisterIndex });
}

/**
 * 대기 중인 팀 선택이 있으면 이 메시지를 번호 답변으로 소비한다.
 * @returns 해당 키에 대기 중인 선택이 있었으면 true (메시지를 소비했으므로 다른 핸들링 금지)
 */
async function applyTeamSelectionReply(
  channel: string,
  selectionKey: string,
  respondThreadTs: string | undefined,
  userId: string,
  text: string,
): Promise<boolean> {
  const pending = getPendingSelection(channel, selectionKey);
  if (!pending) return false;

  const respond = (msg: string) =>
    app.client.chat.postMessage({ channel, thread_ts: respondThreadTs, text: msg });

  if (userId !== pending.userId) {
    await respond('이 선택은 커맨드를 실행한 본인만 응답할 수 있습니다.');
    return true;
  }

  const maxIndex = pending.deregisterIndex ?? pending.teams.length;
  const num = Number(text.trim());
  if (!Number.isInteger(num) || num < 1 || num > maxIndex) {
    await respond(`1~${maxIndex} 사이 번호로 답해주세요.`);
    return true;
  }

  if (pending.deregisterIndex && num === pending.deregisterIndex) {
    await clearTeam(pending.userId);
    await respond('팀 등록을 해제했습니다.');
  } else {
    const team = pending.teams[num - 1];
    await setTeam(pending.userId, team);
    await respond(
      `등록 완료: *${team}*. 대상 제품을 밝히지 않고 질문해도 이 팀을 참고합니다 (메시지에 다른 제품이 명시되면 그게 항상 우선됩니다).`,
    );
  }
  clearPendingSelection(channel, selectionKey);
  return true;
}

// 스레드에서 처음 멘션됐을 때 — 스레드를 "활성"으로 등록하고 응답
// 멘션 뒤 첫 단어가 `feedback`이면 이 스레드는 끝까지 자료 품질 평가 전용 모드로 고정된다.
// 첫 단어가 `team`이면 게이트봇 세션 없이 팀 등록 플로우로 바로 분기한다.
app.event('app_mention', async ({ event }) => {
  const channel = event.channel;
  if (channel.startsWith('D')) return; // 1:1 DM은 전용 message.im 핸들러가 처리 — 이중 응답 방지
  const threadTs = event.thread_ts ?? event.ts;
  const triggerText = event.text ?? '';
  const botId = await getBotUserId();
  const command = detectMentionCommand(triggerText, botId);

  if (command === 'team') {
    if (event.user) await startTeamSelection(channel, event.user, event.ts);
    return;
  }

  await handleTurn({
    channel,
    threadTs,
    triggerMessageTs: event.ts,
    senderUserId: event.user ?? null,
    triggerText,
    initialMode: command === 'feedback' ? 'feedback' : 'qa',
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
    initialMode: getThreadMode(m.channel, m.thread_ts), // 이미 활성 스레드이므로 기록된 mode를 그대로 넘긴다 (markThreadActive가 덮어쓰지 않음)
  });
});

// 위 스레드에 번호로 답글이 오면 그 번호로 팀을 등록/해제한다. Q&A 흐름과는 별개 — 게이트봇 세션을 띄우지 않는다.
app.message(async ({ message }) => {
  const m = message as { subtype?: string; bot_id?: string; channel?: string; thread_ts?: string; ts?: string; text?: string; user?: string };
  if (m.subtype || m.bot_id || !m.channel || !m.thread_ts || !m.user) return;

  await applyTeamSelectionReply(m.channel, m.thread_ts, m.thread_ts, m.user, m.text ?? '');
});

// 1:1 DM — 멘션·스레드 없이 일반 메시지만 보내면 된다. Slack 앱에 `im:history` scope와
// `message.im` 이벤트 구독이 있어야 이 핸들러에 이벤트가 들어온다.
// DM 채널 전체를 하나의 연속 대화로 취급한다: 컨텍스트는 최근 DM 히스토리, 답장도 최상위.
// 모드는 스레드처럼 고정하지 않고 매 메시지 첫 단어(`feedback`)로 그 턴만 결정된다.
app.message(async ({ message }) => {
  const m = message as { subtype?: string; bot_id?: string; channel?: string; channel_type?: string; thread_ts?: string; ts?: string; text?: string; user?: string };
  if (m.subtype || m.bot_id || !m.channel || !m.ts) return;
  if (m.channel_type !== 'im') return;
  if (m.thread_ts) return; // DM 안에서 스레드 답글을 단 경우 — DM은 최상위 대화만 지원 (안내는 README 참조)

  const botId = await getBotUserId();
  // DM에서도 습관적으로 멘션을 붙일 수 있으므로 제거하고 커맨드를 판별한다.
  const stripped = (m.text ?? '').replace(`<@${botId}>`, '').trim();

  // 대기 중인 팀 선택이 있으면: 번호면 선택으로 소비, 번호가 아니면 선택을 취소하고 일반 질문으로 계속.
  // (스레드와 달리 DM은 채널 전체가 하나의 대화라, 계속 번호를 요구하면 Q&A가 통째로 막히기 때문)
  if (m.user && getPendingSelection(m.channel, DM_SELECTION_KEY)) {
    if (stripped !== '' && Number.isInteger(Number(stripped))) {
      await applyTeamSelectionReply(m.channel, DM_SELECTION_KEY, undefined, m.user, stripped);
      return;
    }
    clearPendingSelection(m.channel, DM_SELECTION_KEY);
    await app.client.chat.postMessage({
      channel: m.channel,
      text: '(번호가 아닌 메시지가 와서 팀 선택을 취소했습니다. `team`으로 다시 시작할 수 있어요.)',
    }).catch(() => {});
  }

  const firstWord = (stripped.split(/\s+/)[0] ?? '').toLowerCase();
  if (firstWord === 'team') {
    if (m.user) await startTeamSelection(m.channel, m.user, null);
    return;
  }

  await handleTurn({
    channel: m.channel,
    threadTs: null,
    triggerMessageTs: m.ts,
    senderUserId: m.user ?? null,
    triggerText: m.text ?? '',
    initialMode: firstWord === 'feedback' ? 'feedback' : 'qa',
  });
});

const CALLBACK_PORT = Number(process.env['CALLBACK_PORT'] ?? 8788);
startCallbackServer(app.client as unknown as import('@slack/web-api').WebClient, CALLBACK_PORT);

await app.start();
await getBotUserId();
console.log('[planbot] Slack Socket Mode app started');
