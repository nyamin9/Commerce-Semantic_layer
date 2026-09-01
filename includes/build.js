// SQL 조립기. 정책이 실제로 집행되는 곳이다.
//   P11  daily_ 와 metric_ 둘 다 재집계 가능한 형태로 저장한다
//   P12  비율도 증감률도 컬럼으로 저장하지 않는다
//   P14  비교는 기준값만. 날짜 조인으로 만들고 LAG를 쓰지 않는다
//   P15  누적(WTD·MTD·YTD)은 저장하지 않는다. 소비 시점에 daily 구간 합으로 낸다
//   P17  기계적인 것은 생성한다
//   P18  틀린 결과를 내느니 거부한다
//
// 이 파일은 초기에 한 번 쓰고 거의 건드리지 않는다.

const { ENTITIES, allDims }      = require("includes/entities");
const { PERIODS, COMPARE_LABELS } = require("includes/periods");
const { dailyName, baseColumn }   = require("includes/naming");

// ── 공통 ──────────────────────────────────────────────────────
const seq = (n) => Array.from({ length: n }, (_, i) => i + 1).join(", ");

// BigQuery에는 IS NOT DISTINCT FROM 이 없다. 차원이 NULL이면 = 비교가
// false가 되어 그 행이 통째로 사라지므로 COALESCE로 감싼다 (P: 차원 NULL).
const eqNullSafe = (l, r) =>
  `COALESCE(CAST(${l} AS STRING), '\\u0000') = COALESCE(CAST(${r} AS STRING), '\\u0000')`;

// 조인 슬롯 식별자. 테이블 이름만 쓰면 역할 차원이 충돌한다
const joinAlias = (d) => `${d.from}__${d.key}`;

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
    return { name: d, ...def };
  });
}

// 같은 (테이블, 키) 면 조인 한 번. 키가 다르면 별도 조인으로 남는다
const resolveJoins = (dims) => {
  const slots = new Map();
  for (const d of dims) if (d.from && !slots.has(joinAlias(d))) slots.set(joinAlias(d), d);
  return [...slots.values()];
};

const dimSelect = (d) =>
  d.from ? `${joinAlias(d)}.${d.col} AS ${d.name}` : `base.${d.col} AS ${d.name}`;

const joinClause = (ctx, d) =>
  `LEFT JOIN ${ctx.ref(d.from)} AS ${joinAlias(d)}\n` +
  `  ON base.${d.key} = ${joinAlias(d)}.${d.ref_key || d.key}`;

// ── 1단계: daily — 조인이 실행되는 유일한 곳 (P5) ─────────────
function dailySQL(ctx, name, m) {
  const e     = ENTITIES[m.entity];
  const dims  = resolveDims(name, m);
  const joins = resolveJoins(dims);

  return `
SELECT
  base.${e.date_col} AS dt,
  ${dims.map(dimSelect).join(",\n  ")},
  ${m.expr} AS ${name}
FROM ${ctx.ref(e.source)} AS base
${joins.map((d) => joinClause(ctx, d)).join("\n")}
${m.filter ? `WHERE ${m.filter}` : ""}
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
  seq, eqNullSafe, joinAlias,
  resolveDims, resolveJoins, rollupExpr, canRollup,
  dailySQL, metricSQL,
};
