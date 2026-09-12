// SQL 조립기. 정책이 실제로 집행되는 곳이다.
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
const { dailyName, baseColumn }   = require("includes/naming");

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
// 컬럼은 중괄호로 표시한다. 생성기는 그 안쪽만 건드린다.
//
//   {sale_price}          →  base.sale_price        fact 컬럼
//   {product.unit_cost}   →  product.unit_cost      조인해서 오는 컬럼
//
// 중괄호 밖은 그대로 둔다. 문자열 리터럴·타입명·백틱 식별자를 해석할 필요가
// 없어서, 수식에 어떤 SQL이 와도 안전하다.
//
// 한정자가 없으면 조인한 dim 과 이름이 겹치는 순간 모호해진다 — unit_cost 는
// fact 와 sem_dim_products 양쪽에, user_id 는 fact 와 sem_dim_users 양쪽에 있다.
// dataform compile 은 문자열이라 통과시키고 BigQuery 실행 단계에서야 터진다.
//
// product 는 entities.js 에 적힌 조인 이름이지 생성기의 내부 별칭이 아니다.
// 선언이 조립 방식을 알게 되지 않는다.
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

// 조인 이름이 그대로 SQL 별칭이 되므로 예약어면 생성된 쿼리가 깨진다.
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

// 선언 순서대로, 실제로 쓰이는 조인만. 이름이 곧 SQL 별칭이다
function resolveJoins(name, m, dims) {
  const e    = ENTITIES[m.entity];
  const used = new Set(dims.filter((d) => d.via).map((d) => d.via));

  for (const j of Object.keys(e.joins || {})) {
    if (j === "base") {
      throw new Error(`[${name}] 조인 이름 'base'는 fact 별칭과 겹친다`);
    }
    if (RESERVED.has(j.toUpperCase())) {
      throw new Error(`[${name}] 조인 이름 '${j}'는 GoogleSQL 예약어라 별칭으로 쓸 수 없다`);
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

// ── 1단계: daily — 조인이 실행되는 유일한 곳 (P5) ─────────────
function dailySQL(ctx, name, m) {
  const e     = ENTITIES[m.entity];
  const dims  = resolveDims(name, m);
  const joins = resolveJoins(name, m, dims);


  return `
SELECT
  base.${e.date_col} AS dt,
  ${dims.map(dimSelect).join(",\n  ")},
  ${renderExpr(name, m, m.expr, "expr")} AS ${name}
FROM ${ctx.ref(e.source)} AS base
${joins.map((j) => joinClause(ctx, j)).join("\n")}
${m.filter ? `WHERE ${renderExpr(name, m, m.filter, "filter")}` : ""}
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

const canRollup = (m, pName) =>
  PERIODS[pName].type === "passthrough" || rollupExpr("x", m.additive.time) !== null;

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

  return `
SELECT '${pName}', DATE_TRUNC(dt, ${p.trunc}), LAST_DAY(dt, ${p.trunc}), ${cols},
       ${rollupExpr(name, m.additive.time)}
FROM daily
GROUP BY ${seq(dims.length + 3)}`;
}

function metricSQL(ctx, name, m) {
  const dims   = resolveDims(name, m).map((d) => d.name);
  const usable = Object.keys(PERIODS).filter((pName) => canRollup(m, pName));

  if (usable.length === 0) {
    throw new Error(`[${name}] 생성 가능한 기간이 없다. additive.time을 확인한다`);
  }

  const blocks = usable.map((pName) => rollupBlock(name, m, dims, pName)).join("\nUNION ALL");

  // 비교 기준값. 증감률이 아니라 시프트한 행의 값을 복사한다 (P12·P14).
  // 해당 라벨을 선언한 period_type 행에서만 채워지고 나머지는 NULL 이다.
  const joins = [];
  const cols  = [];
  for (const [label, byPeriod] of Object.entries(COMPARE_LABELS)) {
    const applicable = Object.entries(byPeriod).filter(([pName]) => usable.includes(pName));
    if (applicable.length === 0) continue;

    const a  = `b_${label}`;
    const in_ = applicable.map(([pName]) => `'${pName}'`).join(", ");

    // 간격이 기간마다 다르다. weekly YoY 는 364일이어야 주 시작일에 떨어진다
    const shift = applicable.length === 1
      ? `DATE_SUB(c.period_start, INTERVAL ${applicable[0][1]})`
      : `CASE c.period_type\n` +
        applicable.map(([pName, iv]) =>
          `      WHEN '${pName}' THEN DATE_SUB(c.period_start, INTERVAL ${iv})`).join("\n") +
        `\n    END`;

    joins.push(
      `LEFT JOIN rolled AS ${a}\n` +
      `  ON c.period_type IN (${in_})\n` +
      ` AND ${a}.period_type = c.period_type\n` +
      ` AND ${a}.period_start = ${shift}\n` +
      dims.map((d) => ` AND ${eqNullSafe(`${a}.${d}`, `c.${d}`)}`).join("\n")
    );
    cols.push(`${a}.${name} AS ${baseColumn(label)}`);
  }

  return `
WITH daily AS (
  SELECT * FROM ${ctx.ref(dailyName(name))}
),
rolled AS (${blocks}
)
SELECT
  c.period_type,
  c.period_start,
  c.as_of_date,
  ${dims.map((d) => `c.${d}`).join(",\n  ")},
  c.${name},
  ${cols.join(",\n  ")}
FROM rolled AS c
${joins.join("\n")}`.trim();
}

module.exports = {
  seq, eqNullSafe, renderExpr, exprJoins,
  resolveDims, resolveJoins, rollupExpr, canRollup,
  dailySQL, metricSQL,
};
