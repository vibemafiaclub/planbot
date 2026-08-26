# planbot

기획서 품질 게이트봇.

기획자·영업 등 비개발직군이 슬랙에서 봇을 멘션하면, 로컬(원격 PC)에서 구동 중인 claude code가
레포들을 탐색해 구현 가능성·공수를 답해준다. 개발팀에게 직접 묻지 않아도 되는 창구가 목적.

단순 질의응답 창구에 그치지 않고 **기획서 품질 게이트** 역할도 겸한다. 질문에 실제 기획 내용(스펙 원고,
화면 설명, 정책 조건)이 섞여 있으면 구현 가능성을 바로 답하지 않고, 구조화 부족·과도한 용량·텍스트의
이미지 전달·자체 어휘 사용·UI 위치 특정 실패·AS-IS/TO-BE 미명시·검색 가능한 앵커 부재 7개 렌즈로 먼저
스캔해 결여된 부분을 짚어준다. 논리적으로 상상 가능한 모든 엣지케이스를 캐묻지 않는다 — 코드베이스를
이해하고 있다면 유추 가능한 내용은 결여로 치지 않고, 전달 형식·정밀도·추적가능성 문제만 짚는다.
상황별 대응 지침(순수 질문/기획 원고 포함/지라 티켓 번호만 제시/질문이 너무 광범위함/대상 제품 불특정)은
`src/system-prompt.ts`에 정의돼 있다.

**`@planbot feedback <기획내용>`**: 구현 가능성/공수 판단 없이 위 7개 렌즈로만 자료 품질을 평가하는
전용 모드. 멘션 뒤 첫 단어가 `feedback`이면 코드 레벨(`index.ts`의 `detectMentionCommand`)에서 결정론적으로
트리거되고, 그 스레드는 이후 재멘션 없이 이어지는 답글까지 끝까지 이 모드로 고정된다(`thread-store.ts`).
답변은 자유 서술형이되 맨 앞줄에 **판정: PASS(개발 착수 가능)** 또는 **판정: 명확화 필요**를 명시하고,
걸린 렌즈마다 자료를 어떻게 고치면 되는지 구체적 개선 방법을 함께 준다. 어휘 일치 판단은 별도 용어집을
만들지 않고, 원고의 개념어를 그때그때 레포에서 grep해 확인하는 방식이다. 개선 방법은 기획자가 개발자
도움 없이 실행할 수 있는 수준으로 제시하고(컬럼명·엔드포인트를 적으라는 식의 요구 금지), 답변에서
파일 경로·렌즈 영문 id·사내 내부 용어를 노출하지 않는 비개발직군 친화 스타일을 강제한다.
지라 티켓 번호만 제시되면 `jira issue view`로 원문을 먼저 확보해 평가하고, 확보 실패 시 되묻는다.

## 1:1 DM 사용

채널 멘션 외에 **봇과의 1:1 DM**으로도 쓸 수 있다 (Slack 앱에 `im:history` scope + `message.im`
이벤트 구독 필요 — 아래 준비물 참조). 동작은 채널과 동일하고, **멘션만 불필요**하다:

- **일반 메시지 하나 = 세션 하나**: DM에 그냥 질문을 보내면 봇이 그 메시지에 **답글(스레드)**로 응답한다.
- **후속 질문은 그 스레드에 답글로**: 채널과 똑같이 재멘션 없이 답글만 달면 맥락이 이어진다.
  새 주제는 새 최상위 메시지로 시작하면 된다.
- **모드는 스레드 단위**: 첫 단어가 `feedback`이면 그 스레드는 끝까지 피드백 모드로 고정된다 (채널과 동일).
- **`team` 커맨드**: 멘션 없이 `team`이라고 보내면 답글로 번호 목록이 오고, 그 스레드에 번호로 답글을
  달면 등록/해제된다.
- **유의**: DM 문답은 다른 팀원에게 공유되지 않는다. 조직 내 지식 공유가 목적이면 공개 채널 사용을 권장.

## 아키텍처

```
슬랙 멘션 (app_mention) — 또는 이미 활성화된 스레드 안의 답글(재멘션 불필요)
  → :loading: 반응 + "처리중" 스레드 메시지
  → 스레드 전체 히스토리(텍스트/첨부/반응/작성자) 수집 + 첨부파일 실제 다운로드
  → claude code headless 실행 (claude -p), REPO_ROOT를 cwd로 레포들 탐색
     └─ MCP 서버(planbot) 연동: claude가 답변 확정 시 reply_to_slack 툴 호출
  → MCP 서버가 로컬 콜백 서버(HTTP)에 POST → 콜백 서버가 실제 슬랙 전송 수행
  → "처리중" 메시지 삭제 + :loading: 반응 제거 (성공/실패/무응답 모든 종료 경로에서 제거)
```

프로세스가 3개로 나뉘어 있다:
- `index.ts` (메인): Slack Socket Mode 봇 + 콜백 HTTP 서버, claude 프로세스를 spawn
- `claude-runner.ts`: claude를 headless(`--print`)로 실행하면서 임시 MCP 설정 파일을 만들어 연결
- `mcp-server.ts`: claude 프로세스가 stdio로 붙는 별도 MCP 서버. `reply_to_slack` 툴 하나만 노출하고,
  호출되면 메인 프로세스의 콜백 서버(`http://127.0.0.1:PORT/reply/<job-token>`)로 HTTP POST

job-token으로 세션을 구분하므로 동시에 여러 스레드에서 멘션이 와도 안전하다.

**멀티턴**: `thread-store.ts`가 **봇 멘션으로 시작된 스레드**(루트 메시지가 멘션)와 DM 세션만
"활성"으로 기억한다. 활성 스레드에서는 사람이 재멘션 없이 답글만 달아도(`message` 이벤트, 봇 자신의
메시지는 필터링) 다음 턴으로 이어간다. 반면 **사람들끼리 대화하던 스레드에 도중 멘션된 경우**엔 그
턴만 답하고 활성으로 등록하지 않는다 — 이후에도 멘션한 메시지에만 반응하므로, 사람 간 후속 대화에
봇이 끼어들지 않는다 (맥락은 매 멘션마다 스레드 전체를 다시 읽으므로 유지된다).
매 턴 `conversations.replies`로 스레드 전체를 다시 읽어 프롬프트에 넣으므로, claude 프로세스 자체는
매번 새로 뜨는 헤드리스 세션이어도 이전 턴 맥락은 항상 포함된다.

**첨부파일**: `attachment-fetch.ts`가 스레드의 첨부파일을 실제로 다운로드해(20MB 상한) 임시 디렉터리에
저장하고, 프롬프트에 로컬 절대경로를 남긴다. claude는 `--allowedTools`에 Read가 포함돼 있으므로
그 경로를 Read 툴로 직접 열어 내용을 확인할 수 있다 — 기획서가 텍스트가 아니라 PDF/이미지로 첨부돼도
게이트 체크 대상이 된다. 다운로드한 임시 파일은 세션 종료 후 정리된다.

**도구 범위**: 슬랙 스레드 텍스트·첨부가 그대로 프롬프트에 들어가 프롬프트 인젝션에 노출돼 있으므로,
`--dangerously-skip-permissions` 대신 `--allowedTools`로 `Read`/`Grep`/`Glob`/`Bash(jira issue view:*)`/
`mcp__planbot__reply_to_slack`만 허용한다. Write·Edit·임의 Bash 명령은 막혀 있어 claude가 레포에
쓰기를 하거나 임의 명령을 실행할 수 없다 — 답변 생성 외의 부작용이 구조적으로 불가능하다.
지라 조회는 [jira-cli](https://github.com/ankitpokhrel/jira-cli)(`jira issue view <TICKET-ID>`)가
원격 PC에 설치·인증돼 있어야 동작한다.

**로그**: `logger.ts`가 턴 하나당 JSONL 한 줄을 `logs/turns-YYYY-MM-DD.jsonl`에 append한다
(발신자·질문 원문·지연시간·성공여부). 이 봇의 하네스(시스템 프롬프트) 개선 인사이트를 뽑는 용도.
실제 기획 내용이 담기므로 `logs/`는 `.gitignore` 대상이며 절대 커밋하지 않는다.

**팀 등록(`@planbot team`)**: 멘션 뒤 첫 단어가 `team`이면 게이트봇 세션 없이 번호 선택 플로우로 바로 분기한다.
1. `@planbot team`만 멘션(추가 텍스트 없이)
2. 봇이 새 스레드를 열어 선택 가능한 팀을 번호 목록으로 안내 (이미 등록된 사용자면 마지막 번호로
   "지금 팀 해제"가 추가됨)
3. 사용자가 그 스레드에 번호로 답글
4. 해당 번호의 팀으로 등록(또는 해제)

`team-selection-store.ts`가 (channel, thread_ts) → 대기 중인 선택지를 기억하고, 멘션을 보낸 본인의
응답만 받는다. 이 흐름은 게이트봇 Q&A 세션(claude headless 실행)을 전혀 띄우지 않는
가벼운 별도 경로다. 등록된 팀은 이후 대상 제품을 명시하지 않은 질문(상황분류 E)에서 힌트로
참고되며, `team-registry.ts`의 `TEAM_REPOS`로 담당 레포까지 탐색 우선순위 힌트로 넘어간다 —
단, 메시지에 다른 제품/레포가 명시돼 있으면 그게 항상 우선이고, 힌트로 유추했을 땐 반드시 답변에
"OO팀 기준으로 답했다"고 밝힌다. `TEAMS`·`TEAM_REPOS`는 클라이언트 조직 고유 정보라 이 repo에는
placeholder로만 유지하고, 실 배포 시 실제 값으로 교체한다. 사용자가 등록한 실제 매핑
(`data/team-registry.json`)은 `data/`와 함께 gitignore 대상이라 커밋되지 않는다.

## 준비물

### 1. Slack App 설정

**OAuth Scopes (Bot Token Scopes)**
- `app_mentions:read` — 멘션 이벤트 수신
- `chat:write` — 메시지 전송
- `reactions:write` — 처리중 :loading: 반응 추가/제거 (**워크스페이스에 `loading` 커스텀 이모지 등록 필요**,
  이름은 `.env`의 `LOADING_REACTION`으로 변경 가능 — 미등록이면 반응 없이 조용히 넘어감)
- `files:write` — 첨부파일 전송 (`filesUploadV2`)
- `files:read` — 첨부파일 다운로드(`url_private`) — 없으면 기획서 PDF/이미지 첨부를 못 읽음
- `channels:history` (+ private 채널도 쓸 경우 `groups:history`) — 스레드 히스토리 조회
- `im:history` — 1:1 DM 히스토리 조회 (DM 지원 시 필수)
- `users:read` — 작성자 이름 조회

**Event Subscriptions**
- Bot Events에 `app_mention` 추가
- **멀티턴(재멘션 없는 후속 답글) 지원을 위해 `message.channels` (private 채널도 쓸 경우 `message.groups`)도 추가 필요**
  — 이게 없으면 최초 멘션 이후 스레드 답글에 반응하지 못하고 매번 재멘션해야 함
- **1:1 DM 지원을 위해 `message.im`도 추가 필요** — 이게 없으면 DM 메시지가 봇에 아예 전달되지 않음
- App Home 탭에서 **"Allow users to send Slash commands and messages from the messages tab"** 활성화
  — 이게 꺼져 있으면 사용자가 봇 DM에 메시지 입력창 자체가 안 뜸

**Socket Mode**
- 활성화 + App-Level Token 발급 (`connections:write` scope 포함, `xapp-...`)

발급된 토큰 3개(`SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_SIGNING_SECRET`)를 `.env`에 채워야 함.

### 2. 실행 환경 (Windows/VDI 등 원격 PC 포함)

- Node.js 20+ 설치
- `claude` CLI 설치 + 로그인 완료, `claude --version` 정상 동작 확인
  - PATH에 안 잡히면 `.env`의 `CLAUDE_BIN`에 `claude.cmd` 절대경로 지정
- **레포 clone**: `REPO_ROOT` 아래에 봇이 탐색할 레포 전부를 clone
  - 각 레포에 `.claude/` 하네스가 배포된 상태여야 claude가 프로젝트 컨벤션을 참고해 답할 수 있음

## 로컬 실행

```
npm install
cp .env.example .env   # 토큰·경로 채우기
npm run build
npm start
```

## 미검증 항목

- [ ] Windows에서 `spawn('claude', [...])`가 PATH의 `claude.cmd` 래퍼를 `shell:false`로도 정상 실행하는지
      (안 되면 실제 실행 파일 경로를 찾아 넘기는 보정이 필요)
- [x] claude가 MCP 서버를 인식 못 하고 그냥 텍스트로만 응답하고 종료하는 경우의 폴백
      — 세션 정상 종료 후 `job.done`을 확인해, 콜백이 안 왔으면 사용자에게 실패를 안내하고
      로그에 `status: 'no_reply'`로 남긴다 (조용한 무응답 제거). 자동 재시도는 미구현.
- [ ] 첨부파일 전송(`filesUploadV2`) 경로 — claude가 넘기는 `file_paths`가 REPO_ROOT 하위 상대/절대 어느 쪽인지 정리 필요
- [ ] 동시 멘션 다발 시 claude 프로세스 동시 실행 개수 제한 여부 (현재 무제한 spawn)
