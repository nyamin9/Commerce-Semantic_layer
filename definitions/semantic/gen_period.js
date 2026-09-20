// period_<metric> 생성. daily_ 를 serving_dims rollup × 기간 컬럼으로 편다.
//
// 기간은 행이 아니라 컬럼이다 (P13). 한 행이 "그 record_date 의 모든 것" 이고
// daily·wtd·mtd·ytd 가 나란히 놓인다. weekly·monthly·yearly 는 만들지 않는다 —
// 완결 기간의 rollup이 누계와 같은 값이라 is_*_end 플래그로 고르면 된다.
//
// dimension 은 serving_dims 로 좁혀지고 각 축의 '(all)' rollup 행까지 만들어진다 (P4).
// 소비자가 직접 rollup 할 필요가 없다. sketch 지표는 rollup 할 때 SUM 이 아니라
// HLL_COUNT.MERGE 여야 하는데, 미리 만들어 두면 그 지식이 필요 없어진다.
//
// metric_ 이 이 테이블을 다섯 번 self-join 하므로 CTE 가 아니라 테이블이어야 한다.
// CTE 는 결과를 저장하지 않아 같은 집계가 다섯 번 돈다 (근거는 build.js 의 metricSQL 주석).
//
// 비교 없이 기간별 집계만 필요한 소비자는 여기서 끝난다.
//
// 전부 table 이다 (P22). 하루가 늘면 그날의 누계가 생기고 grid도 하루 늘어난다.

const { METRICS }         = require("includes/metrics");
const { periodName, RECORD_DATE, valueColumn, DATASETS, TAGS } = require("includes/naming");
const { PERIODS }         = require("includes/periods");
const { periodSQL, servingAxes, usablePeriods, endFlagNames } = require("includes/build");

Object.entries(METRICS).forEach(([name, m]) => {
  const axes   = servingAxes(name, m);
  const sketch = m.additive.time === "sketch";

  const columns = {
    [RECORD_DATE]: "기준일. daily 는 그날, 누계는 기간 시작부터 이 날까지다",
  };
  for (const d of axes) {
    columns[d] = `dimension. '(all)' 은 이 dimension 을 rollup 한 행, '(unknown)' 은 값이 없는 bucket (P6-3)`;
  }
  for (const f of endFlagNames()) {
    columns[f] = `이 날이 해당 기간의 마지막 날인가. 완결 기간 집계를 고를 때 쓴다 (P13)`;
  }
  for (const p of usablePeriods(m)) {
    const what = p === "daily"
      ? "그날 하루"
      : `${PERIODS[p].label} 시작부터 record_date 까지 누계`;
    columns[valueColumn(name, p)] = sketch
      ? `${m.description} — ${what}. HLL sketch(BYTES). 값을 보려면 HLL_COUNT.EXTRACT (P11)`
      : `${m.description} — ${what}`;
  }

  publish(periodName(name), {
    type:        "table",
    schema:      DATASETS.METRIC,
    tags:        [TAGS.SEMANTIC, "period"],
    description: `${m.description} — ${axes.length}축 rollup × 기간 컬럼. metric_ 의 재료`,
    columns,

    bigquery: { partitionBy: RECORD_DATE },

    // 키가 record_date 하나 + dimension이다. period_type 이 없어져 단순해졌다.
    // dimension에 '(all)' rollup 행이 섞여 있지만 값이 달라 유일하다
    assertions: {
      uniqueKey: [RECORD_DATE, ...axes],
      nonNull:   [RECORD_DATE, ...axes, ...endFlagNames()],
    },
  }).query((ctx) => periodSQL(ctx, name, m));
});
