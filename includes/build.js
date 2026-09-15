// SQL builder. 정책이 실제로 집행되는 곳이다.
//   P11  daily_ 와 metric_ 둘 다 재집계 가능한 형태로 저장한다
//   P12  비율도 증감률도 컬럼으로 저장하지 않는다
//   P14  비교는 기준값만. 날짜 조인으로 만들고 LAG를 쓰지 않는다
//   P15  누계(WTD·MTD·YTD)는 채운 격자 위에서 만든다. 희소하면 걷을 때 무너진다
//   P17  기계적인 것은 생성한다
//   P18  틀린 결과를 내느니 거부한다
//
// 이 파일은 초기에 한 번 쓰고 거의 건드리지 않는다.

const { ENTITIES, allDims, allJoins, servingDims } = require("includes/entities");
const { PERIODS, CUMULATIVE, END_FLAGS } = require("includes/periods");
const { dailyName, periodName, martName,
        RECORD_DATE, valueColumn, baseColumn } = require("includes/naming");

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
// MERGE 는 지우지 않는다. dim 속성이 바뀌면 (record_date, 차원) 키가 달라져서 옛 행이
// 매칭되지 않고 그대로 남는다 — 유령 행이 되어 합계가 부푼다. uniqueKey
// assertion 도 못 잡는다. 키는 여전히 유일하기 때문이다 (2026-09-13 실측 3,933행).
//
// 그래서 구간을 통째로 지우고 다시 넣는다. dbt 의 insert_overwrite 와 같은 모양이다.
//
// 경계를 변수로 고정하는 이유 — DELETE 가 MAX(record_date) 를 바꾸므로 DELETE 와 본 쿼리가
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
    LEAST(COALESCE(MAX(${RECORD_DATE}), DATE "1900-01-01"),
          (SELECT MAX(${e.date_col}) FROM ${ctx.ref(e.source)})),
    INTERVAL ${LOOKBACK_DAYS} DAY)
  FROM ${ctx.self()}
);
---
DELETE FROM ${ctx.self()} WHERE ${RECORD_DATE} >= ${CUTOFF_VAR}`;
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
  base.${e.date_col} AS ${RECORD_DATE},
  ${dims.map(dimSelect).join(",\n  ")},
  ${renderExpr(name, m, m.expr, "expr")} AS ${name}
FROM ${ctx.ref(e.source)} AS base
${joins.map((j) => joinClause(ctx, j)).join("\n")}
${conds.length ? `WHERE ${conds.join("\n  AND ")}` : ""}
GROUP BY ${seq(dims.length + 1)}`.trim();
}

// ── 접는 함수 — additive 가 고른다. null 이면 생성 거부 (P18) ─
function foldExpr(col, additive) {
  switch (additive) {
    case true:     return `SUM(${col})`;
    // 스케치는 스케치로 남긴다. MERGE 로 정수를 만들면 더 접을 수 없다 (P11)
    case "sketch": return `HLL_COUNT.MERGE_PARTIAL(${col})`;
    case "last":   return `ANY_VALUE(${col} HAVING MAX ${RECORD_DATE})`;
    default:       return null;
  }
}

// 차원 축으로 접을 때는 시간 축이 아니라 접히는 차원의 가산성이 함수를 고른다
// (P9). 축마다 다르면 한 컬럼으로 만들 수 없으므로 거부한다 (P18)
function dimFold(name, m, dims) {
  const kinds = new Set(dims.map((d) => m.additive[d]));
  if (kinds.size > 1) {
    throw new Error(
      `[${name}] 차원 축의 가산성이 섞여 있다: ${[...kinds].join(" · ")}. ` +
      `한 컬럼으로 접을 수 없다 (P9)`
    );
  }
  const kind = kinds.size ? [...kinds][0] : m.additive.time;
  if (foldExpr("x", kind) === null) {
    throw new Error(`[${name}] 차원 축 가산성 '${kind}' 는 접을 수 없다 (P10)`);
  }
  return kind;
}

// 누계를 만들 수 있는가. 가산은 창 함수로, 스케치는 구간 병합으로 만든다.
// 둘 다 아니면 daily 컬럼 하나만 남는다 (P10-3)
const canCumulate = (m) => m.additive.time === true || m.additive.time === "sketch";

// 이 지표가 만들 기간 컬럼. 선언 순서를 유지한다
const usablePeriods = (m) => (canCumulate(m) ? Object.keys(PERIODS) : ["daily"]);

// 값 컬럼 이름. gen_period · gen_metric · gen_registry 가 같은 규칙을 써야 한다.
// 세 곳에 따로 쓰면 언젠가 어긋나고, 어긋나도 아무도 모른다 (P19)
const valueColumns = (name, m) => usablePeriods(m).map((p) => valueColumn(name, p));

// 비교 기준값 계획. [{ period, label, interval, column }] 을 기간 선언 순서로.
// metricSQL 이 조인을 만들 때와 gen_metric.js 가 컬럼을 문서화할 때 같은 목록을 본다
function comparePlan(m) {
  const acc = [];
  for (const pName of usablePeriods(m)) {
    for (const [label, interval] of Object.entries(PERIODS[pName].compare)) {
      acc.push({ period: pName, label, interval, column: baseColumn(pName, label) });
    }
  }
  return acc;
}

// 서빙 테이블의 차원. 선언된 serving_dims 중 이 지표가 실제로 가진 것만 (P4).
// 여기 없는 축은 컬럼 자체가 생기지 않는다 — 값이 '(all)' 하나뿐이라 자리만 찬다
function servingAxes(name, m) {
  const have = new Set(resolveDims(name, m).map((d) => d.name));
  return servingDims(m.entity).filter((d) => have.has(d));
}

// 완결 플래그. record_date 에서 결정론적으로 나오므로 저장 비용만 든다.
//
//   monthly  =  mtd  where is_month_end
//
// 완결 기간의 롤업이 누계와 같은 값이라 rollup 기간을 따로 만들지 않는다.
// 실측으로 10,080 조합 전부 일치했다 (2026-09-16).
const endFlagNames = () => END_FLAGS.map((f) => f.name);

const endFlagSelect = (prefix = "") =>
  END_FLAGS.map((f) =>
    `${prefix}${RECORD_DATE} = LAST_DAY(${prefix}${RECORD_DATE}, ${f.trunc}) AS ${f.name}`);

const ALL = "(all)";

// ── 2단계: period — 기간을 가로로 편다 ───────────────────────
//
// 네 겹이다.
//   base    daily_ 를 serving_dims 로 접는다.              기저 조합만
//   grid    sem_dim_date × 조합 을 전부 만들고 값을 붙인다.  없으면 0 / NULL
//   cum     그 위에 누적한다.                              daily 는 그대로 통과
//   rollup  각 축의 '(all)' 행을 만든다.                    GROUPING SETS
//
// ── 접기가 누적보다 나중인 이유 ──────────────────────────────
// 순서를 바꿔도 값은 같다. SUM 은 결합법칙이 성립하고, HLL 병합은 합집합이라
// 조합별 WTD 스케치를 합친 것이 전체 WTD 스케치와 같다.
//
// 비용은 전혀 다르다. 먼저 접으면 '(all)' 행의 스케치가 조밀해지는데, 스케치
// 누계는 1년 구간을 자기조인해 병합하므로 그 조밀한 스케치를 하루당 180여 번씩
// 읽는다. buyer_count 가 CPU 1,748,227초를 써서 한도(5,100)에 걸렸다 (2026-09-16).
//
// 기저 조합에서 누적하면 스케치가 희소한 채로 조인되고, 접기는 누적이 끝난 뒤
// 집계 한 번으로 끝난다.
//
// ── grid 가 핵심인 이유 ──────────────────────────────────────
// 활동한 날에만 누계를 만들면 걷는 순간 대부분이 사라진다 — 실측으로 국가별
// MTD 가 실제의 13% 였다. 그날 안 팔린 조합의 앞 구간 매출이 통째로 빠지기
// 때문이다. 행을 만들어 두면 누적값이 앞 구간을 그대로 들고 간다.

// 기저 조합 — serving_dims 밖의 축을 접어 없앤다
function baseCTE(name, m, axes) {
  const fold = foldExpr(name, dimFold(name, m, resolveDims(name, m).map((d) => d.name)));
  const key  = [RECORD_DATE, ...axes];

  return `
  SELECT ${key.join(", ")}, ${fold} AS v
  FROM daily
  GROUP BY ${seq(key.length)}`;
}

// 날짜 뼈대는 sem_dim_date 다. daily_ 의 날짜를 쓰면 전사적으로 거래가 0인 날이
// 통째로 빠져 누계의 연속성이 끊긴다 — 실측으로 2,811일 중 44일이 그랬다.
// 빈 날짜를 행으로 만드는 것이 이 차원 테이블의 존재 이유다 (P15-1).
//
// 범위는 daily_ 가 가진 구간으로 자른다. 그러지 않으면 2018~2031 스파인 전체가
// 조합 수만큼 곱해지고, 데이터가 없는 미래 날짜에 행이 생긴다.
function gridCTE(ctx, m, axes) {
  const sketch = m.additive.time === "sketch";
  // 스케치는 없으면 NULL 로 둔다. MERGE 가 NULL 을 무시한다.
  // 가산은 0 이어야 누적이 앞 구간을 그대로 들고 간다
  const fill = sketch ? "a.v" : "COALESCE(a.v, 0)";

  return `
  SELECT d.${RECORD_DATE}, ${axes.map((x) => `c.${x}`).join(", ")}, ${fill} AS v
  FROM (
    SELECT date_day AS ${RECORD_DATE}
    FROM ${ctx.ref(martName("dim_date"))}
    WHERE date_day BETWEEN (SELECT MIN(${RECORD_DATE}) FROM daily)
                       AND (SELECT MAX(${RECORD_DATE}) FROM daily)
  ) d
  CROSS JOIN (SELECT DISTINCT ${axes.join(", ")} FROM base) c
  LEFT JOIN base a
    ON a.${RECORD_DATE} = d.${RECORD_DATE}
${axes.map((x) => `   AND ${eqNullSafe(`a.${x}`, `c.${x}`)}`).join("\n")}`;
}

// 가산 — 창 함수. 격자를 한 번만 읽고 누계 3종을 동시에 만든다.
// 기간별로 블록을 나누면 격자가 그만큼 재계산된다
function cumWindowed(name, axes) {
  const part = axes.length ? `${axes.join(", ")}, ` : "";
  const wins = CUMULATIVE.map((p) =>
    `    SUM(v) OVER (PARTITION BY ${part}DATE_TRUNC(${RECORD_DATE}, ${PERIODS[p].trunc}) ` +
    `ORDER BY ${RECORD_DATE}) AS ${valueColumn(name, p)}`);

  return `
  SELECT ${[RECORD_DATE, ...axes].join(", ")},
    v AS ${name},
${wins.join(",\n")}
  FROM grid`;
}

// 스케치 — HLL_COUNT.MERGE_PARTIAL 은 analytic function 을 지원하지 않는다.
// dry run 은 통과하고 실행에서 떨어진다. 컴파일로도 dry run 으로도 못 잡는다.
// 그래서 창 함수를 못 쓰고 [기간시작, 그날] 구간을 조인해 병합한다.
//
// 기간마다 블록을 따로 만들면 격자가 기간 수만큼 재계산되어 CPU 한도에 걸린다
// (실측 11,924초 / 한도 4,300). 그래서 가장 넓은 구간(ytd)으로 한 번만 조인하고
// 좁은 기간은 IF 로 걸러낸다 — 집계 함수가 NULL 을 무시하는 성질을 쓴다.
//
// periods.js 는 누계를 좁은 것부터 선언해야 한다. 마지막 것이 조인 범위가 된다.
function cumSketch(name, axes) {
  const widest = PERIODS[CUMULATIVE[CUMULATIVE.length - 1]].trunc;

  const merges = CUMULATIVE.map((p, i) => {
    const last = i === CUMULATIVE.length - 1;   // 조인 범위와 같아 IF 가 필요 없다
    const arg  = last
      ? "b.v"
      : `IF(b.${RECORD_DATE} >= DATE_TRUNC(g.${RECORD_DATE}, ${PERIODS[p].trunc}), b.v, NULL)`;
    return `    HLL_COUNT.MERGE_PARTIAL(${arg}) AS ${valueColumn(name, p)}`;
  });

  return `
  SELECT ${[RECORD_DATE, ...axes].map((c) => `g.${c}`).join(", ")},
    ANY_VALUE(g.v) AS ${name},
${merges.join(",\n")}
  FROM grid g
  LEFT JOIN base b
    ON b.${RECORD_DATE} BETWEEN DATE_TRUNC(g.${RECORD_DATE}, ${widest}) AND g.${RECORD_DATE}
${axes.map((x) => `   AND ${eqNullSafe(`b.${x}`, `g.${x}`)}`).join("\n")}
  GROUP BY ${seq(axes.length + 1)}`;
}

// 누계를 못 만드는 지표. daily 컬럼 하나만 내보낸다 (P10-3)
function cumNone(name, axes) {
  return `
  SELECT ${[RECORD_DATE, ...axes].join(", ")}, v AS ${name}
  FROM grid`;
}

// 마지막 겹 — 각 축의 '(all)' 행을 만든다.
//
// GROUPING SETS 를 쓰지 않는다. BigQuery 가 집합마다 입력을 다시 읽어서, 축이
// 4개면 cum 이 16번 재계산된다. cum 안에 1년 구간 자기조인이 들어 있는 스케치
// 지표에서 CPU 357,307초를 써 한도(5,100)에 걸렸다 (2026-09-16).
//
// 대신 마스크를 CROSS JOIN 으로 붙인다. cum 을 한 번만 읽고 행을 2^n 배로 펼친
// 뒤 한 번 집계한다. 비트가 0인 축이 '(all)' 이 된다.
//
//   mask 0b1111  country  age_group  gender  acq      기저 조합
//   mask 0b0001  country  (all)      (all)   (all)    country 별 롤업
//   mask 0b0000  (all)    (all)      (all)   (all)    전사
//
// 진짜 NULL 은 NULL 로 남는다. 마스크가 그 축을 살린 행에서는 원본 값이 그대로
// 오므로 "값이 없는 버킷"(P6-1)과 '(all)' 이 섞이지 않는다.
//
// 접는 함수는 차원 축 가산성이 고른다 (P9). 완결 플래그는 record_date 에서
// 결정론적으로 나오고 record_date 가 grouping key 라 여기서 같이 만든다
const ALL_MASK_VAR = "axis_mask";

function rollupSelect(name, m, axes) {
  const kind = dimFold(name, m, resolveDims(name, m).map((d) => d.name));

  const dims = axes.map((d, i) =>
    `  IF((${ALL_MASK_VAR} >> ${i}) & 1 = 1, cum.${d}, '${ALL}') AS ${d}`);
  const flags = END_FLAGS.map((f) =>
    `  cum.${RECORD_DATE} = LAST_DAY(cum.${RECORD_DATE}, ${f.trunc}) AS ${f.name}`);
  const vals = valueColumns(name, m).map((c) => `  ${foldExpr(`cum.${c}`, kind)} AS ${c}`);

  const masks = axes.length
    ? `\nCROSS JOIN UNNEST(GENERATE_ARRAY(0, ${(1 << axes.length) - 1})) AS ${ALL_MASK_VAR}`
    : "";

  return `
SELECT
  cum.${RECORD_DATE},
${[...dims, ...flags, ...vals].join(",\n")}
FROM cum${masks}
GROUP BY ${seq(axes.length + 1)}`;
}

function periodSQL(ctx, name, m) {
  const axes = servingAxes(name, m);

  const cum = !canCumulate(m) ? cumNone(name, axes)
            : m.additive.time === "sketch" ? cumSketch(name, axes)
            : cumWindowed(name, axes);

  return `
WITH daily AS (
  SELECT * FROM ${ctx.ref(dailyName(name))}
),
base AS (${baseCTE(name, m, axes).trim()}
),
grid AS (${gridCTE(ctx, m, axes).trim()}
),
cum AS (${cum.trim()}
)
${rollupSelect(name, m, axes).trim()}`.trim();
}

// ── 3단계: metric — 비교 기준값 ──────────────────────────────
// period_ 를 시프트해 자기 자신과 조인한다. 물리 테이블이라 재계산이 없다.
//
// CTE 로 두면 같은 집계가 조인 수만큼 돈다. 차원 7개 지표에서 CPU 3,600초를 써
// BigQuery on-demand 의 CPU/바이트 비율 제한에 걸렸다 — 스캔은 14 MB 라 비용이
// 아니라 낭비가 문제였다 (2026-09-13). 조인 술어를 바꿔도 변하지 않았고
// (= · COALESCE · IS NOT DISTINCT FROM 전부 3,600대) 물화하니 통과했다.
//
// 조인은 간격 단위로 묶는다. 비교 컬럼 8개가 서로 다른 시프트 5개
// (1 DAY · 1 WEEK · 1 MONTH · 1 YEAR · 364 DAY)에서 나오므로 조인도 5번이다.
//
// 간격이 기간마다 다르다. wtd 의 YoY 는 364일이어야 요일이 맞는다 —
// 2026-03-02(월)의 1년 전은 일요일이다.
//
// DATE_SUB 이 월말을 보정한다. 2026-03-31 - 1 MONTH = 2026-02-28 이라 월말
// mtd 끼리 맞물린다. 대신 3/30 과 3/31 이 둘 다 2/28 로 간다.
const shiftAlias = (interval) => `b_${interval.toLowerCase().replace(/\s+/g, "_")}`;

function metricSQL(ctx, name, m) {
  const axes = servingAxes(name, m);
  const src  = ctx.ref(periodName(name));
  const plan = comparePlan(m);

  // 간격 → 그 간격으로 가져올 비교 컬럼들
  const byInterval = new Map();
  for (const c of plan) {
    if (!byInterval.has(c.interval)) byInterval.set(c.interval, []);
    byInterval.get(c.interval).push(c);
  }

  const joins = [...byInterval.keys()].map((interval) => {
    const a = shiftAlias(interval);
    return `LEFT JOIN ${src} AS ${a}\n` +
           `  ON ${a}.${RECORD_DATE} = DATE_SUB(c.${RECORD_DATE}, INTERVAL ${interval})\n` +
           axes.map((d) => ` AND ${eqNullSafe(`${a}.${d}`, `c.${d}`)}`).join("\n");
  });

  const bases = plan.map((c) =>
    `  ${shiftAlias(c.interval)}.${valueColumn(name, c.period)} AS ${c.column}`);

  return `
SELECT
  c.${RECORD_DATE},
${axes.length ? `  ${axes.map((d) => `c.${d}`).join(",\n  ")},\n` : ""}  ${endFlagNames().map((f) => `c.${f}`).join(",\n  ")},
  ${valueColumns(name, m).map((v) => `c.${v}`).join(",\n  ")},
${bases.join(",\n")}
FROM ${src} AS c
${joins.join("\n")}`.trim();
}


module.exports = {
  seq, eqNullSafe, renderExpr, exprJoins, LOOKBACK_DAYS, incrementalPreOps,
  resolveDims, resolveJoins, servingAxes,
  usablePeriods, valueColumns, comparePlan, endFlagNames,
  dailySQL, periodSQL, metricSQL,
};
