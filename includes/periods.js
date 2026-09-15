// 기간 정의. 지표와 직교하므로 metrics.js에 넣지 않는다.
// 기간을 추가하려면 여기 한 줄이면 되고, 모든 지표에 대해 생성된다.
//
//   passthrough  daily. 접지 않고 그대로 통과시킨다
//   rollup       완결 기간 하나로 롤업한다.          한 주 = 한 행
//   cumulative   기간 시작부터 그날까지 누계다.      한 주 = 그 주의 날 수만큼
//
// 누계가 별도 테이블이 아니라 period_type 인 이유는 period_start(시작)와
// as_of_date(끝)가 이미 구간을 표현하기 때문이다 (P13). 누계는 as_of_date 가
// 달력 끝이 아니라 cutoff 인 기간일 뿐이다.
//
//   monthly  period_start 8/01   as_of_date 8/31   월 전체
//   mtd      period_start 8/01   as_of_date 8/14   그날까지
//
// 컬럼도 테이블도 늘지 않고, 비교 기준값이 그대로 따라온다 — mtd 의 mom_base 는
// 지난달 1~14일 누계이고 yoy_base 는 작년 8월 1~14일 누계다.
//
// compare는 증감률이 아니라 기준값 컬럼을 만든다 (P14).
// as_of_date 를 시프트해 같은 period_type 안에서 맞춘다.
//
// 간격은 기간마다 다를 수 있다. weekly 의 YoY 가 1 YEAR 이면 주 시작일에
// 떨어지지 않아 매칭이 전부 실패한다 — 2026-03-02(월)의 1년 전은 일요일이다.
// 주간 비교는 52주(364일) 시프트가 표준이며 같은 요일에 떨어진다.
//
// 누계에 dod 는 넣지 않는다. "어제까지 월 누계 대비 오늘까지"는 결국 오늘
// 하루치라 daily 와 같은 값이 된다.

const PERIODS = {
  daily:   { type: "passthrough", trunc: null,           compare: { dod: "1 DAY", wow: "1 WEEK", yoy: "1 YEAR" } },

  wtd:     { type: "cumulative",  trunc: "WEEK(MONDAY)", compare: { wow: "1 WEEK",  yoy: "364 DAY" } },
  mtd:     { type: "cumulative",  trunc: "MONTH",        compare: { mom: "1 MONTH", yoy: "1 YEAR" } },
  ytd:     { type: "cumulative",  trunc: "YEAR",         compare: { yoy: "1 YEAR" } },

  weekly:  { type: "rollup",      trunc: "WEEK(MONDAY)", compare: { wow: "1 WEEK",  yoy: "364 DAY" } },
  monthly: { type: "rollup",      trunc: "MONTH",        compare: { mom: "1 MONTH", yoy: "1 YEAR" } },
  yearly:  { type: "rollup",      trunc: "YEAR",         compare: { yoy: "1 YEAR" } },
};

// 비교 라벨 → { period_type: 간격 }.
// 라벨마다 컬럼이 하나 생기고, 그 라벨을 선언한 period_type 행에서만 채워진다.
// 간격이 기간마다 다르므로 period_type 별로 보관한다.
const COMPARE_LABELS = (() => {
  const acc = {};
  for (const [pName, p] of Object.entries(PERIODS)) {
    for (const [label, interval] of Object.entries(p.compare)) {
      acc[label] = acc[label] || {};
      acc[label][pName] = interval;
    }
  }
  return acc;
})();

module.exports = { PERIODS, COMPARE_LABELS };
