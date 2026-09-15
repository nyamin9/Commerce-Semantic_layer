// metric_<metric> 생성. period_ 를 시프트해 자기 자신과 조인하고 비교 기준값을 붙인다.
//
// dimension 조인은 없다 (P5). period_ 하나만 읽으므로 atomic fact 와 dimension 을
// 다시 읽지 않는다 (P11). 기간 확장도 CUBE 도 period_ 가 이미 해뒀다.
//
// 비교 컬럼 8개가 서로 다른 시프트 5개에서 나오므로 자기조인도 5번이다 —
// 1 DAY · 1 WEEK · 1 MONTH · 1 YEAR · 364 DAY (근거는 build.js 의 metricSQL 주석).
//
// 전부 table 이다 (P22). 하루가 추가되면 364일·1년 뒤 행의 비교 기준값까지
// 바뀐다 — 무효화 범위가 흩어져 있어 증분이 이득이 없다.
//
// clusterBy 는 걸지 않는다. daily_ 와 같은 이유로 64 MB 에 한참 못 미친다.

const { METRICS }    = require("includes/metrics");
const { PERIODS }    = require("includes/periods");
const { metricName, RECORD_DATE, valueColumn } = require("includes/naming");
const { metricSQL, servingAxes, usablePeriods, comparePlan, endFlagNames } = require("includes/build");

Object.entries(METRICS).forEach(([name, m]) => {
  const axes   = servingAxes(name, m);
  const sketch = m.additive.time === "sketch";

  const columns = {
    [RECORD_DATE]: "기준일. daily 는 그날, 누계는 기간 시작부터 이 날까지다",
  };
  for (const d of axes) {
    columns[d] = "차원. '(all)' 은 이 축을 걷은 롤업 행이다. NULL 은 값이 없는 버킷 (P6-1)";
  }
  for (const f of endFlagNames()) {
    columns[f] = "이 날이 해당 기간의 마지막 날인가. 완결 기간 집계를 고를 때 쓴다 (P13)";
  }
  for (const p of usablePeriods(m)) {
    const what = p === "daily" ? "그날 하루" : `${PERIODS[p].label} 시작부터 record_date 까지 누계`;
    columns[valueColumn(name, p)] = sketch
      ? `${m.description} — ${what}. HLL 스케치(BYTES). 값을 보려면 HLL_COUNT.EXTRACT (P11)`
      : `${m.description} — ${what}`;
  }

  // 증감률이 아니라 시프트한 기간의 값이다. 나눗셈은 소비 시점에 한다 (P12).
  //
  // NULL 은 0 이 아니라 "그 기간에 같은 차원 조합이 없었다" 는 뜻이다.
  // 차원을 걷어내며 SUM 하면 NULL 이 빠져 과소 집계된다 — '(all)' 행을 쓰면 된다 (P14-1)
  for (const c of comparePlan(m)) {
    columns[c.column] =
      `${valueColumn(name, c.period)} 의 ${c.interval} 전 값 — 증감률이 아니다 (P14). ` +
      `NULL 은 그 시점에 같은 차원 조합이 없었다는 뜻. ` +
      `차원을 걷을 때는 SUM 하지 말고 '(all)' 행을 본다 (P14-1)`;
  }

  publish(metricName(name), {
    type:        "table",
    schema:      "semantic",
    tags:        ["semantic", "metric"],
    description: `${m.description} — 4축 CUBE × 기간 컬럼 + 비교 기준값. 서빙 표면`,
    columns,

    bigquery: { partitionBy: RECORD_DATE },

    assertions: {
      uniqueKey: [RECORD_DATE, ...axes],
      nonNull:   [RECORD_DATE, ...endFlagNames()],
    },
  }).query((ctx) => metricSQL(ctx, name, m));
});
