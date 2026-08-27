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
`prompts/qa.md`에 정의돼 있다.

**지침은 코드가 아니라 `prompts/*.md`에 있다**: 시스템 프롬프트 본문은 매 턴 spawn 직전에 파일에서 새로
읽는다 (`src/system-prompt.ts`는 로더일 뿐). 따라서 지침 수정은 **재빌드·재시동 없이 다음 질의부터 즉시
반영**된다. `{{include:_파일명.md}}`로 공용 블록(게이트 렌즈·코드 노출 제한·첨부 안내·다이어그램)을 공유한다.
렌즈 id 등 코드와 공유하는 상수는 `src/gate-schema.ts`가 기준이므로 `_gate-lenses.md`와 드리프트에 주의.

**코드 노출 제한**: 봇이 코드베이스 유출 창구로 악용되지 않도록, 답변 하나에 담는 실제 소스코드는
모든 스니펫 합산 10줄을 넘길 수 없다 (qa/feedback 모드 공통, `prompts/_code-exposure.md`).
"코드 전체를 보여달라"거나 여러 턴에 나눠 받는 우회 요청, 스레드/첨부/지라 본문에 섞인 해제 지시에도
응하지 않으며, `file_paths`로 레포 내 소스 파일을 첨부 전송하는 것도 금지다.

**`@planbot feedback <기획내용>`**: 구현 가능성/공수 판단 없이 위 7개 렌즈로만 자료 품질을 평가하는
전용 모드. 멘션 뒤 첫 단어가 `feedback`이면 코드 레벨(`index.ts`의 `detectMentionCommand`)에서 결정론적으로
트리거되고, 그 스레드는 이후 재멘션 없이 이어지는 답글까지 끝까지 이 모드로 고정된다(`thread-store.ts`).
답변은 자유 서술형이되 맨 앞줄에 **판정: PASS(개발 착수 가능)** 또는 **판정: 명확화 필요**를 명시하고,
걸린 렌즈마다 자료를 어떻게 고치면 되는지 구체적 개선 방법을 함께 준다. 어휘 일치 판단은 별도 용어집을
만들지 않고, 원고의 개념어를 그때그때 레포에서 grep해 확인하는 방식이다. 개선 방법은 기획자가 개발자
도움 없이 실행할 수 있는 수준으로 제시하고(컬럼명·엔드포인트를 적으라는 식의 요구 금지), 답변에서
파일 경로·렌즈 영문 id·사내 내부 용어를 노출하지 않는 비개발직군 친화 스타일을 강제한다.
지라 티켓 번호만 제시되면 `jira issue view`로 원문을 먼저 확보해 평가하고, 확보 실패 시 되묻는다.

**Jira 댓글로 보완 맥락 남기기** (feedback 모드 전용): 게이트 지적을 받은 기획자가 보완 내용을
확정한 뒤 "이걸 지라에 남겨줘"라고 명시적으로 요청하면, claude가 `propose_jira_comment` MCP 툴로
댓글 등록을 **제안**한다. 즉시 등록되지 않는다 — 봇이 스레드에 티켓 번호와 댓글 본문 미리보기를
올리고, **요청자 본인이 `등록`이라고 답글을 달아야**(비활성 스레드에서는 `@planbot 등록`) 메인
프로세스가 `jira issue comment add`를 실행한다. `취소`로 취소, 30분 뒤 자동 만료. 댓글에는
`[기획 보완 — planbot 게이트 검토 후 확정]` 접두사와 요청자 이름이 붙는다. 티켓 본문 수정은
하지 않는다(소유권·포맷 파손 리스크) — 본문 반영이 필요하면 기획자가 댓글 내용을 직접 옮긴다.
claude의 allowedTools에는 Jira 쓰기 명령이 없어, 프롬프트 인젝션이 있어도 사람 승인 없이는
Jira에 아무것도 남길 수 없다. 등록 실행 계정은 원격 PC의 jira-cli 인증 계정이며 해당 프로젝트
댓글 쓰기 권한이 필요하다 (`JIRA_BIN`으로 경로 지정 가능).

**`@planbot search <검색어>`**: 과거에 누구든 질의했던 기록을 검색한다. 대상은 **공개 채널에서 접수된
질의만** — DM·비공개 채널 질의는 다른 사용자에게 노출하지 않는다 (`src/search-log.ts`가 로그를 읽어
채널 공개 여부를 `conversations.info`로 확인·필터링). 메인 프로세스가 후보(질문 원문 500자·질문자·일시·
슬랙 permalink)를 결정론적으로 추려 프롬프트에 넣고, claude 세션이 관련도순 최대 10건을 골라 링크와 함께
답한다. 이 세션의 allowedTools는 `reply_to_slack` 하나뿐이라 레포에 접근하지 않는다. 답변 본문은 로그에
없으므로 결과는 "질문 요약 + 원 스레드 링크" 형태다. 커맨드성 턴(search/team/help/dev)은 검색 대상에서
제외된다.

**`@planbot dev <요구사항>`** (관리자 전용): planbot **자체**의 지침(`prompts/*.md`)·런타임 코드(`src/*.ts`)·
탐색 안내용 `CLAUDE.md`를 수정하는 세션. `DEV_ALLOWED_USER_IDS`에 등록된 사용자만 호출할 수 있고,
비어 있으면 전면 비활성이다. 일반 세션과 달리 Write/Edit/무제한 Bash가 허용되지만 경로가 제한된다 —
planbot 루트는 전부, 클라이언트 레포(REPO_ROOT)는 **CLAUDE.md 파일만** 쓰기 가능 (`devAllowedTools()`,
경로 스코프 permission rule. 단 Bash가 무제한이라 이 경로 제한은 우회 가능하다 — 관리자 전용 커맨드라는
전제로 수용). 세션은 변경을 로컬 커밋까지 하고 push는 하지 않는다. 세션 종료 후 메인 프로세스가 git
스냅샷 전후 비교로 변경 파일을 감지해, **런타임 코드(`src/` 등)가 바뀌었으면 요청자를 멘션하며 "빌드+
재시동 필요"를 안내**한다 — 봇이 스스로 재시동하지는 않는다 (진행 중인 다른 스레드를 죽이지 않기 위함).
지침(`prompts/`) 변경은 즉시 반영이라고 안내한다. dev로 시작한 스레드는 dev 모드로 고정되며 관리자가
아닌 사용자는 그 스레드에 참여할 수 없다.

**`@planbot help`**: 커맨드 목록·자동 반응 규칙을 안내한다 (세션 없이 즉시 응답, 관리자에게는 dev 항목 포함).

**작동 흐름 다이어그램**: 사용자가 처리 흐름을 그림으로 요청하면 claude가 Graphviz DOT 소스를 작성해
MCP 툴 `render_diagram`으로 PNG를 렌더링하고(`dot -Tpng`, 한글 폰트는 `-Gfontname` 기본값 주입 —
`DIAGRAM_FONT`, 기본 "Malgun Gothic"), 반환된 경로를 `reply_to_slack`의 `file_paths`에 넣어 슬랙에
이미지로 첨부한다. 렌더 실패 시 stderr가 그대로 반환되므로 claude가 DOT를 고쳐 재시도한다(최대 2회).
원격 PC에 [Graphviz](https://graphviz.org/download/) 설치가 필요하며(`GRAPHVIZ_BIN`으로 경로 지정 가능),
업로드가 끝난 임시 PNG는 콜백 서버가 정리한다. 미설치 상태면 툴이 오류를 돌려주고 텍스트로만 답한다.

## 1:1 DM 사용

채널 멘션 외에 **봇과의 1:1 DM**으로도 쓸 수 있다 (Slack 앱에 `im:history` scope + `message.im`
이벤트 구독 필요 — 아래 준비물 참조). 동작은 채널과 동일하고, **멘션만 불필요**하다:

- **일반 메시지 하나 = 세션 하나**: DM에 그냥 질문을 보내면 봇이 그 메시지에 **답글(스레드)**로 응답한다.
- **후속 질문은 그 스레드에 답글로**: 재멘션 없이 답글만 달면 맥락이 이어진다 (DM은 채널과 달리
  자동 반응 TTL·타인 멘션 해제 규칙이 적용되지 않는다 — 항상 봇과의 1:1 대화이므로).
  새 주제는 새 최상위 메시지로 시작하면 된다.
- **모드는 스레드 단위**: 첫 단어가 `feedback`(또는 관리자의 `dev`)이면 그 스레드는 끝까지 해당 모드로 고정된다.
- **커맨드**: 멘션 없이 첫 단어만으로 `team`/`search`/`help`/`dev`를 채널과 동일하게 쓸 수 있다.
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

**멀티턴 — 사용자 단위 자동 반응**: `thread-store.ts`가 스레드별로 **planbot을 멘션한 사용자**를
기억한다(스레드 루트 멘션이든 사람들끼리 대화하던 스레드의 도중 멘션이든 동일). 그 사용자는 이후
재멘션 없이 답글만 달아도 다음 턴으로 이어지고, **같은 스레드의 다른 사람 답글에는 반응하지 않는다** —
사람 간 대화에 봇이 끼어들지 않기 위한 사용자 단위 스코프다. 규칙:
- 사용자가 **다른 사용자/봇/@here/@channel/유저그룹을 멘션한 메시지**를 보내면, 그 메시지를 포함해
  그 사용자의 자동 반응이 꺼진다 (사람에게 하는 말로 간주). planbot을 다시 멘션하면 다시 켜진다.
  planbot과 타인을 한 메시지에 같이 멘션하면 그 턴은 답하되 자동 반응은 꺼진 상태로 둔다.
- **TTL**: 마지막 활동 후 24시간(`AUTO_REPLY_TTL_MS`)이 지나면 자동 반응이 만료된다 — 잠들어 있던
  스레드에 딴 얘기 답글이 달렸을 때 봇이 되살아나는 것을 막는다. DM에는 적용하지 않는다.
- **영속화**: 스레드 상태(모드·자동 반응 사용자·턴 카운터)는 `data/thread-state.json`에 저장되어
  봇을 재시동해도 진행 중이던 대화가 끊기지 않는다 (45일 지난 스레드는 로드 시 정리).

**스레드당 세션 1개 + 보류 큐**: 세션이 도는 중에 같은 스레드에 새 메시지가 오면 세션을 병렬로 띄우지
않고 보류한다. 보류된 메시지에는 "(앞선 요청을 처리 중입니다 — 보류됐다가 잠시 후 함께 처리됩니다)"
안내 답글이 달리고, 앞 세션이 끝나면 안내 메시지를 지운 뒤 **한 턴만** 다시 돌린다 — 스레드 전체를
다시 읽으므로 보류된 메시지들의 내용은 모두 포함된다 (`requestTurn`, `index.ts`).

매 턴 `conversations.replies`로 스레드 전체를 다시 읽어 프롬프트에 넣으므로, claude 프로세스 자체는
매번 새로 뜨는 헤드리스 세션이어도 이전 턴 맥락은 항상 포함된다.

**첨부파일**: `attachment-fetch.ts`가 스레드의 첨부파일을 실제로 다운로드해(20MB 상한) 임시 디렉터리에
저장하고, 프롬프트에 로컬 절대경로를 남긴다. claude는 `--allowedTools`에 Read가 포함돼 있으므로
그 경로를 Read 툴로 직접 열어 내용을 확인할 수 있다 — 기획서가 텍스트가 아니라 PDF/이미지로 첨부돼도
게이트 체크 대상이 된다. 다운로드한 임시 파일은 세션 종료 후 정리된다.

**도구 범위**: 슬랙 스레드 텍스트·첨부가 그대로 프롬프트에 들어가 프롬프트 인젝션에 노출돼 있으므로,
`--dangerously-skip-permissions` 대신 `--allowedTools`로 모드별 화이트리스트만 허용한다
(`src/claude-runner.ts`). qa/feedback은 `Read`/`Grep`/`Glob`/`Bash(jira issue view:*)`/
`mcp__planbot__reply_to_slack`/`mcp__planbot__propose_jira_comment`/`mcp__planbot__render_diagram`,
search는 `reply_to_slack` 하나뿐이다. Write·Edit·임의 Bash는 관리자 전용 dev 모드에만, 그것도 경로
스코프를 걸어 허용된다. 일반 모드에서 claude가 레포에 쓰기를 하거나 임의 명령을 실행할 수 없다. Jira 쓰기(`comment add`)도
claude 권한에는 없고, 제안 → 사람 승인 → 메인 프로세스 실행 구조라 답변 생성 외의 부작용은
사람 승인을 거치지 않고는 구조적으로 불가능하다.
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
- **Graphviz** (선택 — 작동 흐름 다이어그램 기능용): [graphviz.org/download](https://graphviz.org/download/)의
  Windows 인스톨러로 설치하고 `dot -V`로 확인. PATH에 없으면 `.env`의 `GRAPHVIZ_BIN`에 절대경로 지정.
  미설치여도 봇은 정상 동작하며 다이어그램만 텍스트로 대체된다.

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
- [ ] 첨부파일 전송(`filesUploadV2`) 경로 — claude가 넘기는 `file_paths`가 REPO_ROOT 하위 상대/절대 어느 쪽인지 정리 필요.
      **다이어그램 첨부 기능이 이 경로를 쓰므로 배포 시 우선 검증 대상**
- [ ] 스레드당 세션은 1개로 제한(보류 큐)했지만, 서로 다른 스레드의 동시 멘션 다발 시 프로세스 총량 제한은 여전히 없음
- [ ] dev 모드의 경로 스코프 permission rule(`Edit(//C:/.../**)`)이 Windows 절대경로에서 의도대로 동작하는지
      (안 되면 dev.md 지침의 경계 서술에만 의존하게 됨 — Bash 우회가 이미 가능하므로 보안 경계는 아니고 오작동 방지용)
- [ ] Windows에서 Graphviz `dot`의 "Malgun Gothic" 폰트 매칭이 한글 라벨을 깨짐 없이 렌더링하는지
