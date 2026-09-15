// metric_<metric> 생성. period_ 를 시프트해 자기 자신과 조인하고 비교 기준값을 붙인다.
//
// dimension 조인은 없다 (P5). period_ 하나만 읽으므로 atomic fact 와 dimension 을
// 다시 읽지 않는다 (P11). 기간 확장은 period_ 가 이미 해뒀다.
//
// 전부 table 이다 (P22). 하루가 추가되면 그 주·월·연 행이 다시 계산되고
// 1년 뒤 행의 yoy_base 까지 바뀐다 — 무효화 범위가 흩어져 있어 증분이 이득이 없다.
//
// clusterBy 는 걸지 않는다. daily_ 와 같은 이유로 64 MB 에 한참 못 미친다.

const { METRICS }                       = require("includes/metrics");
const { ENTITIES }                      = require("includes/entities");
const { metricName, baseColumn }        = require("includes/naming");
const { metricSQL, resolveDims, applicableCompares } = require("includes/build");

Object.entries(METRICS).forEach(([name, m]) => {
  const e      = ENTITIES[m.entity];
  const dims   = resolveDims(name, m).map((d) => d.name);
  const sketch = m.additive.time === "sketch";

  const columns = {
    period_type:  "daily · weekly · monthly · yearly. 한 테이블에 4종이 들어간다",
    period_start: "기간 시작일. 비교 조인이 이 컬럼으로 맞춘다 (P14)",
    as_of_date:   "기간 종료일. 소비 시점의 기간 누계가 이 날짜를 기준일로 쓴다 (P13·P15)",
    [name]: sketch
      ? `${m.description} — HLL 스케치(BYTES). 값을 보려면 HLL_COUNT.EXTRACT (P11)`
      : m.description,
  };
  for (const d of dims) columns[d] = `차원. ${e.dims[d].via || "fact 자체 컬럼"}`;

  // 증감률이 아니라 시프트한 기간의 값이다. 나눗셈은 소비 시점에 한다 (P12).
  //
  // NULL 은 0 이 아니라 "그 기간에 같은 차원 조합이 없었다" 는 뜻이다.
  // 차원을 걷어내며 SUM 하면 NULL 이 빠져 과소 집계된다 — 걷을 거면 그 grain 에서
  // 다시 시프트 조인해야 한다 (P14-1)
  for (const [label, applicable] of applicableCompares(m)) {
    columns[baseColumn(label)] =
      `${applicable.map(([p]) => p).join(" · ")} 행에서만 채워진다. ` +
      `${label.toUpperCase()} 기준 기간의 값 — 증감률이 아니다 (P14). ` +
      `NULL 은 그 기간에 같은 차원 조합이 없었다는 뜻. 차원을 걷으며 SUM 하지 말 것 (P14-1)`;
  }

  publish(metricName(name), {
    type:        "table",
    schema:      "semantic",
    tags:        ["semantic", "metric"],
    description: `${m.description} — 기간 4종 + 비교 기준값. 서빙 표면`,
    columns,

    // as_of_date 로 자른다. 비교 조인이 이 컬럼으로 맞고, 누계 조회도
    // "8/14 기준" 처럼 as_of_date 를 건다
    bigquery: { partitionBy: "as_of_date" },

    // 키는 as_of_date 다. 누계는 같은 period_start 에 cutoff 가 여러 개라
    // (mtd 8/01 은 8/01~8/31 의 31행) period_start 로는 유일하지 않다.
    // period_type 도 들어가야 한다 — 2026-03-02 은 그날이면서 그 주의 시작일이다
    assertions: {
      uniqueKey:     ["period_type", "as_of_date", ...dims],
      nonNull:       ["period_type", "period_start", "as_of_date"],
      rowConditions: ["as_of_date >= period_start"],
    },
  }).query((ctx) => metricSQL(ctx, name, m));
});
