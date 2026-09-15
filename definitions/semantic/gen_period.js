// period_<metric> 생성. daily_ 를 기간 4종으로 펼친다.
//
// metric_ 안의 rolled CTE 였던 것을 테이블로 떼어냈다. CTE 는 결과를 저장하지
// 않아 metric_ 이 다섯 번 참조하면 같은 집계가 다섯 번 돌았다 — 여기서 한 번만
// 계산하고 metric_ 은 이 테이블을 읽는다 (근거는 build.js 의 periodSQL 주석).
//
// 비교 없이 기간별 집계만 필요한 소비자는 여기서 끝난다. metric_ 까지 갈 이유가 없다.
//
// 전부 table 이다 (P22). 하루가 늘면 그 주·월·연 행이 다시 계산된다.

const { METRICS }                = require("includes/metrics");
const { ENTITIES }               = require("includes/entities");
const { periodName }             = require("includes/naming");
const { periodSQL, resolveDims } = require("includes/build");

Object.entries(METRICS).forEach(([name, m]) => {
  const e      = ENTITIES[m.entity];
  const dims   = resolveDims(name, m).map((d) => d.name);
  const sketch = m.additive.time === "sketch";

  const columns = {
    period_type:  "daily · weekly · monthly · yearly. 한 테이블에 4종이 들어간다",
    period_start: "기간 시작일",
    as_of_date:   "기간 종료일 (P13)",
    [name]: sketch
      ? `${m.description} — HLL 스케치(BYTES). 값을 보려면 HLL_COUNT.EXTRACT (P11)`
      : m.description,
  };
  for (const d of dims) columns[d] = `차원. ${e.dims[d].via || "fact 자체 컬럼"}`;

  publish(periodName(name), {
    type:        "table",
    schema:      "semantic",
    tags:        ["semantic", "period"],
    description: `${m.description} — 기간 4종 확장. metric_ 의 재료`,
    columns,

    // as_of_date 로 자른다. 비교 조인이 이 컬럼으로 맞고, 누계 조회도
    // "8/14 기준" 처럼 as_of_date 를 건다
    bigquery: { partitionBy: "as_of_date" },

    // 키는 as_of_date 다. 누계는 같은 period_start 에 cutoff 가 여러 개라
    // (mtd 8/01 은 8/01~8/31 의 31행) period_start 로는 유일하지 않다.
    // period_type 도 들어가야 한다 — 2026-03-02 은 그날이면서 그 주의 시작일이다
    assertions: {
      uniqueKey: ["period_type", "as_of_date", ...dims],
      nonNull:   ["period_type", "period_start", "as_of_date"],
    },
  }).query((ctx) => periodSQL(ctx, name, m));
});
