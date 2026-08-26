import 'dotenv/config';
import { rm } from 'node:fs/promises';
import pkg from '@slack/bolt';
const { App } = pkg;
import { createJob, deleteJob, LOADING_REACTION } from './job-store.js';
import { runGatebotSession } from './claude-runner.js';
import { startCallbackServer } from './callback-server.js';
import { buildPrompt } from './system-prompt.js';
import { downloadSlackFiles, type SlackFileRef } from './attachment-fetch.js';
import { markThreadActive, isThreadActive, nextTurnIndex, getThreadMode, type ThreadMode } from './thread-store.js';
import { logTurn } from './logger.js';
import { getTeam, setTeam, clearTeam, TEAMS, TEAM_REPOS } from './team-registry.js';
import { getProposal, clearProposal, addJiraComment } from './jira-comment.js';
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
  threadTs: string;
  triggerMessageTs: string;
  senderUserId: string | null;
  triggerText: string;
  initialMode: ThreadMode;
  /**
   * true면 이 스레드를 "활성"으로 등록해 이후 재멘션 없는 답글에도 반응한다.
   * 봇 멘션으로 시작된 스레드(루트가 멘션)와 DM에만 true — 사람들끼리 대화하던 스레드에
   * 봇이 도중 참전한 경우엔 false로, 이후에도 멘션에만 반응한다 (일반 대화에 끼어들지 않기 위함).
   */
  activateThread: boolean;
}): Promise<void> {
  const { channel, threadTs, triggerMessageTs, senderUserId, triggerText, initialMode, activateThread } = opts;
  if (activateThread) markThreadActive(channel, threadTs, initialMode);
  // 활성 스레드는 기록된 모드로 고정, 비활성(멘션에만 반응) 스레드는 이번 멘션의 첫 단어로 매번 결정
  const mode = isThreadActive(channel, threadTs) ? getThreadMode(channel, threadTs) : initialMode;
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
    await app.client.reactions.add({ channel, timestamp: triggerMessageTs, name: LOADING_REACTION }).catch(() => {});

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
    job.senderUserId = senderUserId;
    job.senderName = senderName;
    const senderTeamRepos = senderTeam ? TEAM_REPOS[senderTeam] : null;
    const prompt = buildPrompt(threadContext, senderTeam, senderTeamRepos, mode);

    runGatebotSession({ prompt, token: job.token })
      .then(async () => {
        if (job.done) {
          await logTurn({
            ...logBase,
            sender_user_id: senderUserId,
            sender_name: senderName,
            classification: job.classification,
            gate_issues: job.gateIssues,
            latency_ms: Date.now() - startedAt,
            status: 'ok',
          });
          return;
        }
        // claude 프로세스는 정상 종료했지만 reply_to_slack 콜백이 오지 않은 경우 —
        // 조용한 무응답으로 남기지 않고 사용자에게 실패를 알리고, 로그에 no_reply로 구분해 남긴다.
        console.error('[planbot] session ended without reply callback', { thread_ts: threadTs });
        await app.client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text: '⚠️ 답변 생성에 실패했습니다 (탐색은 끝났지만 답변이 전송되지 않음). 같은 내용으로 다시 한번 시도해주세요.',
        }).catch(() => {});
        if (job.processingMessageTs) {
          await app.client.chat.delete({ channel, ts: job.processingMessageTs }).catch(() => {});
        }
        await app.client.reactions.remove({ channel, timestamp: triggerMessageTs, name: LOADING_REACTION }).catch(() => {});
        deleteJob(job.token);
        await logTurn({
          ...logBase,
          sender_user_id: senderUserId,
          sender_name: senderName,
          classification: job.classification,
          gate_issues: job.gateIssues,
          latency_ms: Date.now() - startedAt,
          status: 'no_reply',
          error: 'claude exited 0 but reply_to_slack callback never fired',
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
        await app.client.reactions.remove({ channel, timestamp: triggerMessageTs, name: LOADING_REACTION }).catch(() => {});
        deleteJob(job.token);
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

// 발신자가 본인 소속 팀을 스스로 등록한다. 이후 이 사람이 대상 제품을 명시하지 않고 질문하면
// (0번 상황분류 E) 이 팀을 힌트로 사용한다 — 클라이언트 쪽에 전체 인원 명단을 별도로 받을 필요가 없다.
// UX: `@planbot team` 멘션(DM에서는 멘션 없이 `team`) → 유저 메시지에 답글로 번호 매긴 팀 목록
//     → 사용자가 그 스레드에 번호로 답글 → 등록.
async function startTeamSelection(channel: string, userId: string, triggerTs: string): Promise<void> {
  const currentTeam = await getTeam(userId);
  const teams = TEAMS;
  const deregisterIndex = currentTeam ? teams.length + 1 : null;

  const lines = [
    `<@${userId}>님, 소속팀을 선택해주세요. 이 스레드에 번호로 답글을 달아주세요.`,
    ...teams.map((t, i) => `${i + 1}. ${t}`),
  ];
  if (deregisterIndex) {
    lines.push(`${deregisterIndex}. 지금 팀 해제 (현재 등록: ${currentTeam})`);
  }

  await app.client.chat.postMessage({ channel, thread_ts: triggerTs, text: lines.join('\n') });

  // 스레드 루트는 유저의 원본 멘션 메시지(triggerTs)다 — 이후 번호 답글도 같은 thread_ts로 온다.
  setPendingSelection(channel, triggerTs, { userId, teams, deregisterIndex });
}

/**
 * 대기 중인 Jira 댓글 등록 제안이 있고 이 메시지가 `등록`/`취소` 응답이면 소비한다.
 * `등록`/`취소`가 아닌 메시지는 소비하지 않고 일반 턴으로 흘려보낸다 (제안은 만료 전까지 대기 유지).
 * @returns 메시지를 소비했으면 true (다른 핸들링 금지)
 */
async function handleJiraProposalReply(
  channel: string,
  threadTs: string,
  userId: string | null,
  text: string,
): Promise<boolean> {
  const proposal = getProposal(channel, threadTs);
  if (!proposal) return false;

  const t = text.trim().toLowerCase();
  const isApprove = ['등록', 'ㅇㅋ', 'ok'].includes(t);
  const isCancel = ['취소', 'cancel'].includes(t);
  if (!isApprove && !isCancel) return false;

  const respond = (msg: string) =>
    app.client.chat.postMessage({ channel, thread_ts: threadTs, text: msg }).catch(() => {});

  if (proposal.requesterUserId && userId !== proposal.requesterUserId) {
    await respond(`이 제안은 요청자(<@${proposal.requesterUserId}>)만 승인/취소할 수 있습니다.`);
    return true;
  }

  clearProposal(channel, threadTs);

  if (isCancel) {
    await respond('Jira 댓글 등록을 취소했습니다.');
    return true;
  }

  const body = [
    '[기획 보완 — planbot 게이트 검토 후 확정]',
    '',
    proposal.comment,
    '',
    `(작성: ${proposal.requesterName ?? '알 수 없음'} · Slack에서 승인 후 planbot이 등록)`,
  ].join('\n');

  try {
    await addJiraComment(proposal.ticket, body);
    await respond(`✅ *${proposal.ticket}* 에 댓글을 등록했습니다.`);
  } catch (err) {
    console.error('[planbot] jira comment add failed', err);
    await respond(`⚠️ Jira 댓글 등록에 실패했습니다: ${String((err as Error)?.message ?? err)}`);
  }
  return true;
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

// 멘션됐을 때 — 응답하고, 조건에 따라 스레드를 "활성"으로 등록한다.
// 활성 등록은 **봇 멘션으로 시작된 스레드**(이 멘션이 곧 스레드 루트)일 때만 한다.
// 사람들끼리 대화하던 스레드에 도중 멘션된 경우엔 이번 턴만 답하고, 이후에도 멘션에만 반응한다
// — 안 그러면 그 스레드의 모든 후속 답글(사람 간 대화 포함)에 봇이 끼어들게 된다.
// 멘션 뒤 첫 단어가 `feedback`이면 피드백 전용 모드 (활성 스레드는 끝까지 고정, 비활성은 그 턴만).
// 첫 단어가 `team`이면 게이트봇 세션 없이 팀 등록 플로우로 바로 분기한다.
app.event('app_mention', async ({ event }) => {
  const channel = event.channel;
  if (channel.startsWith('D')) return; // 1:1 DM은 전용 message.im 핸들러가 처리 — 이중 응답 방지
  const isThreadRoot = !event.thread_ts || event.thread_ts === event.ts;
  const threadTs = event.thread_ts ?? event.ts;
  const triggerText = event.text ?? '';
  const botId = await getBotUserId();
  const command = detectMentionCommand(triggerText, botId);

  if (command === 'team') {
    if (event.user) await startTeamSelection(channel, event.user, event.ts);
    return;
  }

  // 대기 중인 Jira 댓글 제안에 대한 `@planbot 등록`/`@planbot 취소` 승인 응답 처리 (비활성 스레드용 경로)
  const strippedText = triggerText.replace(`<@${botId}>`, '').trim();
  if (await handleJiraProposalReply(channel, threadTs, event.user ?? null, strippedText)) return;

  await handleTurn({
    channel,
    threadTs,
    triggerMessageTs: event.ts,
    senderUserId: event.user ?? null,
    triggerText,
    initialMode: command === 'feedback' ? 'feedback' : 'qa',
    activateThread: isThreadRoot,
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

  // 대기 중인 Jira 댓글 제안에 대한 `등록`/`취소` 승인 응답 처리
  if (await handleJiraProposalReply(m.channel, m.thread_ts, m.user ?? null, m.text ?? '')) return;

  await handleTurn({
    channel: m.channel,
    threadTs: m.thread_ts,
    triggerMessageTs: m.ts,
    senderUserId: m.user ?? null,
    triggerText: m.text ?? '',
    initialMode: getThreadMode(m.channel, m.thread_ts), // 이미 활성 스레드이므로 기록된 mode를 그대로 넘긴다
    activateThread: false, // 이미 활성인 스레드에서만 도달하는 경로
  });
});

// 위 스레드에 번호로 답글이 오면 그 번호로 팀을 등록/해제한다. Q&A 흐름과는 별개 — 게이트봇 세션을 띄우지 않는다.
app.message(async ({ message }) => {
  const m = message as { subtype?: string; bot_id?: string; channel?: string; thread_ts?: string; ts?: string; text?: string; user?: string };
  if (m.subtype || m.bot_id || !m.channel || !m.thread_ts || !m.user) return;

  await applyTeamSelectionReply(m.channel, m.thread_ts, m.thread_ts, m.user, m.text ?? '');
});

// 1:1 DM — 멘션 없이 일반 메시지만 보내면 된다. Slack 앱에 `im:history` scope와
// `message.im` 이벤트 구독이 있어야 이 핸들러에 이벤트가 들어온다.
// 동작은 채널과 동일하다(멘션만 불필요): 최상위 메시지 하나가 세션 하나가 되고, 봇은 그 메시지에
// 답글(스레드)로 응답한다. 후속 질문은 그 스레드에 답글로 달면 기존 활성 스레드 핸들러가 이어받는다.
// 모드도 채널과 동일하게 스레드 단위로 고정된다 (첫 단어 `feedback` → 그 스레드는 끝까지 피드백 모드).
app.message(async ({ message }) => {
  const m = message as { subtype?: string; bot_id?: string; channel?: string; channel_type?: string; thread_ts?: string; ts?: string; text?: string; user?: string };
  if (m.subtype || m.bot_id || !m.channel || !m.ts) return;
  if (m.channel_type !== 'im') return;
  if (m.thread_ts) return; // DM 안 스레드 답글은 위의 활성 스레드/팀 선택 핸들러가 처리한다

  const botId = await getBotUserId();
  // DM에서도 습관적으로 멘션을 붙일 수 있으므로 제거하고 커맨드를 판별한다.
  const stripped = (m.text ?? '').replace(`<@${botId}>`, '').trim();
  const firstWord = (stripped.split(/\s+/)[0] ?? '').toLowerCase();

  if (firstWord === 'team') {
    if (m.user) await startTeamSelection(m.channel, m.user, m.ts);
    return;
  }

  await handleTurn({
    channel: m.channel,
    threadTs: m.ts, // 이 메시지가 스레드 루트 — 답변·처리중 표시 모두 답글로 달린다
    triggerMessageTs: m.ts,
    senderUserId: m.user ?? null,
    triggerText: m.text ?? '',
    initialMode: firstWord === 'feedback' ? 'feedback' : 'qa',
    activateThread: true, // DM은 항상 봇과의 대화이므로 봇 루트 스레드와 동일하게 취급
  });
});

const CALLBACK_PORT = Number(process.env['CALLBACK_PORT'] ?? 8788);
startCallbackServer(app.client as unknown as import('@slack/web-api').WebClient, CALLBACK_PORT);

await app.start();
await getBotUserId();
console.log('[planbot] Slack Socket Mode app started');
