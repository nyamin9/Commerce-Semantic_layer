// SQL builder. 정책이 실제로 집행되는 곳이다.
//   P11  daily_ 와 metric_ 둘 다 재집계 가능한 형태로 저장한다
//   P12  비율도 증감률도 컬럼으로 저장하지 않는다
//   P14  비교는 기준값만. 날짜 조인으로 만들고 LAG를 쓰지 않는다
//   P15  누적(WTD·MTD·YTD)은 저장하지 않는다. 소비 시점에 daily 구간 합으로 낸다
//   P17  기계적인 것은 생성한다
//   P18  틀린 결과를 내느니 거부한다
//
// 이 파일은 초기에 한 번 쓰고 거의 건드리지 않는다.

const { ENTITIES, allDims, allJoins } = require("includes/entities");
const { PERIODS, COMPARE_LABELS } = require("includes/periods");
const { dailyName, periodName, baseColumn } = require("includes/naming");

// ── 공통 ──────────────────────────────────────────────────────
const seq = (n) => Array.from({ length: n }, (_, i) => i + 1).join(", ");

// 차원이 NULL이면 = 비교가 false가 되어 그 행이 통째로 사라진다 (P: 차원 NULL).
// GoogleSQL의 IS NOT DISTINCT FROM 은 NULL = NULL 을 TRUE 로 본다.
// COALESCE(CAST(...)) 로 감싸면 조인 키가 sargable 하지 않아 손해만 본다.
const eqNullSafe = (l, r) => `${l} IS NOT DISTINCT FROM ${r}`;

// ── 선언 검증 — 런타임이 아니라 컴파일 타임에 잡는다 (P19) ────
function resolveDims(name, m) {
  const e = ENTITIES[m.entity];
  if (!e) throw new Error(`[${name}] 알 수 없는 entity: ${m.entity}`);

  const dims = m.dims || allDims(m.entity);

  return dims.map((d) => {
    const def = e.dims[d];
    if (!def) {
      throw new Error(
        `[${name}] entity '${m.entity}'의 join graph에 차원 '${d}'가 없다. ` +
        `사용 가능: ${allDims(m.entity).join(", ")}`
      );
    }
    if (!(d in m.additive)) {
      throw new Error(`[${name}] 차원 '${d}'의 가산성이 선언되지 않았다 (P9)`);
    }
    if (m.additive[d] === false) {
      throw new Error(
        `[${name}] 차원 '${d}'가 비가산이다. entity를 옮기거나 스케치로 바꾼다 (P10)`
      );
    }
    if (def.via && !(def.via in (e.joins || {}))) {
      throw new Error(
        `[${name}] 차원 '${d}'의 via '${def.via}'가 joins에 없다. ` +
        `사용 가능: ${allJoins(m.entity).join(", ")}`
      );
    }
    return { name: d, ...def };
  });
}

// ── 지표 수식 (P5) ───────────────────────────────────────────
// 컬럼은 중괄호로 표시한다. renderExpr 는 그 안쪽만 건드린다.
//
//   {sale_price}          →  base.sale_price        fact 컬럼
//   {product.unit_cost}   →  product.unit_cost      조인해서 오는 컬럼
//
// 중괄호 밖은 그대로 둔다. 문자열 리터럴·타입명·백틱 식별자를 해석할 필요가
// 없어서, 수식에 어떤 SQL이 와도 안전하다.
//
// 접두사가 없으면 조인한 dim 과 이름이 겹치는 순간 모호해진다 — unit_cost 는
// fact 와 sem_dim_products 양쪽에, user_id 는 fact 와 sem_dim_users 양쪽에 있다.
// dataform compile 은 문자열이라 통과시키고 BigQuery 실행 단계에서야 터진다.
//
// product 는 entities.js 에 적힌 조인 이름이지 builder 가 만든 이름이 아니다.
// 선언이 builder 내부를 모르게 둔다.
const COLUMN_REF = /\{\s*([A-Za-z_][A-Za-z0-9_]*)(?:\.([A-Za-z_][A-Za-z0-9_]*))?\s*\}/g;

// 수식이 참조한 조인 이름. 차원이 안 쓰는 조인이라도 여기 나오면 붙여야 한다
function exprJoins(name, m, sql, where) {
  const used = new Set();
  for (const [, head, tail] of sql.matchAll(COLUMN_REF)) {
    if (!tail) continue;                                   // {col} 은 fact 컬럼
    if (!(head in (ENTITIES[m.entity].joins || {}))) {
      throw new Error(
        `[${name}] ${where} 의 '${head}.${tail}' — 조인 '${head}'가 선언되지 않았다. ` +
        `사용 가능: ${allJoins(m.entity).join(", ") || "없음"} (P6)`
      );
    }
    used.add(head);
  }
  return used;
}

function renderExpr(name, m, sql, where) {
  const out = sql.replace(COLUMN_REF, (_, head, tail) =>
    tail ? `${head}.${tail}` : `base.${head}`);

  // 짝이 안 맞는 중괄호는 치환되지 않고 그대로 남는다. 조용히 넘기면
  // SQL 문법 오류가 실행 시점에야 나온다 (P19)
  if (/[{}]/.test(out)) {
    throw new Error(`[${name}] ${where} 에 닫히지 않은 중괄호가 있다: ${sql}`);
  }
  return out;
}

// 조인 이름이 그대로 SQL alias 가 되므로 예약어면 생성된 쿼리가 깨진다.
// GoogleSQL 예약어 78개 — zetasql/docs/lexical.md 의 Reserved keywords.
// order 가 여기 들어 있다. entity 이름으로는 괜찮지만 조인 이름으로는 못 쓴다
const RESERVED = new Set([
  "ALL", "AND", "ANY", "ARRAY", "AS", "ASC", "ASSERT_ROWS_MODIFIED", "AT",
  "BETWEEN", "BY", "CASE", "CAST", "COLLATE", "CONTAINS", "CREATE", "CROSS",
  "CUBE", "CURRENT", "DEFAULT", "DEFINE", "DESC", "DISTINCT", "ELSE", "END",
  "ENUM", "ESCAPE", "EXCEPT", "EXCLUDE", "EXISTS", "EXTRACT", "FALSE",
  "FETCH", "FOLLOWING", "FOR", "FROM", "FULL", "GRAPH_TABLE", "GROUP",
  "GROUPING", "GROUPS", "HASH", "HAVING", "IF", "IGNORE", "IN", "INNER",
  "INTERSECT", "INTERVAL", "INTO", "IS", "JOIN", "LATERAL", "LEFT", "LIKE",
  "LIMIT", "LOOKUP", "MERGE", "NATURAL", "NEW", "NO", "NOT", "NULL",
  "NULLS", "OF", "ON", "OR", "ORDER", "OUTER", "OVER", "PARTITION",
  "PRECEDING", "PROTO", "QUALIFY", "RANGE", "RECURSIVE", "RESPECT", "RIGHT",
  "ROLLUP",
]);

// 선언 순서대로, 실제로 쓰이는 조인만. 이름이 곧 SQL alias 다
function resolveJoins(name, m, dims) {
  const e    = ENTITIES[m.entity];
  const used = new Set(dims.filter((d) => d.via).map((d) => d.via));

  for (const j of Object.keys(e.joins || {})) {
    if (j === "base") {
      throw new Error(`[${name}] 조인 이름 'base'는 fact 의 alias 와 겹친다`);
    }
    if (RESERVED.has(j.toUpperCase())) {
      throw new Error(`[${name}] 조인 이름 '${j}'는 GoogleSQL 예약어라 alias 로 쓸 수 없다`);
    }
  }

  for (const j of exprJoins(name, m, m.expr, "expr")) used.add(j);
  if (m.filter) for (const j of exprJoins(name, m, m.filter, "filter")) used.add(j);

  return Object.keys(e.joins || {})
    .filter((j) => used.has(j))
    .map((j) => ({ name: j, ...e.joins[j] }));
}

const dimSelect = (d) =>
  d.via ? `${d.via}.${d.col} AS ${d.name}` : `base.${d.col} AS ${d.name}`;

const joinClause = (ctx, j) =>
  `LEFT JOIN ${ctx.ref(j.to)} AS ${j.name}\n` +
  `  ON base.${j.key} = ${j.name}.${j.ref_key || j.key}`;

// ── 증분 구간 (insert_overwrite) ──────────────────────────────
// MERGE 는 지우지 않는다. dim 속성이 바뀌면 (dt, 차원) 키가 달라져서 옛 행이
// 매칭되지 않고 그대로 남는다 — 유령 행이 되어 합계가 부푼다. uniqueKey
// assertion 도 못 잡는다. 키는 여전히 유일하기 때문이다 (2026-09-13 실측 3,933행).
//
// 그래서 구간을 통째로 지우고 다시 넣는다. dbt 의 insert_overwrite 와 같은 모양이다.
//
// 경계를 변수로 고정하는 이유 — DELETE 가 MAX(dt) 를 바꾸므로 DELETE 와 본 쿼리가
// 각자 계산하면 서로 다른 구간을 보고 그 사이가 중복되거나 빈다.
//
// LEAST 를 쓰는 이유 — 상류 raw 는 [ds-3, ds] 만 덮어쓰지만, 우리가 며칠 쉬면
// 그 사이 날짜도 새로 들어온다. 소스 기준만 쓰면 그 구간이 빈 채로 남는다.
//   정상   우리 max ≈ 소스 max  →  소스 max - 3 부터
//   밀림   우리 max ≪ 소스 max  →  우리 max - 3 부터. 빈 구간이 안 생긴다
const LOOKBACK_DAYS = 3;
const CUTOFF_VAR    = "reprocess_from";

function incrementalPreOps(ctx, e) {
  return `DECLARE ${CUTOFF_VAR} DATE DEFAULT (
  SELECT DATE_SUB(
    LEAST(COALESCE(MAX(dt), DATE "1900-01-01"),
          (SELECT MAX(${e.date_col}) FROM ${ctx.ref(e.source)})),
    INTERVAL ${LOOKBACK_DAYS} DAY)
  FROM ${ctx.self()}
);
---
DELETE FROM ${ctx.self()} WHERE dt >= ${CUTOFF_VAR}`;
}

const incrementalWhere = (e) => `base.${e.date_col} >= ${CUTOFF_VAR}`;

// ── 1단계: daily — 조인이 실행되는 유일한 곳 (P5) ─────────────
// incremental 은 gen_daily.js 가 ctx.incremental() 을 그대로 넘긴다.
// 첫 적재에서는 false 라 조건이 붙지 않고 전 기간을 만든다.
function dailySQL(ctx, name, m, { incremental = false } = {}) {
  const e     = ENTITIES[m.entity];
  const dims  = resolveDims(name, m);
  const joins = resolveJoins(name, m, dims);

  const conds = [];
  if (m.filter)   conds.push(renderExpr(name, m, m.filter, "filter"));
  if (incremental) conds.push(incrementalWhere(e));

  return `
SELECT
  base.${e.date_col} AS dt,
  ${dims.map(dimSelect).join(",\n  ")},
  ${renderExpr(name, m, m.expr, "expr")} AS ${name}
FROM ${ctx.ref(e.source)} AS base
${joins.map((j) => joinClause(ctx, j)).join("\n")}
${conds.length ? `WHERE ${conds.join("\n  AND ")}` : ""}
GROUP BY ${seq(dims.length + 1)}`.trim();
}

// ── 롤업 방법 — additive 가 함수를 고른다. null 이면 생성 거부 (P18) ─
function rollupExpr(col, additive) {
  switch (additive) {
    case true:     return `SUM(${col})`;
    // 스케치는 스케치로 남긴다. MERGE 로 정수를 만들면 더 롤업할 수 없다 (P11)
    case "sketch": return `HLL_COUNT.MERGE_PARTIAL(${col})`;
    case "last":   return `ANY_VALUE(${col} HAVING MAX dt)`;
    default:       return null;
  }
}

// passthrough 는 접지 않으므로 롤업 함수가 필요 없다.
//
// 누계는 창 함수로 만드는데 BigQuery 가 HLL_COUNT.MERGE_PARTIAL 을 analytic
// function 으로 지원하지 않는다. 그래서 스케치 지표는 누계를 만들지 않는다 (P18).
//   dry run 은 통과하고 실행에서 "Analytic function MERGE_PARTIAL is not
//   supported" 로 떨어진다 — 컴파일로도 dry run 으로도 못 잡는다.
//
// 누계 distinct 가 필요하면 소비 시점에 daily_ 스케치를 구간 병합한다.
// 임의 구간이 되므로 오히려 달력 경계보다 자유롭다.
const canRollup = (m, pName) => {
  const t = PERIODS[pName].type;
  if (t === "passthrough") return true;
  if (t === "cumulative")  return m.additive.time === true;
  return rollupExpr("x", m.additive.time) !== null;
};

// 이 지표가 만들 수 있는 기간. additive.time 이 롤업 불가면 daily 만 남는다 (P10-3)
const usablePeriods = (m) => Object.keys(PERIODS).filter((pName) => canRollup(m, pName));

// 라벨 → [[기간, 간격], ...] 중 이 지표가 만들 수 있는 것만.
// metricSQL 이 조인을 만들 때와 gen_metric.js 가 컬럼을 문서화할 때 같은 규칙을 써야
// 한다. 두 곳에 따로 쓰면 언젠가 어긋나고, 어긋나도 아무도 모른다 (P19)
function applicableCompares(m) {
  const usable = usablePeriods(m);
  const acc = [];

  for (const [label, byPeriod] of Object.entries(COMPARE_LABELS)) {
    const applicable = Object.entries(byPeriod).filter(([pName]) => usable.includes(pName));
    if (applicable.length) acc.push([label, applicable]);
  }
  return acc;
}

// ── 2단계: metric — 기간 확장 + 비교 기준값 ───────────────────
// period_type 별 한 블록을 UNION ALL 한다.
// period_start 는 기간의 시작일, as_of_date 는 종료일이다 (P13).
function rollupBlock(name, m, dims, pName) {
  const p    = PERIODS[pName];
  const cols = dims.join(", ");

  if (p.type === "passthrough") {
    return `
SELECT '${pName}' AS period_type, dt AS period_start, dt AS as_of_date, ${cols}, ${name}
FROM daily`;
  }

  // 누계는 접지 않는다. 기간 시작부터 그날까지를 창 함수로 누적하므로 행 수가
  // daily 와 같고, as_of_date 가 달력 끝이 아니라 그날이다 (P13).
  //
  // 롤업 함수를 그대로 창 함수로 쓴다 — SUM 도 HLL_COUNT.MERGE_PARTIAL 도
  // BigQuery 에서 analytic function 으로 동작한다.
  if (p.type === "cumulative") {
    const part = [...dims, `DATE_TRUNC(dt, ${p.trunc})`].join(", ");
    return `
SELECT '${pName}', DATE_TRUNC(dt, ${p.trunc}), dt, ${cols},
       ${rollupExpr(name, m.additive.time)} OVER (PARTITION BY ${part} ORDER BY dt)
FROM daily`;
  }

  return `
SELECT '${pName}', DATE_TRUNC(dt, ${p.trunc}), LAST_DAY(dt, ${p.trunc}), ${cols},
       ${rollupExpr(name, m.additive.time)}
FROM daily
GROUP BY ${seq(dims.length + 3)}`;
}

// ── 2단계: period — 기간 확장 ────────────────────────────────
// 예전에는 metricSQL 안의 rolled CTE 였다. 테이블로 떼어낸 이유는 하나다.
//
// CTE 는 이름 붙인 서브쿼리라 결과를 저장하지 않는다. metricSQL 이 rolled 를
// 다섯 번 참조하므로(본 쿼리 1 + 비교 조인 4) 같은 집계가 다섯 번 돌았다.
// 차원 7개 지표에서 CPU 3,600초를 써 BigQuery on-demand 의 CPU/바이트 비율
// 제한에 걸렸다 — 스캔은 14 MB 라 비용이 아니라 낭비가 문제였다 (2026-09-13).
//
// 조인 술어를 바꿔도 변하지 않았고(= · COALESCE · IS NOT DISTINCT FROM 전부
// 3,600대) 물화하니 통과했다. 한 번만 계산하게 하는 것이 해법이다.
function periodSQL(ctx, name, m) {
  const dims   = resolveDims(name, m).map((d) => d.name);
  const usable = usablePeriods(m);

  if (usable.length === 0) {
    throw new Error(`[${name}] 생성 가능한 기간이 없다. additive.time을 확인한다`);
  }

  const blocks = usable.map((pName) => rollupBlock(name, m, dims, pName)).join("\nUNION ALL");

  return `
WITH daily AS (
  SELECT * FROM ${ctx.ref(dailyName(name))}
)
${blocks.trim()}`.trim();
}

// ── 3단계: metric — 비교 기준값 ──────────────────────────────
// period_ 를 시프트해 자기 자신과 조인한다. 물리 테이블이라 재계산이 없다.
function metricSQL(ctx, name, m) {
  const dims = resolveDims(name, m).map((d) => d.name);
  const src  = ctx.ref(periodName(name));

  // 비교 기준값. 증감률이 아니라 시프트한 행의 값을 복사한다 (P12·P14).
  // 해당 라벨을 선언한 period_type 행에서만 채워지고 나머지는 NULL 이다.
  const joins = [];
  const cols  = [];
  for (const [label, applicable] of applicableCompares(m)) {
    const a   = `b_${label}`;
    const in_ = applicable.map(([pName]) => `'${pName}'`).join(", ");

    // period_start 가 아니라 as_of_date 를 시프트한다.
    //
    // 누계는 같은 period_start 에 cutoff 가 여러 개다 — mtd 8/01 행이 지난달의
    // 모든 cutoff(7/01~7/31)에 매칭되면 틀린다. (period_type, as_of_date) 가
    // 차원 조합마다 유일하므로 그쪽이 맞는 기준이다.
    //
    // 완결 기간은 결과가 같다. DATE_SUB 이 월말을 보정한다 —
    // 2026-03-31 - 1 MONTH = 2026-02-28 로 2월 monthly 행과 맞는다.
    //
    // 간격이 기간마다 다르다. weekly YoY 는 364일이어야 주 시작일에 떨어진다
    const shift = applicable.length === 1
      ? `DATE_SUB(c.as_of_date, INTERVAL ${applicable[0][1]})`
      : `CASE c.period_type\n` +
        applicable.map(([pName, iv]) =>
          `      WHEN '${pName}' THEN DATE_SUB(c.as_of_date, INTERVAL ${iv})`).join("\n") +
        `\n    END`;

    joins.push(
      `LEFT JOIN ${src} AS ${a}\n` +
      `  ON c.period_type IN (${in_})\n` +
      ` AND ${a}.period_type = c.period_type\n` +
      ` AND ${a}.as_of_date = ${shift}\n` +
      dims.map((d) => ` AND ${eqNullSafe(`${a}.${d}`, `c.${d}`)}`).join("\n")
    );
    cols.push(`${a}.${name} AS ${baseColumn(label)}`);
  }

  return `
SELECT
  c.period_type,
  c.period_start,
  c.as_of_date,
  ${dims.map((d) => `c.${d}`).join(",\n  ")},
  c.${name},
  ${cols.join(",\n  ")}
FROM ${src} AS c
${joins.join("\n")}`.trim();
}


module.exports = {
  seq, eqNullSafe, renderExpr, exprJoins, LOOKBACK_DAYS, incrementalPreOps,
  usablePeriods, applicableCompares, periodSQL,
  resolveDims, resolveJoins, rollupExpr, canRollup,
  dailySQL, metricSQL,
};
