// daily_<metric> 생성. metrics.js 의 선언 하나가 테이블 하나가 된다 (P17).
//
// 조인이 실행되는 유일한 곳이다 (P5). period_ 는 여기서만 읽고 원자 fact 와
// dimension 을 다시 읽지 않는다 (P11).
//
// 차원이 가장 넓은 테이블이다. period_·metric_ 은 serving_dims 로 접히므로,
// category·department 같은 축이 필요하면 여기서 걷는다 (P4).
//
// clusterBy 는 걸지 않는다. BigQuery 가 권장하는 기준이 64 MB 인데 daily_ 는
// 그보다 작다. 더 작은 테이블에 걸어도 개선이 사실상 없다.
//
// refresh 는 entities.js 가 정한다 (P22). 상류가 전체 재생성하는 fact 위에는
// 증분을 올리지 않는다 — 과거 구간의 변경을 놓친다.

const { METRICS }                      = require("includes/metrics");
const { ENTITIES, refreshOf }          = require("includes/entities");
const { dailyName, RECORD_DATE }       = require("includes/naming");
const { dailySQL, resolveDims, incrementalPreOps } = require("includes/build");

Object.entries(METRICS).forEach(([name, m]) => {
  const e           = ENTITIES[m.entity];
  const dims        = resolveDims(name, m).map((d) => d.name);
  const incremental = refreshOf(m.entity) === "incremental";
  const sketch      = m.additive.time === "sketch";

  const columns = {
    [RECORD_DATE]: `집계 기준일. ${e.source}.${e.date_col}`,
    [name]: sketch
      ? `${m.description} — HLL 스케치(BYTES). 값을 보려면 HLL_COUNT.EXTRACT (P11)`
      : m.description,
  };
  for (const d of dims) columns[d] = `차원. ${e.dims[d].via || "fact 자체 컬럼"}`;

  publish(dailyName(name), {
    type:        incremental ? "incremental" : "table",
    schema:      "semantic",
    tags:        ["semantic", "daily"],
    description: `${m.description} — 날짜 × 전체 차원 집계. ${e.grain} 에서 산출`,
    columns,

    // uniqueKey 를 주면 Dataform 이 MERGE 를 쓴다. MERGE 는 지우지 않아서
    // 유령 행이 남으므로 쓰지 않는다 — preOps 에서 구간을 지우고 INSERT 한다
    bigquery: { partitionBy: RECORD_DATE },

    // 조인이 fan-out 되면 여기서 잡힌다. 증분이 구간을 지우고 다시 넣으므로
    // 유령 행이 남지 않는다 — MERGE 를 쓸 때와 달리 차원에 NULL 이 있어도 된다 (P6-1)
    assertions: {
      uniqueKey: [RECORD_DATE, ...dims],
      nonNull:   [RECORD_DATE],
    },
  })
    .preOps((ctx) => ctx.when(ctx.incremental(), incrementalPreOps(ctx, e)))
    .query((ctx) => dailySQL(ctx, name, m, { incremental: ctx.incremental() }));
});
