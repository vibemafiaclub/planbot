/**
 * system-prompt.ts의 "0. 상황 분류"·"1. 게이트 체크" 항목과 1:1로 대응한다.
 * mcp-server.ts(reply_to_slack 입력 스키마)와 logger.ts(로그 필드)가 공유해서 드리프트를 막는다.
 */

export const CLASSIFICATIONS = ['A', 'B', 'C', 'D', 'E'] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

export const CLASSIFICATION_LABELS: Record<Classification, string> = {
  A: '기획 원고/스펙 포함',
  B: '순수 질문만',
  C: '지라 티켓 번호만 제시',
  D: '질문이 지나치게 광범위함',
  E: '대상 제품 불특정',
};

export const GATE_LENSES = [
  'timing_dependency',
  'boundary_transition',
  'screen_policy_consistency',
  'indefinite_wait',
  'ambiguous_term_or_data',
] as const;
export type GateLens = (typeof GATE_LENSES)[number];

export const GATE_LENS_LABELS: Record<GateLens, string> = {
  timing_dependency: '타이밍 의존성',
  boundary_transition: '경계/전이 시점',
  screen_policy_consistency: '화면-정책 정합성',
  indefinite_wait: '무기한 대기',
  ambiguous_term_or_data: '용어·데이터 명확성',
};
