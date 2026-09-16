// metric_registry — 지표 카탈로그. 선언을 BigQuery 테이블로 테이블로 저장한 것이다.
//
// 선언이 JS 파일에만 있으면 어떤 쿼리로도 읽을 수 없다. registry 가 있으면
// "net_revenue 가 무엇인가" 를 SQL 로 답할 수 있다.
//
// 테이블을 하나도 참조하지 않는다. ref() 가 없는 유일한 generator 다 —
// 선언만 읽어 리터럴로 만든다.
//
// 세 종류가 한 테이블에 들어간다 (P17).
//   METRICS   테이블이 생성된다                      is_generated = true
//   RATIOS    테이블을 만들지 않는다 (P12)           is_generated = false
//   EXCLUDED  의도적으로 만들지 않는다. 사유를 남긴다 is_generated = false
//
// "생성되지 않았다" 와 "존재하지 않는다" 는 다르다. 비율 7개와 제외 5개는
// registry 가 유일한 거처다.

const { METRICS, RATIOS, EXCLUDED } = require("includes/metrics");
const { ENTITIES, allDims }          = require("includes/entities");
const { valueColumns, comparePlan, servingAxes, resolveDims } = require("includes/build");

// ── SQL 리터럴 ────────────────────────────────────────────────
// expr 에 작은따옴표가 들어 있다 — COUNTIF({order_item_status} = 'returned').
// 그대로 붙이면 문자열이 거기서 끊긴다
const lit = (v) =>
  v === undefined || v === null
    ? null
    : `'${String(v).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

const str   = (v) => lit(v) || "CAST(NULL AS STRING)";
const arr   = (xs) => (xs && xs.length ? `[${xs.map(lit).join(", ")}]` : "CAST([] AS ARRAY<STRING>)");
const bool  = (v) => (v ? "TRUE" : "FALSE");

// ── 이름 충돌은 컴파일 타임에 잡는다 (P19) ────────────────────
const seen = new Set();
const claim = (name, where) => {
  if (seen.has(name)) {
    throw new Error(`[metric_registry] 지표 이름 '${name}' 이 ${where} 에서 중복 선언되었다`);
  }
  seen.add(name);
};

const row = (o) => `  STRUCT(
    ${str(o.metric_name)} AS metric_name,
    ${str(o.metric_type)} AS metric_type,
    ${str(o.description)} AS description,
    ${str(o.entity)} AS entity,
    ${str(o.entity_grain)} AS entity_grain,
    ${str(o.expression)} AS expression,
    ${str(o.filter)} AS filter,
    ${arr(o.dimensions)} AS dimensions,
    ${str(o.additive_by_axis)} AS additive_by_axis,
    ${arr(o.serving_dims)} AS serving_dims,
    ${arr(o.value_columns)} AS value_columns,
    ${arr(o.compare_columns)} AS compare_columns,
    ${str(o.numerator)} AS numerator,
    ${str(o.denominator)} AS denominator,
    ${bool(o.is_approximate)} AS is_approximate,
    ${bool(o.is_generated)} AS is_generated,
    ${str(o.serving_table)} AS serving_table,
    ${str(o.exclusion_reason)} AS exclusion_reason
  )`;

const rows = [];

// 기본 지표 — 테이블이 생성된다
for (const [name, m] of Object.entries(METRICS)) {
  claim(name, "METRICS");
  const e = ENTITIES[m.entity];

  rows.push(row({
    metric_name:      name,
    metric_type:      "base",
    description:      m.description,
    entity:           m.entity,
    entity_grain:     e.grain,
    expression:       m.expr,          // 선언 원문. 실행 SQL 이 아니다
    filter:           m.filter,
    dimensions:       resolveDims(name, m).map((d) => d.name),
    additive_by_axis: JSON.stringify(m.additive),
    serving_dims:     servingAxes(name, m),
    value_columns:    valueColumns(name, m),
    compare_columns:  comparePlan(m).map((c) => c.column),
    is_approximate:   m.additive.time === "sketch",
    is_generated:     true,
    serving_table:    `semantic.metric_${name}`,
  }));
}

// 비율 지표 — 테이블을 만들지 않는다. 나눗셈은 소비 시점에 (P12).
// 유효 dimension은 분자·분모의 교집합이다. 교집합이 비면 그 조합은 정의되지 않는다
for (const [name, r] of Object.entries(RATIOS)) {
  claim(name, "RATIOS");
  const n = METRICS[r.numerator];
  const d = METRICS[r.denominator];
  if (!n || !d) {
    throw new Error(`[metric_registry] 비율 '${name}' 의 분자·분모가 METRICS 에 없다`);
  }
  const nd = new Set(resolveDims(r.numerator, n).map((x) => x.name));

  rows.push(row({
    metric_name:    name,
    metric_type:    "ratio",
    description:    r.description,
    dimensions:     resolveDims(r.denominator, d).map((x) => x.name).filter((x) => nd.has(x)),
    numerator:      r.numerator,
    denominator:    r.denominator,
    is_approximate: !!r.approximate,
    is_generated:   false,
  }));
}

// 제외 지표 — 만들지 않기로 한 것과 그 사유 (P17·P21)
for (const [name, x] of Object.entries(EXCLUDED)) {
  claim(name, "EXCLUDED");
  rows.push(row({
    metric_name:      name,
    metric_type:      "excluded",
    is_generated:     false,
    is_approximate:   false,
    exclusion_reason: x.reason,
  }));
}

publish("metric_registry", {
  type:        "table",
  schema:      "semantic_metadata",
  tags:        ["semantic", "metadata"],
  description: `지표 카탈로그. 기본 ${Object.keys(METRICS).length} · ` +
               `비율 ${Object.keys(RATIOS).length} · 제외 ${Object.keys(EXCLUDED).length}`,
  columns: {
    metric_name:      "지표 이름. PK",
    metric_type:      "base · ratio · excluded",
    description:      "설명문",
    entity:           "산출 fact. ratio · excluded 는 NULL",
    entity_grain:     "그 fact 의 grain",
    expression:       "집계식. metrics.js 선언 원문이라 {} 표기가 남아 있다 (P5-2)",
    filter:           "집계 전 행 필터",
    dimensions:       "daily_ 가 가진 dimension 전체. ratio 는 분자·분모의 교집합이다 (P12)",
    additive_by_axis: "축별 가산성 JSON. true · \"sketch\" · \"last\" (P9)",
    serving_dims:     "metric_ 의 grain. 각 축의 '(all)' rollup 행까지 만들어져 있다 (P4)",
    value_columns:    "metric_ 의 값 컬럼. 접두어가 없으면 daily 다 (P13). 누계 불가면 daily 하나뿐 (P10-3)",
    compare_columns:  "붙은 비교 기준값 컬럼. 증감률이 아니다 (P14)",
    numerator:        "ratio 전용. 분자 지표 이름",
    denominator:      "ratio 전용. 분모 지표 이름",
    is_approximate:   "HLL sketch를 쓰는가. 분모가 sketch인 비율도 포함",
    is_generated:     "테이블이 생성되었는가. false 여도 존재는 한다 (P17)",
    serving_table:    "조회할 테이블. is_generated 가 false 면 NULL",
    exclusion_reason: "excluded 전용. 만들지 않기로 한 사유 (P21)",
  },
  assertions: {
    uniqueKey: ["metric_name"],
    nonNull:   ["metric_name", "metric_type", "is_generated"],
    rowConditions: [
      "(metric_type = 'ratio') = (numerator IS NOT NULL)",
      "(is_generated) = (serving_table IS NOT NULL)",
    ],
  },
}).query(() => `SELECT * FROM UNNEST([\n${rows.join(",\n")}\n])`);
