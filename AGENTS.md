# planbot 작업 시 필수 규칙

## ⚠️ 커밋 후 public repo 동기화 (절대 생략 금지)

이 디렉터리(`apps/planbot`)의 코드·문서를 수정해 커밋했다면, **같은 턴 안에서 반드시**
`playbooks/planbot-public-repo-sync.md` 절차를 수행해 `github.com/vibemafiaclub/planbot`에도 push한다.

- 클라이언트 원격 PC는 context-hub가 아니라 **public repo를 clone해서 쓴다.**
  context-hub에만 커밋하면 배포 환경에는 아무것도 반영되지 않는다.
- 실제 사고 사례: 2026-08-27 DM 지원 커밋을 context-hub에만 push하고 동기화를 빠뜨려,
  다음 날 "원격 PC에 반영이 안 됐다"는 문의를 받았다.
- 동기화 시 클라이언트 식별정보(팀명·레포 경로·티켓 prefix·제품명 등)를 playbook의
  grep 목록으로 스캔해 placeholder로 치환하는 것까지가 한 세트다.
- 이 AGENTS.md와 자동 생성되는 CLAUDE.md는 public repo에 복사하지 않는다
  (playbook rsync exclude에 포함됨).

동기화까지 마친 뒤에는 사용자에게 "원격 PC에서 `git pull` + `npm run build` + 재시작이
별도로 필요하다"고 안내한다.
