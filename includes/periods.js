// 기간 정의. 지표와 직교하므로 metrics.js에 넣지 않는다.
// 기간을 추가하려면 여기 한 줄이면 되고, 모든 지표에 대해 생성된다.
//
//   passthrough  daily. 접지 않고 그대로 통과시킨다
//   rollup       완결 기간 하나로 롤업한다.  한 주 = 한 행
//
// WTD·MTD·YTD 는 여기 없다. 저장하지 않고 소비 시점에 daily 구간 합으로
// 파생한다 (P15). 비율과 같은 이유다 — 파생 가능하고 롤업에서 깨진다.
//
//   누적을 (날짜 × 차원조합) 으로 물화하려면 그 기간에 활동이 없는 조합까지
//   격자로 채워야 한다. 채우지 않으면 쉬는 날 조합이 빠져 차원을 걷었을 때
//   누계가 줄어든다. 채우면 ytd 하나가 지표당 500만 행을 넘는다.
//
// compare는 증감률이 아니라 기준값 컬럼을 만든다 (P14).
// period_start 를 시프트해 같은 period_type 안에서 맞춘다.
//
// 간격은 기간마다 다를 수 있다. weekly 의 YoY 가 1 YEAR 이면 주 시작일에
// 떨어지지 않아 매칭이 전부 실패한다 — 2026-03-02(월)의 1년 전은 일요일이다.
// 주간 비교는 52주(364일) 시프트가 표준이며 같은 요일에 떨어진다.

const PERIODS = {
  daily:   { type: "passthrough", trunc: null,           compare: { dod: "1 DAY", wow: "1 WEEK", yoy: "1 YEAR" } },
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
