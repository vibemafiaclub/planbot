/**
 * system-prompt.ts의 "0. 상황 분류"·"1. 게이트 체크" 항목과 1:1로 대응한다.
 * mcp-server.ts(reply_to_slack 입력 스키마)와 logger.ts(로그 필드)가 공유해서 드리프트를 막는다.
 */

export const CLASSIFICATIONS = ['A', 'B', 'C', 'D', 'E', 'F', 'S', 'X'] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

export const CLASSIFICATION_LABELS: Record<Classification, string> = {
  A: '기획 원고/스펙 포함',
  B: '순수 질문만',
  C: '지라 티켓 번호만 제시',
  D: '질문이 지나치게 광범위함',
  E: '대상 제품 불특정',
  F: '`feedback` 커맨드로 명시적 자료 품질 평가 요청',
  S: '`search` 커맨드 — 과거 질의 기록 검색',
  X: '`dev` 커맨드 — planbot 자체 개선 세션',
};

/**
 * 논리적 완결성(엣지케이스 상정)이 아니라, "AI 에이전트 입력으로서의 전달 형식·정밀도·추적가능성"을 본다.
 * 코드베이스를 이해하고 있다면 유추 가능한 내용은 결여로 치지 않는다 — system-prompt.ts 참고.
 */
export const GATE_LENSES = [
  'structuring',
  'excessive_volume',
  'text_as_image',
  'vocabulary_mismatch',
  'ui_location_precision',
  'as_is_to_be_missing',
  'no_searchable_anchor',
  'inaccessible_external_reference',
] as const;
export type GateLens = (typeof GATE_LENSES)[number];

export const GATE_LENS_LABELS: Record<GateLens, string> = {
  structuring: '데이터 구조화 부족',
  excessive_volume: '내용 대비 과도한 용량',
  text_as_image: '텍스트를 이미지로 전달 (OCR 유실 위험)',
  vocabulary_mismatch: '코드베이스와 다른 자체 어휘 사용',
  ui_location_precision: 'UI 작업 위치를 어휘로 특정하지 못함 (시각적 마킹 의존)',
  as_is_to_be_missing: 'AS-IS/TO-BE 미명시 (수정 요청인 경우)',
  no_searchable_anchor: '코드베이스에서 검색 가능한 구체적 앵커 부재 (화면명·API·테이블·티켓번호 등)',
  inaccessible_external_reference: 'AI가 접근 불가능한 외부 도구 링크로만 기획 존재 (Figma·위키 등) 또는 캡쳐 이미지에 본문 설명 부재',
};
