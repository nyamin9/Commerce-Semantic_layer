// daily_<metric> 생성. metrics.js 의 선언 하나가 테이블 하나가 된다 (P17).
//
// 조인이 실행되는 유일한 곳이다 (P5). metric_ 은 여기서만 읽고 원자 fact 와
// dimension 을 다시 읽지 않는다 (P11).
//
// clusterBy 는 걸지 않는다. BigQuery 가 권장하는 기준이 64 MB 인데 daily_ 는
// 그보다 작다. 더 작은 테이블에 걸어도 개선이 사실상 없다.
//
// refresh 는 entities.js 가 정한다 (P22). 상류가 전체 재생성하는 fact 위에는
// 증분을 올리지 않는다 — 과거 구간의 변경을 놓친다.

const { METRICS }                      = require("includes/metrics");
const { ENTITIES, refreshOf }          = require("includes/entities");
const { dailyName }                    = require("includes/naming");
const { dailySQL, resolveDims }        = require("includes/build");

Object.entries(METRICS).forEach(([name, m]) => {
  const e           = ENTITIES[m.entity];
  const dims        = resolveDims(name, m).map((d) => d.name);
  const incremental = refreshOf(m.entity) === "incremental";
  const sketch      = m.additive.time === "sketch";

  const columns = {
    dt: `집계 기준일. ${e.source}.${e.date_col}`,
    [name]: sketch
      ? `${m.description} — HLL 스케치(BYTES). 값을 보려면 HLL_COUNT.EXTRACT (P11)`
      : m.description,
  };
  for (const d of dims) columns[d] = `차원. ${e.dims[d].via || "fact 자체 컬럼"}`;

  publish(dailyName(name), {
    type:        incremental ? "incremental" : "table",
    schema:      "semantic",
    tags:        ["semantic", "daily"],
    description: `${m.description} — 날짜 × 차원 집계. ${e.grain} 에서 산출`,
    columns,

    // 증분은 (dt, 차원 전부) 로 MERGE 한다. 재처리 구간의 행이 덮이지 않고
    // 쌓이면 그 구간만 두 배가 된다 — 에러 없이 숫자만 틀리는 사고다
    uniqueKey: incremental ? ["dt", ...dims] : undefined,

    bigquery: { partitionBy: "dt" },

    // uniqueKey — 첫 적재는 INSERT 라 MERGE 가 유일성을 보장하지 않는다.
    //   조인이 fan-out 되면 여기서 잡힌다.
    //
    // nonNull — 증분일 때만 차원까지 건다. MERGE 의 ON 은 = 비교라 NULL 인 키는
    //   영원히 매칭되지 않고 재실행마다 그 행이 쌓인다. 에러 없이 숫자만 늘어난다.
    //   차원의 NULL 자체는 정당한 버킷이지만(P6-1) MERGE 키로는 쓸 수 없다.
    assertions: {
      uniqueKey: ["dt", ...dims],
      nonNull:   incremental ? ["dt", ...dims] : ["dt"],
    },
  }).query((ctx) => dailySQL(ctx, name, m, { incremental: ctx.incremental() }));
});
