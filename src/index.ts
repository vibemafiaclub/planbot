import 'dotenv/config';
import { rm } from 'node:fs/promises';
import pkg from '@slack/bolt';
const { App } = pkg;
import type { WebClient } from '@slack/web-api';
import { createJob, deleteJob, LOADING_REACTION } from './job-store.js';
import {
  runGatebotSession,
  REPO_ROOT,
  PLANBOT_ROOT,
  DEFAULT_ALLOWED_TOOLS,
  SEARCH_ALLOWED_TOOLS,
  devAllowedTools,
} from './claude-runner.js';
import { startCallbackServer } from './callback-server.js';
import { buildPrompt, buildDevPrompt, buildSearchPrompt } from './system-prompt.js';
import { downloadSlackFiles, type SlackFileRef } from './attachment-fetch.js';
import {
  loadThreadStates,
  ensureThread,
  isUserActive,
  activateUser,
  deactivateUser,
  getThreadMode,
  nextTurnIndex,
  type ThreadMode,
} from './thread-store.js';
import { logTurn } from './logger.js';
import { getTeam, setTeam, clearTeam, TEAMS, TEAM_REPOS } from './team-registry.js';
import { getProposal, clearProposal, addJiraComment } from './jira-comment.js';
import { setPendingSelection, getPendingSelection, clearPendingSelection } from './team-selection-store.js';
import { collectSearchCandidates, candidatesToJsonl } from './search-log.js';
import { snapshotRepo, diffSnapshots, classifyChanges, type RepoSnapshot } from './dev-changes.js';

const PROCESSING_TEXT = '(기획봇이 요청을 처리중입니다. 잠시만 기다려주세요.)';
const HOLD_TEXT = '(앞선 요청을 처리 중입니다 — 이 메시지는 보류됐다가 잠시 후 이어서 함께 처리됩니다.)';

/** dev 커맨드(봇 자체 수정)를 쓸 수 있는 관리자 Slack user ID 목록. 비어 있으면 dev는 전면 비활성. */
const DEV_ALLOWED_USER_IDS = new Set(
  (process.env['DEV_ALLOWED_USER_IDS'] ?? '').split(',').map((s) => s.trim()).filter(Boolean),
);

function isDevUser(userId?: string | null): boolean {
  return Boolean(userId) && DEV_ALLOWED_USER_IDS.has(userId!);
}

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

type MentionCommand = 'feedback' | 'team' | 'dev' | 'search' | 'help';
const MENTION_COMMANDS: readonly MentionCommand[] = ['feedback', 'team', 'dev', 'search', 'help'];

/**
 * 멘션 뒤 첫 단어로 커맨드를 판별한다.
 * - `feedback`: 그 스레드는 끝까지 피드백 전용 모드로 고정된다 (thread-store.ts가 최초 1회만 mode를 기록).
 * - `team`: 게이트봇 세션을 띄우지 않는 팀 등록 플로우로 분기된다.
 * - `dev`: 관리자 전용 — planbot 자체(지침·코드)를 수정하는 세션. 스레드가 dev 모드로 고정된다.
 * - `search`: 과거 질의 기록 검색 (공개 채널 질의만 대상).
 * - `help`: 사용법 안내 (세션 없이 즉시 응답).
 * - 그 외: 일반 Q&A.
 */
function detectMentionCommand(triggerText: string, botUserId: string): MentionCommand | null {
  const stripped = triggerText.replace(`<@${botUserId}>`, '').trim();
  const firstWord = (stripped.split(/\s+/)[0] ?? '').toLowerCase();
  return (MENTION_COMMANDS as readonly string[]).includes(firstWord) ? (firstWord as MentionCommand) : null;
}

/**
 * planbot이 아닌 다른 사용자·봇·그룹(@here/@channel 포함)을 멘션한 메시지인가.
 * 자동 반응 해제 판정에 쓴다 — 이런 메시지는 봇이 아니라 사람에게 하는 말이라고 본다.
 */
function mentionsOthers(text: string, botId: string): boolean {
  for (const m of text.matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)) {
    if (m[1] !== botId) return true;
  }
  return /<!subteam\^/.test(text) || /<!(here|channel|everyone)[|>]/.test(text);
}

async function postHelp(channel: string, threadTs: string, userId?: string | null): Promise<void> {
  const lines = [
    '*planbot 사용법*',
    '• `@planbot <질문>` — 구현 가능성·공수 질의. 봇이 답한 뒤에는 같은 스레드에서 재멘션 없이 답글만 달아도 대화가 이어집니다.',
    '• `@planbot feedback <기획 내용 또는 티켓번호>` — 기획 자료 품질 평가 전용 (구현 가능성/공수는 답하지 않음).',
    '• `@planbot team` — 소속팀 등록/해제 (제품을 명시하지 않은 질문에 힌트로 사용됨).',
    '• `@planbot search <검색어>` — 과거 질의 기록 검색. 공개 채널에서 접수된 질의만 대상이며 관련도순 최대 10건.',
    '• `@planbot help` — 이 도움말.',
    '',
    '_DM에서는 멘션 없이 첫 단어만으로 동일하게 사용할 수 있습니다._',
    '_자동 응답은 내가 다른 사람(또는 봇, @here 등)을 멘션하면 꺼지고, planbot을 다시 멘션하면 켜집니다. 24시간 활동이 없어도 재멘션이 필요합니다._',
  ];
  if (isDevUser(userId)) {
    lines.splice(6, 0, '• `@planbot dev <요구사항>` — (관리자 전용) planbot 지침·코드 수정. 지침 변경은 즉시, 코드 변경은 재시동 후 반영.');
  }
  await app.client.chat.postMessage({ channel, thread_ts: threadTs, text: lines.join('\n') }).catch(() => {});
}

type TurnRunMode = 'qa' | 'feedback' | 'dev' | 'search';

interface TurnOpts {
  channel: string;
  threadTs: string;
  triggerMessageTs: string;
  senderUserId: string | null;
  triggerText: string;
  mode: TurnRunMode;
  searchQuery?: string;
}

// ---- 스레드당 세션 1개 제한 + 보류 큐 ----
// 세션이 도는 동안 같은 스레드에 새 메시지가 오면 즉시 세션을 또 띄우지 않고 보류한다.
// 보류 사실은 안내 메시지로 알리고, 앞 세션이 끝나면 안내 메시지를 지운 뒤 마지막 메시지 기준으로
// 한 턴만 돌린다 (스레드 전체를 다시 읽으므로 보류된 메시지들 내용은 모두 포함된다).

interface QueuedTurn {
  opts: TurnOpts;
  holdMessageTs: string | null;
}

const runningThreads = new Set<string>();
const pendingTurns = new Map<string, QueuedTurn[]>();

async function requestTurn(opts: TurnOpts): Promise<void> {
  const key = `${opts.channel}:${opts.threadTs}`;
  if (runningThreads.has(key)) {
    const hold = await app.client.chat.postMessage({
      channel: opts.channel,
      thread_ts: opts.threadTs,
      text: HOLD_TEXT,
    }).catch(() => null);
    const list = pendingTurns.get(key) ?? [];
    list.push({ opts, holdMessageTs: hold?.ts ?? null });
    pendingTurns.set(key, list);
    return;
  }

  runningThreads.add(key);
  await handleTurn(opts, async () => {
    runningThreads.delete(key);
    const queued = pendingTurns.get(key) ?? [];
    pendingTurns.delete(key);
    if (queued.length === 0) return;
    for (const q of queued) {
      if (q.holdMessageTs) {
        await app.client.chat.delete({ channel: opts.channel, ts: q.holdMessageTs }).catch(() => {});
      }
    }
    const last = queued[queued.length - 1]!;
    await requestTurn(last.opts);
  });
}

/**
 * 턴 하나를 처리한다. 세션은 비동기로 돌고 이 함수는 곧 반환된다 — 세션이 어떤 경로로든 끝났을 때
 * onSettled가 정확히 1회 호출된다 (보류 큐 해제용).
 */
async function handleTurn(opts: TurnOpts, onSettled: () => Promise<void>): Promise<void> {
  const { channel, threadTs, triggerMessageTs, senderUserId, triggerText, mode } = opts;
  const turnIndex = nextTurnIndex(channel, threadTs);
  const startedAt = Date.now();
  let settled = false;
  const settle = async () => {
    if (settled) return;
    settled = true;
    await onSettled().catch((err) => console.error('[planbot] onSettled error', err));
  };

  const logBase = {
    ts: new Date(startedAt).toISOString(),
    channel,
    thread_ts: threadTs,
    trigger_ts: triggerMessageTs,
    turn_index: turnIndex,
    question_text: triggerText,
    mode,
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

    const senderName = senderUserId ? await resolveUserName(senderUserId) : null;
    job.senderUserId = senderUserId;
    job.senderName = senderName;

    // 모드별 프롬프트·도구·실행 위치 구성
    let prompt: string;
    let allowedTools: string[] = DEFAULT_ALLOWED_TOOLS;
    let cwd: string | undefined;
    let addDirs: string[] | undefined;
    let filesTmpDir: string | null = null;
    let devSnapshot: RepoSnapshot | null = null;

    if (mode === 'search') {
      const candidates = await collectSearchCandidates(app.client as unknown as WebClient);
      if (candidates.length === 0) {
        await app.client.chat.postMessage({
          channel,
          thread_ts: threadTs,
          text: '검색 대상이 되는 과거 질의 기록이 아직 없습니다 (공개 채널에서 접수된 질의만 대상입니다).',
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
          classification: 'S',
          gate_issues: [],
          latency_ms: Date.now() - startedAt,
          status: 'ok',
        });
        await settle();
        return;
      }
      prompt = await buildSearchPrompt(opts.searchQuery ?? '', candidatesToJsonl(candidates));
      allowedTools = SEARCH_ALLOWED_TOOLS;
    } else if (mode === 'dev') {
      const ctx = await buildThreadContext(channel, threadTs);
      filesTmpDir = ctx.filesTmpDir;
      prompt = await buildDevPrompt(ctx.text, PLANBOT_ROOT, REPO_ROOT);
      allowedTools = devAllowedTools();
      cwd = PLANBOT_ROOT;
      addDirs = [REPO_ROOT];
      devSnapshot = await snapshotRepo(PLANBOT_ROOT);
    } else {
      const [ctx, senderTeam] = await Promise.all([
        buildThreadContext(channel, threadTs),
        senderUserId ? getTeam(senderUserId) : Promise.resolve(null),
      ]);
      filesTmpDir = ctx.filesTmpDir;
      const senderTeamRepos = senderTeam ? TEAM_REPOS[senderTeam] : null;
      prompt = await buildPrompt(ctx.text, senderTeam, senderTeamRepos, mode);
    }

    runGatebotSession({ prompt, token: job.token, allowedTools, cwd, addDirs })
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
        // dev 세션이 런타임 코드를 건드렸으면 재시동이 필요하다는 사실을 요청자에게 알린다.
        // 봇이 스스로 재시동하지는 않는다 — 진행 중인 다른 스레드 상태를 죽이지 않기 위함.
        if (mode === 'dev' && devSnapshot) {
          try {
            const after = await snapshotRepo(PLANBOT_ROOT);
            const changed = await diffSnapshots(PLANBOT_ROOT, devSnapshot, after);
            const { runtime, immediate } = classifyChanges(changed);
            const who = senderUserId ? `<@${senderUserId}> ` : '';
            if (runtime.length > 0) {
              await app.client.chat.postMessage({
                channel,
                thread_ts: threadTs,
                text: `${who}⚙️ 이번 dev 세션에서 런타임 코드가 변경됐습니다 (${runtime.join(', ')}). ` +
                  '원격 PC에서 `npm run build` 후 봇 프로세스를 재시동해야 반영됩니다.',
              }).catch(() => {});
            } else if (immediate.length > 0) {
              await app.client.chat.postMessage({
                channel,
                thread_ts: threadTs,
                text: `📝 지침/문서 변경(${immediate.join(', ')})은 다음 질의부터 즉시 반영됩니다 (재시동 불필요).`,
              }).catch(() => {});
            }
          } catch (err) {
            console.error('[planbot] dev change detection failed', err);
          }
        }
        await settle();
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
    await settle();
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

// 멘션됐을 때 — 응답하고, 멘션한 **그 사용자**의 자동 반응(재멘션 불필요)을 켠다.
// 스레드 루트 멘션이든 사람들끼리 대화하던 스레드 도중 멘션이든 동일하다 — 단 자동 반응은
// 멘션한 본인의 답글에만 적용되므로, 같은 스레드의 다른 사람 대화에 봇이 끼어들지 않는다.
// 멘션 메시지에 다른 사용자/봇/@here 등이 함께 멘션돼 있으면 이번 턴만 답하고 자동 반응은 켜지 않는다.
app.event('app_mention', async ({ event }) => {
  const channel = event.channel;
  if (channel.startsWith('D')) return; // 1:1 DM은 전용 message.im 핸들러가 처리 — 이중 응답 방지
  const threadTs = event.thread_ts ?? event.ts;
  const triggerText = event.text ?? '';
  const botId = await getBotUserId();
  const command = detectMentionCommand(triggerText, botId);
  const strippedText = triggerText.replace(`<@${botId}>`, '').trim();

  if (command === 'team') {
    if (event.user) await startTeamSelection(channel, event.user, event.ts);
    return;
  }
  if (command === 'help') {
    await postHelp(channel, threadTs, event.user ?? null);
    return;
  }

  // 대기 중인 Jira 댓글 제안에 대한 `@planbot 등록`/`@planbot 취소` 승인 응답 처리
  if (await handleJiraProposalReply(channel, threadTs, event.user ?? null, strippedText)) return;

  if (command === 'search') {
    const query = strippedText.replace(/^search\s*/i, '').trim();
    if (!query) {
      await app.client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: '검색어를 함께 적어주세요. 예: `@planbot search 재고 연동`',
      }).catch(() => {});
      return;
    }
    await requestTurn({
      channel,
      threadTs,
      triggerMessageTs: event.ts,
      senderUserId: event.user ?? null,
      triggerText,
      mode: 'search',
      searchQuery: query,
    });
    return;
  }

  if (command === 'dev') {
    if (!isDevUser(event.user)) {
      await app.client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: '`dev` 커맨드는 등록된 관리자만 사용할 수 있습니다.',
      }).catch(() => {});
      return;
    }
    if (!strippedText.replace(/^dev\s*/i, '').trim() && getThreadMode(channel, threadTs) !== 'dev') {
      await app.client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: '`dev` 뒤에 요구사항을 함께 적어주세요. 예: `@planbot dev 게이트 렌즈 설명을 더 구체적으로 다듬어줘`',
      }).catch(() => {});
      return;
    }
  }

  const initialMode: ThreadMode = command === 'feedback' ? 'feedback' : command === 'dev' ? 'dev' : 'qa';
  ensureThread(channel, threadTs, initialMode, false);
  const turnMode: TurnRunMode =
    command === 'dev' ? 'dev' : command === 'feedback' ? 'feedback' : getThreadMode(channel, threadTs);

  // dev 모드로 고정된 스레드에 관리자가 아닌 사람이 멘션으로 참여하는 경우는 막는다
  if (turnMode === 'dev' && !isDevUser(event.user)) {
    await app.client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: '이 스레드는 관리자 전용 dev 스레드입니다.',
    }).catch(() => {});
    return;
  }

  if (event.user) {
    if (mentionsOthers(triggerText, botId)) deactivateUser(channel, threadTs, event.user);
    else activateUser(channel, threadTs, event.user);
  }

  await requestTurn({
    channel,
    threadTs,
    triggerMessageTs: event.ts,
    senderUserId: event.user ?? null,
    triggerText,
    mode: turnMode,
  });
});

// 채널 스레드 안의 재멘션 없는 답글 — 그 답글을 쓴 사용자의 자동 반응이 켜져 있을 때만 다음 턴으로 이어간다.
// 다른 사용자/봇을 멘션한 답글은 사람에게 하는 말로 보고, 그 사용자의 자동 반응을 끈 뒤 반응하지 않는다.
app.message(async ({ message }) => {
  const m = message as { subtype?: string; bot_id?: string; channel?: string; channel_type?: string; thread_ts?: string; ts?: string; text?: string; user?: string };
  if (m.subtype || m.bot_id) return; // 봇 자신의 메시지·시스템 메시지는 무시
  if (!m.channel || !m.thread_ts || !m.ts || !m.user) return; // 스레드 답글이 아니면 무시
  if (m.channel_type === 'im') return; // DM 스레드 답글은 전용 핸들러가 처리

  const botId = await getBotUserId();
  if (m.text?.includes(`<@${botId}>`)) return; // 멘션 포함 메시지는 app_mention 핸들러가 이미 처리함
  if (getPendingSelection(m.channel, m.thread_ts)) return; // 팀 선택 스레드는 번호 답글 핸들러가 소비

  // 대기 중인 Jira 댓글 제안에 대한 `등록`/`취소` 승인 응답 처리
  if (await handleJiraProposalReply(m.channel, m.thread_ts, m.user, m.text ?? '')) return;

  if (!isUserActive(m.channel, m.thread_ts, m.user)) return;
  if (mentionsOthers(m.text ?? '', botId)) {
    // 다른 사람을 멘션했다 = 봇이 아니라 사람과 대화를 시작했다. 이 메시지부터 자동 반응 종료.
    deactivateUser(m.channel, m.thread_ts, m.user);
    return;
  }

  const turnMode = getThreadMode(m.channel, m.thread_ts);
  if (turnMode === 'dev' && !isDevUser(m.user)) return;
  activateUser(m.channel, m.thread_ts, m.user);

  await requestTurn({
    channel: m.channel,
    threadTs: m.thread_ts,
    triggerMessageTs: m.ts,
    senderUserId: m.user,
    triggerText: m.text ?? '',
    mode: turnMode,
  });
});

// 팀 선택 스레드에 번호로 답글이 오면 그 번호로 팀을 등록/해제한다. Q&A 흐름과는 별개 — 게이트봇 세션을 띄우지 않는다.
app.message(async ({ message }) => {
  const m = message as { subtype?: string; bot_id?: string; channel?: string; thread_ts?: string; ts?: string; text?: string; user?: string };
  if (m.subtype || m.bot_id || !m.channel || !m.thread_ts || !m.user) return;

  await applyTeamSelectionReply(m.channel, m.thread_ts, m.thread_ts, m.user, m.text ?? '');
});

// 1:1 DM 최상위 메시지 — 멘션 없이 일반 메시지만 보내면 된다. Slack 앱에 `im:history` scope와
// `message.im` 이벤트 구독이 있어야 이 핸들러에 이벤트가 들어온다.
// 동작은 채널과 동일하다(멘션만 불필요): 최상위 메시지 하나가 세션 하나가 되고, 봇은 그 메시지에
// 답글(스레드)로 응답한다. 후속 질문은 그 스레드에 답글로 달면 아래 DM 스레드 핸들러가 이어받는다.
// 모드도 채널과 동일하게 스레드 단위로 고정된다 (첫 단어 `feedback`/`dev` → 그 스레드는 끝까지 해당 모드).
app.message(async ({ message }) => {
  const m = message as { subtype?: string; bot_id?: string; channel?: string; channel_type?: string; thread_ts?: string; ts?: string; text?: string; user?: string };
  if (m.subtype || m.bot_id || !m.channel || !m.ts) return;
  if (m.channel_type !== 'im') return;
  if (m.thread_ts) return; // DM 안 스레드 답글은 아래 전용 핸들러가 처리한다

  const botId = await getBotUserId();
  // DM에서도 습관적으로 멘션을 붙일 수 있으므로 제거하고 커맨드를 판별한다.
  const stripped = (m.text ?? '').replace(`<@${botId}>`, '').trim();
  const firstWord = (stripped.split(/\s+/)[0] ?? '').toLowerCase();

  if (firstWord === 'team') {
    if (m.user) await startTeamSelection(m.channel, m.user, m.ts);
    return;
  }
  if (firstWord === 'help') {
    await postHelp(m.channel, m.ts, m.user ?? null);
    return;
  }
  if (firstWord === 'search') {
    const query = stripped.replace(/^search\s*/i, '').trim();
    if (!query) {
      await app.client.chat.postMessage({
        channel: m.channel,
        thread_ts: m.ts,
        text: '검색어를 함께 적어주세요. 예: `search 재고 연동`',
      }).catch(() => {});
      return;
    }
    await requestTurn({
      channel: m.channel,
      threadTs: m.ts,
      triggerMessageTs: m.ts,
      senderUserId: m.user ?? null,
      triggerText: m.text ?? '',
      mode: 'search',
      searchQuery: query,
    });
    return;
  }
  if (firstWord === 'dev') {
    if (!isDevUser(m.user)) {
      await app.client.chat.postMessage({
        channel: m.channel,
        thread_ts: m.ts,
        text: '`dev` 커맨드는 등록된 관리자만 사용할 수 있습니다.',
      }).catch(() => {});
      return;
    }
    if (!stripped.replace(/^dev\s*/i, '').trim()) {
      await app.client.chat.postMessage({
        channel: m.channel,
        thread_ts: m.ts,
        text: '`dev` 뒤에 요구사항을 함께 적어주세요. 예: `dev 게이트 렌즈 설명을 더 구체적으로 다듬어줘`',
      }).catch(() => {});
      return;
    }
  }

  const initialMode: ThreadMode = firstWord === 'feedback' ? 'feedback' : firstWord === 'dev' ? 'dev' : 'qa';
  ensureThread(m.channel, m.ts, initialMode, true); // DM은 항상 봇과의 대화 — 스레드 전체가 자동 반응 대상
  await requestTurn({
    channel: m.channel,
    threadTs: m.ts, // 이 메시지가 스레드 루트 — 답변·처리중 표시 모두 답글로 달린다
    triggerMessageTs: m.ts,
    senderUserId: m.user ?? null,
    triggerText: m.text ?? '',
    mode: initialMode,
  });
});

// 1:1 DM 스레드 답글 — DM은 항상 봇과의 대화이므로 멘션 여부와 무관하게 이어간다.
app.message(async ({ message }) => {
  const m = message as { subtype?: string; bot_id?: string; channel?: string; channel_type?: string; thread_ts?: string; ts?: string; text?: string; user?: string };
  if (m.subtype || m.bot_id || !m.channel || !m.thread_ts || !m.ts || !m.user) return;
  if (m.channel_type !== 'im') return;

  if (getPendingSelection(m.channel, m.thread_ts)) return; // 팀 선택 번호 답글은 전용 핸들러가 소비
  if (await handleJiraProposalReply(m.channel, m.thread_ts, m.user, m.text ?? '')) return;
  if (!isUserActive(m.channel, m.thread_ts, m.user)) return; // 재시동 이전에 시작된 미복구 스레드 등

  const turnMode = getThreadMode(m.channel, m.thread_ts);
  if (turnMode === 'dev' && !isDevUser(m.user)) return;

  await requestTurn({
    channel: m.channel,
    threadTs: m.thread_ts,
    triggerMessageTs: m.ts,
    senderUserId: m.user,
    triggerText: m.text ?? '',
    mode: turnMode,
  });
});

const CALLBACK_PORT = Number(process.env['CALLBACK_PORT'] ?? 8788);
startCallbackServer(app.client as unknown as import('@slack/web-api').WebClient, CALLBACK_PORT);

await loadThreadStates(); // 재시동해도 진행 중이던 스레드 대화(자동 반응·모드)가 이어지도록 복구
await app.start();
await getBotUserId();
console.log('[planbot] Slack Socket Mode app started');
