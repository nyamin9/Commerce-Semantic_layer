// 이름 규칙. builder 와 generator 가 공유하는 계약이라 한 파일에만 둔다 (P19).
// 규칙이 흩어지면 언젠가 어긋나고 ref()가 끊어진다. 어긋나면 컴파일이 실패한다.

const MART_PREFIX = "sem_";

// semantic_mart — DW와 이름이 겹치면 ref()가 충돌하므로 접두사를 붙인다
const martName = (base) => `${MART_PREFIX}${base}`;

// semantic — 지표당 세 테이블
const dailyName  = (metric) => `daily_${metric}`;
const periodName = (metric) => `period_${metric}`;
const metricName = (metric) => `metric_${metric}`;

// 날짜 컬럼. 세 단계가 같은 이름을 쓴다.
//
// daily_ 에서는 그날, period_·metric_ 에서는 누계의 cutoff 이기도 하다.
// 한 행이 "그 날짜의 모든 것" 이라 dt 도 as_of_date 도 한쪽만 설명하는 이름이었다
const RECORD_DATE = "record_date";

// ── 서빙 테이블 컬럼 (P13) ───────────────────────────────────
// 규칙은 한 줄이다 — 기간 접두어가 없으면 daily 다.
//
//   net_revenue          net_revenue_wtd
//   dod_base             wtd_wow_base
//
// 가로 구조에서 wow_base 하나로는 daily 의 WoW 인지 wtd 의 WoW 인지 구분이 안 된다.
// 둘 다 존재하고 값이 다르다. 누계 쪽에만 접두어를 붙이면 기존 daily 소비자의
// 쿼리가 그대로 동작한다.
const valueColumn = (metric, period) =>
  period === "daily" ? metric : `${metric}_${period}`;

// 비교 기준값 컬럼. 증감률이 아니라 기준 기간의 값이다 (P12·P14)
const baseColumn = (period, label) =>
  period === "daily" ? `${label}_base` : `${period}_${label}_base`;

module.exports = {
  MART_PREFIX, martName,
  dailyName, periodName, metricName,
  RECORD_DATE, valueColumn, baseColumn,
};
