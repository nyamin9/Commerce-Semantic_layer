// 기간 정의. 지표와 직교하므로 metrics.js에 넣지 않는다.
//
// 기간은 행이 아니라 컬럼이다. 한 행이 "그 record_date 의 모든 것" 이고,
// daily·wtd·mtd·ytd 가 나란히 놓인다. 그래서 여기 한 줄을 더하면 모든 지표의
// 서빙 테이블에 컬럼 한 벌(값 1 + 비교 n)이 생긴다.
//
//   daily        그날 하루. 집계하지 않고 그대로 통과시킨다
//   cumulative   기간 시작부터 record_date 까지 누계다
//
// weekly·monthly·yearly 는 없다. 완결 기간의 rollup은 누계와 같은 값이기 때문이다 —
// 실측으로 10,080 조합 전부 일치했다. end_flag 로 골라 쓴다.
//
//   monthly  =  mtd  where is_month_end
//
// 그렇게 하면 미완결 기간 행이 미래 날짜를 다는 문제도 같이 사라진다. 직전 구조는
// 진행 중인 주의 weekly 행이 as_of_date 로 아직 오지 않은 일요일을 달고 있었고,
// 그 행의 wow_base 가 4일치를 지난주 7일 전체와 맞댔다.
//
// ── 선언 순서가 의미를 갖는다 ────────────────────────────────
// 누계는 좁은 것부터 선언해야 한다. sketch 누계가 가장 넓은 구간으로 한 번만
// 조인하고 좁은 기간을 IF 로 걸러내기 때문에, 마지막 것이 조인 범위가 된다.
//
// ── compare ──────────────────────────────────────────────────
// 증감률이 아니라 기준값 컬럼을 만든다 (P14). record_date 를 시프트해 같은 기간
// 컬럼끼리 맞춘다.
//
// 간격은 기간마다 다를 수 있다. wtd 의 YoY 가 1 YEAR 이면 요일이 어긋난다 —
// 2026-03-02(월)의 1년 전은 일요일이다. 주간 비교는 52주(364일) 시프트가
// 표준이며 같은 요일에 떨어진다.
//
// 누계에 dod 는 넣지 않는다. "어제까지 월 누계 대비 오늘까지"는 결국 오늘
// 하루치라 daily 의 dod_base 와 같은 값이 된다.

const PERIODS = {
  daily: {
    type: "passthrough",
    label: "하루",
    trunc: null,
    end_flag: null,
    compare: { dod: "1 DAY", wow: "1 WEEK", yoy: "1 YEAR" },
  },

  // 좁은 것부터. 마지막(ytd)이 sketch 구간 조인의 범위가 된다
  wtd: {
    type: "cumulative",
    label: "주",
    trunc: "WEEK(MONDAY)",
    end_flag: "is_week_end",
    compare: { wow: "1 WEEK", yoy: "364 DAY" },
  },
  mtd: {
    type: "cumulative",
    label: "월",
    trunc: "MONTH",
    end_flag: "is_month_end",
    compare: { mom: "1 MONTH", yoy: "1 YEAR" },
  },
  ytd: {
    type: "cumulative",
    label: "연",
    trunc: "YEAR",
    end_flag: "is_year_end",
    compare: { yoy: "1 YEAR" },
  },
};

// 누계 기간. 선언 순서를 그대로 유지한다 (좁은 것부터)
const CUMULATIVE = Object.keys(PERIODS).filter((p) => PERIODS[p].type === "cumulative");

// 완결 플래그 컬럼. record_date 에서 결정론적으로 나온다
const END_FLAGS = CUMULATIVE.map((p) => ({ name: PERIODS[p].end_flag, trunc: PERIODS[p].trunc }));

// 서로 다른 시프트 간격 → 그 간격으로 가져올 [기간, 라벨] 목록.
// metricSQL 이 자기조인을 간격 단위로 묶는 근거다. 8개 비교 컬럼이 5번의
// 조인으로 채워진다 — 1 DAY · 1 WEEK · 1 MONTH · 1 YEAR · 364 DAY
const SHIFTS = (() => {
  const acc = {};
  for (const [pName, p] of Object.entries(PERIODS)) {
    for (const [label, interval] of Object.entries(p.compare)) {
      (acc[interval] = acc[interval] || []).push({ period: pName, label });
    }
  }
  return acc;
})();

module.exports = { PERIODS, CUMULATIVE, END_FLAGS, SHIFTS };
