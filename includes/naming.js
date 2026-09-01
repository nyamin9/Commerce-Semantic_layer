// 이름 규칙. 생성기들이 공유하는 계약이라 한 파일에만 둔다 (P19).
// 규칙이 흩어지면 언젠가 어긋나고 ref()가 끊어진다. 어긋나면 컴파일이 실패한다.

const MART_PREFIX = "sem_";

// semantic_mart — DW와 이름이 겹치면 ref()가 충돌하므로 접두사를 붙인다
const martName = (base) => `${MART_PREFIX}${base}`;

// semantic — 지표당 두 테이블
const dailyName  = (metric) => `daily_${metric}`;
const metricName = (metric) => `metric_${metric}`;

// 비교 기준값 컬럼. 증감률이 아니라 기준 기간의 값이다 (P12·P14)
const baseColumn = (label) => `${label}_base`;

module.exports = { MART_PREFIX, martName, dailyName, metricName, baseColumn };
