# 코드에 쓰인 JS 패턴

- `includes/` 와 `definitions/` 의 JS 가 객체를 다루는 방식 정리
- 문법 자체보다 **왜 그렇게 썼는지**에 무게를 둠
- 예시 값은 실제 코드를 실행한 결과임

- 코드가 무엇을 하는지는 [code-map.md](code-map.md), 용어는 [glossary.md](glossary.md) 를 따름

---

## 1. 파일이 하는 일은 세 종류뿐임

| 종류 | 예 | 성격 |
|---|---|---|
| **선언 데이터** | `PERIODS` `ENTITIES` `METRICS` `SOURCES` | 사람이 읽고 쓰는 설정. 로직 없음 |
| **파생 인덱스** | `SHIFTS` | 선언을 builder 가 쓰기 좋은 방향으로 가공 |
| **helper 함수** | `allDims()` `uniform()` `self()` `dailySQL()` | 선언에서 필요한 조각을 꺼내거나 조립 |

- 선언은 손으로 쓰고, 파생과 helper 는 선언을 읽음
- **역방향은 없음** — helper 가 선언을 고치지 않음

---

## 2. `Object.entries` — 객체를 순회 가능하게

- 객체는 그냥 `for...of`를 돌 수 없음
- `[키, 값]` 배열로 바꿔야 함

```js
Object.entries({ daily: {...}, wtd: {...} })
// → [ ["daily", {...}], ["wtd", {...}] ]
```

- `includes/periods.js` 의 `SHIFTS` — 실제로 쓰인 곳
- 중첩 두 단계임

```js
  for (const [pName, p] of Object.entries(PERIODS)) {
    for (const [label, interval] of Object.entries(p.compare)) {
      (acc[interval] = acc[interval] || []).push({ period: pName, label });
    }
  }
```

- `const [pName, p] of ...`는 그 쌍을 두 변수로 분해함(구조 분해)
- 바깥 루프에서 `pName = "wtd"`, `p = { type, label, trunc, end_flag, compare }`가 되고,
  안쪽 루프가 그 `p.compare`를 다시 순회함

**변형 셋을 상황에 따라 골라 씀.**

```js
// 값은 안 쓰므로 keys — includes/build.js
const usablePeriods = (m) => (canCumulate(m) ? Object.keys(PERIODS) : ["daily"]);

// 키·값 둘 다 쓰고 순회만 하면 forEach — definitions/sources/declarations.js:26-28
Object.entries(SOURCES).forEach(([schema, tables]) => {
  tables.forEach((name) => declare({ schema, name }));
});
```

---

## 3. IIFE — `const`에 여러 줄 계산을 담기

- `includes/periods.js` 의 `SHIFTS` — 실제 코드 전문

```js
const SHIFTS = (() => {
  const acc = {};
  for (const [pName, p] of Object.entries(PERIODS)) {
    for (const [label, interval] of Object.entries(p.compare)) {
      (acc[interval] = acc[interval] || []).push({ period: pName, label });
    }
  }
  return acc;
})();
```

- 첫 줄과 마지막 줄만 떼어 보면 구조가 보임

```js
const SHIFTS = (() => { ... return acc; })();
//             ^^^^^^^^^^^^^^^^^^^^^^^^^^ 함수 정의
//                                        ^^ 즉시 호출
```

- `const`는 값 하나만 받는데 계산이 여러 줄일 때 씀
- 이점이 둘임

- 임시 변수 `acc`가 모듈 바깥으로 새지 않음
- 모듈 로드 시 **딱 한 번** 실행되고 결과가 고정됨

- 함수로 빼서 `const X = buildLabels()`로 해도 되지만, 그 함수를 다른 데서 부를 일이 없으면 이름을 만들지 않는 편이
  읽기 쉬움

---

## 4. 파생 인덱스 — 표를 뒤집기

- `includes/periods.js` 의 `SHIFTS`

- 선언과 사용의 **방향이 반대**라서 뒤집음

```
PERIODS   기간 → 비교 목록    "wtd는 wow와 yoy를 쓴다"          ← 사람이 쓰기 편한 방향
SHIFTS    간격 → 비교 목록    "1 YEAR 로는 3개를 가져온다"       ← builder가 쓰기 편한 방향
```

- `metric_` 의 self-join 을 **간격 단위로 묶기 위해서**임
- 비교 컬럼이 8개인데 간격이 5개뿐이라, 뒤집지 않으면 같은 조인을 8번 씀

```js
const acc = {};
for (const [pName, p] of Object.entries(PERIODS)) {
  for (const [label, interval] of Object.entries(p.compare)) {
    (acc[interval] = acc[interval] || []).push({ period: pName, label });
  }
}
```

- 실행 추적:

| pName | label | interval | `acc[interval]` |
|---|---|---|---|
| daily | dod | 1 DAY | `undefined` → `[{daily, dod}]` |
| daily | wow | 1 WEEK | `undefined` → `[{daily, wow}]` |
| daily | yoy | 1 YEAR | `undefined` → `[{daily, yoy}]` |
| wtd | wow | 1 WEEK | → `[{daily, wow}, {wtd, wow}]` |
| wtd | yoy | **364 DAY** | `undefined` → `[{wtd, yoy}]` |
| mtd | yoy | 1 YEAR | → `[{daily, yoy}, {mtd, yoy}]` |
| ytd | yoy | 1 YEAR | → `[{daily, yoy}, {mtd, yoy}, {ytd, yoy}]` |

- 결과 — 이 값이 만들어짐
- 파일에 이렇게 적혀 있는 것은 아님

```js
SHIFTS = {
  "1 DAY":   [{ period: "daily", label: "dod" }],
  "1 WEEK":  [{ period: "daily", label: "wow" }, { period: "wtd", label: "wow" }],
  "1 YEAR":  [{ period: "daily", label: "yoy" }, { period: "mtd", label: "yoy" },
              { period: "ytd",   label: "yoy" }],
  "364 DAY": [{ period: "wtd",   label: "yoy" }],
  "1 MONTH": [{ period: "mtd",   label: "mom" }],
}
```

- `1 YEAR` 하나로 `yoy_base`·`mtd_yoy_base`·`ytd_yoy_base` 셋을 채움

- **`wtd`만 364일**이라 별도 간격으로 갈라지는 것도 이 표에서 보임

---

## 5. `acc[x] = acc[x] || {}` — 없으면 초기화

- `includes/periods.js:35 · includes/build.js:28`

```js
acc[label] = acc[label] || {};
acc[label][pName] = interval;
```

- 첫 줄이 없으면 `undefined` 에 속성을 넣으려다 에러가 남
- `||`는 왼쪽이 falsy(`undefined` `null` `0` `""` `false`)면 오른쪽을 줌

- **주의** — 유효한 값이 falsy일 수 있으면 `??`(nullish 병합)를 써야 함
- 여기서는 `{}`나 배열만 담으므로 `||`로 충분함

- 같은 문법이 **기본값**에도 쓰임

```js
const want = m.serving_dims || servingDims(m.entity);
// 지표가 serving_dims 를 생략하면 그 entity 의 것을 쓴다
// → servingDims("session") = ["country", "acquisition_channel"]
```

---

## 6. 계산된 키 `[변수]:` — 키 이름을 변수로

- `definitions/sources/declarations.js:7-28` — 전문

```js
const { dwDataset, snapshotDataset } = dataform.projectConfig.vars;

const SOURCES = {
  // semantic layer의 소스가 되는 DW 레이어
  [dwDataset]: [
    "dim_users",
    "dim_products",
    "dim_products_history",
    "dim_distribution_centers",
    "fct_order_items",
    "fct_orders",
    "fct_sessions",
    "fct_user_events",
  ],

  // dbt snapshot 원본. dim_products_history의 소스라서 보통 직접 읽을 일은 없다.
  [snapshotDataset]: ["snap_products"],
};

Object.entries(SOURCES).forEach(([schema, tables]) => {
  tables.forEach((name) => declare({ schema, name }));
});
```

- 대괄호가 없으면 키가 문자열 `"dwDataset"`이 됨
- 대괄호를 씌우면 **변수의 값**이 키가 됨

```js
{ [dwDataset]: [...] }   // → { "dbt_dev_marts_core": [...] }
{ dwDataset: [...] }     // → { "dwDataset": [...] }        ← 틀림
```

- 첫 줄의 `dataform.projectConfig.vars`가 `workflow_settings.yaml`의 `vars`를 읽음
- 데이터셋 이름이 설정에서 오므로 키가 변수여야 함

- 마지막 세 줄이 실제로 Dataform에 등록하는 부분임 — 데이터셋 하나에 테이블 여러 개이므로 `forEach` 를 두 번 중첩해
  `declare()` 를 9번 호출함

---

## 7. 화살표가 객체를 반환할 때 `({ ... })`

- `includes/entities.js:25-26` — 정의

```js
// via 가 null 이면 fact 자체 컬럼이라 조인이 필요 없다
const self = (col) => ({ via: null, col });
```

- `includes/entities.js:36-50` — 쓰이는 곳
- 마지막 줄만 `self()`임

```js
    joins: {
      product:      { to: PRODUCT, key: "product_id" },
      user:         { to: USER,    key: "user_id"    },
      order_header: { to: ORDER,   key: "order_key"  },
    },

    dims: {
      category:            { via: "product", col: "category"   },
      department:          { via: "product", col: "department" },
      country:             { via: "user",    col: "country"             },
      age_group:           { via: "user",    col: "age_group"           },
      gender:              { via: "user",    col: "gender"              },
      acquisition_channel: { via: "user",    col: "acquisition_channel" },
      order_item_status:   self("order_item_status"),
      purchase_type:       { via: "order_header", col: "purchase_type" },
    },
```

- `self("order_status")`가 만드는 값은 `{ via: null, col: "order_status" }`임
- 매번 `{ via: null, col: "..." }`를 쓰지 않으려고 만든 helper 임

- **괄호를 빼면 동작이 달라짐.** `{`가 객체 리터럴이 아니라 함수 본문 블록으로 읽혀서 `undefined`를 반환함

```js
(col) => ({ ... })   // 객체 반환
(col) =>  { ... }    // 본문 블록. return 이 없으면 undefined
```

- **축약 속성** — `col: col` 대신 `col`만 썼음
- 변수명과 키가 같으면 생략할 수 있음

- 같은 형태가 `includes/metrics.js:21-25`에도 있음
- 이쪽은 블록이라 `return`이 있음

```js
const uniform = (entity, value) => {
  const acc = { time: value };
  for (const d of allDims(entity)) acc[d] = value;
  return acc;
};
```

- `uniform("session", true)`가 `{ time: true, country: true,
  acquisition_channel: true, entry_traffic_source: true, browser: true }`를 만듦
- 축마다 손으로 쓰면 dimension이 늘 때 지표 17개를 다 고쳐야 하므로, 선언은 짧게 두고 펼치는 일은 코드가 함

---

## 8. 스프레드 `...` — 객체 병합

- `includes/build.js:30-53` — `resolveDims`가 돌려주는 값을 만드는 부분

```js
  return dims.map((d) => {
    const def = e.dims[d];
    // ... 검증 세 개 (12번 참조)
    return { name: d, ...def };
  });
```

- 선언에 없던 `name`을 붙여서 나중 단계가 dimension 이름을 알 수 있게 함

```
def            { via: "product", col: "category" }
{name, ...def} { name: "category", via: "product", col: "category" }
```

- 원본 `def`는 바뀌지 않음 — 새 객체가 만들어짐
- **뒤에 오는 것이 이김.** `{ ...def, name: d }`였다면 `def`에 `name`이 있을 때 그쪽이 덮임
- 여기서는 `name`을 먼저 뒀으므로 `def.name`이 이김

---

## 9. `Set` — 중복 없이 모으고 선언 순서로 되돌리기

- `includes/build.js:119-138`

```js
function resolveJoins(name, m, dims) {
  const e    = ENTITIES[m.entity];
  const used = new Set(dims.filter((d) => d.via).map((d) => d.via));

  for (const j of exprJoins(name, m, m.expr, "expr")) used.add(j);
  if (m.filter) for (const j of exprJoins(name, m, m.filter, "filter")) used.add(j);

  return Object.keys(e.joins || {})
    .filter((j) => used.has(j))
    .map((j) => ({ name: j, ...e.joins[j] }));
}
```

**두 곳에서 모아 한 곳에서 순서를 줌.**

- 조인이 필요한 이유는 둘임 — dimension이 그 조인을 거치거나(`via`), 지표 수식이 그 조인의 컬럼을
  참조하거나(`{product.unit_cost}`)
- 둘을 `Set`에 모아 중복을 없앰

- `Set`은 무엇이 들었는지만 알려주고 **순서는 보장하지 않음.** 그래서 마지막에 `Object.keys(e.joins)`로 다시 훑음
- `LEFT JOIN` 순서가 선언 순서와 같아지고, 지표가 달라져도 같은 조인은 같은 자리에 옴
- diff 가 읽기 쉬워짐

- `order_item`의 dimension 8개 중 7개가 조인이 필요한데, 실제 조인은 **3번**임

```
category · department                      → product
country · age_group · gender · channel     → user
purchase_type                              → order_header
order_item_status                          → 조인 없음 (via: null)
```

- **조인에 이름이 있어서 되짚을 필요가 없음.** 이름이 없으면 `dims` 를 훑어 `(테이블, 키)` 조합으로
  어느 조인인지 역산해야 함
- 지금은 `entities.js` 의 `joins` 를 읽기만 하면 됨

- 역할 dimension(같은 dim을 두 키로 참조)도 마찬가지임
- 이름이 다르면 다른 조인임

```js
joins: {
  ordered_date: { to: "sem_dim_date", key: "ordered_date", ref_key: "date_day" },
  shipped_date: { to: "sem_dim_date", key: "shipped_at",   ref_key: "date_day" },
}
```

---

## 10. 고차 함수 — `map` · `filter` · `join`

- SQL 조립은 대부분 이 셋의 조합임
- `includes/build.js:193-195`:

```js
  ${dims.map(dimSelect).join(",\n  ")},
  ${renderExpr(name, m, m.expr, "expr")} AS ${name}
FROM ${ctx.ref(e.source)} AS base
${joins.map((j) => joinClause(ctx, j)).join("\n")}
```

- `map`이 배열을 배열로 바꾸고 `join`이 문자열 하나로 합침

```
["category", "country"]
  → map(dimSelect)  ["product.category AS category", "user.country AS country"]
  → join(",\n  ")   "product.category AS category,\n  user.country AS country"
```

- `dimSelect`를 괄호 없이 넘긴 것에 주의
- `map(dimSelect)`는 함수 자체를 넘기는 것이고 `map(dimSelect(d))`였다면 호출 결과를 넘기는 것이라 틀림
- 인자가 더 필요하면 `(j) => joinClause(ctx, j)`처럼 감쌈

- `filter`로 후보를 거름
- `includes/build.js` 의 `rollupAxes`:

```js
const have = new Set(resolveDims(name, m).map((d) => d.name));
return want.filter((d) => have.has(d));
```

- **콜백에서 구조 분해**도 자주 씀
- `includes/metrics.js`:

```js
for (const [name, m] of Object.entries(METRICS)) { ... }
```

- `([pName])`처럼 쓰면 `[키, 값]` 쌍에서 첫 원소만 꺼내고 값은 버린다는 뜻임
- 둘 다 필요하면 `([pName, iv])`로 받음

---

## 11. 템플릿 리터럴 — SQL 조립

- `includes/build.js:203-221` — `dailySQL` 전문

```js
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
```

- `conds` 는 필터와 증분 조건을 같이 모음
- 둘 다 없으면 `WHERE` 자체가 안 붙고, 하나만 있어도 `AND` 가 남지 않음 — 배열에 모아 `join` 하면 구분자 처리가
  사라짐

- 백틱 문자열은 줄바꿈과 `${}` 삽입을 지원함

- **중첩 가능** — `${m.filter ? \`WHERE ${m.filter}\` : ""}`처럼 안에 또 백틱을 씀
- **조건부 절**은 삼항 연산자로. `filter`가 없으면 빈 문자열이 되어 그 줄이 사라짐
- 맨 앞 줄바꿈을 없애려고 `.trim()`을 붙임

- `ctx.ref(...)`는 Dataform이 주는 함수로, 이름을 정규화된 테이블 경로로 바꾸고 **동시에 의존 관계를 등록함.**
  문자열을 직접 쓰면 그래프에 엣지가 생기지 않음

- `includes/build.js:140-145`의 두 helper 도 같은 방식임

```js
const dimSelect = (d) =>
  d.via ? `${d.via}.${d.col} AS ${d.name}` : `base.${d.col} AS ${d.name}`;

const joinClause = (ctx, j) =>
  `LEFT JOIN ${ctx.ref(j.to)} AS ${j.name}\n` +
  `  ON base.${j.key} = ${j.name}.${j.ref_key || j.key}`;
```

- `dimSelect`는 삼항 연산자로 두 형태를 고름 — 조인해서 온 dimension이면 조인 이름을 붙이고, fact 자체
  컬럼(`via: null`)이면 `base.`를 씀

- **조인 이름이 그대로 SQL alias 가 됨.** `entities.js`에 `product`라고 적으면 생성된 SQL에도 `AS
  product`가 나옴
- 그래서 예약어를 쓸 수 없고, `resolveJoins`가 `RESERVED` 78개와 `base`를 컴파일 타임에 막음 —
  `order`가 거기 있음

---

## 12. `throw` — 컴파일 타임에 멈추기

- `includes/build.js` 의 `resolveDims` 전문
- 예외가 여기 모여 있음

```js
function resolveDims(name, m) {
  const e = ENTITIES[m.entity];
  if (!e) throw new Error(`[${name}] 알 수 없는 entity: ${m.entity}`);

  if (m.dims) {
    throw new Error(
      `[${name}] 지표는 dims 를 선언할 수 없다. daily_ 는 entity 의 dimension 전체를 갖는다. ` +
      `period_ 의 dimension 을 좁히려면 serving_dims 를 쓴다`
    );
  }

  const dims = allDims(m.entity);

  return dims.map((d) => {
    const def = e.dims[d];

    if (!(d in m.additive)) {
      throw new Error(`[${name}] dimension '${d}'의 가산성이 선언되지 않았다 (P9)`);
    }
    if (m.additive[d] === false) {
      throw new Error(
        `[${name}] dimension '${d}'가 비가산이다. entity를 옮기거나 sketch 로 바꾼다 (P10)`
      );
    }
    return { name: d, ...def };
  });
}
```

- 이 한 함수에 앞서 본 패턴이 여섯 개 들어 있음

| 줄 | 패턴 |
|---|---|
| `m.serving_dims \|\| servingDims(m.entity)` | 기본값 (5번) |
| `dims.map((d) => {...})` | 고차 함수 (10번) |
| `` `[${name}] ...` `` | 템플릿 리터럴 (11번) |
| `!(d in m.additive)` | 키 존재 검사 (16번) |
| `m.additive[d] === false` | 값 검사 — 16번과 짝 |
| `{ name: d, ...def }` | 스프레드 병합 (8번) |

- `build.js` 전체에서 `throw`는 5곳이고 전부 **선언이 잘못됐을 때**임
- 나머지 둘은 `periodSQL`의 "생성 가능한 기간이 없다"와 위 `알 수 없는 entity`임

- Dataform은 include를 컴파일할 때 이 코드를 실행하므로, 예외가 나면 `dataform compile`이 실패함
- **런타임에 조용히 틀린 숫자가 나오는 대신 배포 전에 멈춤.**

- 메시지에 `사용 가능:` 목록을 붙이는 이유는 오타 하나에 파일을 뒤지지 않게 하려는 것임

### 12-1. 추측하지 않기 — `renderExpr`

- `includes/build.js:71 · 89-101`

```js
const COLUMN_REF = /\{\s*([A-Za-z_][A-Za-z0-9_]*)(?:\.([A-Za-z_][A-Za-z0-9_]*))?\s*\}/g;

function renderExpr(name, m, sql, where) {
  const out = sql.replace(COLUMN_REF, (_, head, tail) =>
    tail ? `${head}.${tail}` : `base.${head}`);

  if (/[{}]/.test(out)) {
    throw new Error(`[${name}] ${where} 에 닫히지 않은 중괄호가 있다: ${sql}`);
  }
  return out;
}
```

- **왜 테이블 접두사가 필요한가** — `metrics.js`의 수식은 선언 그대로 SQL에 들어감

```
SUM(IF(is_revenue_recognized, unit_cost, 0))
```

- `unit_cost` 는 `sem_fct_order_items` 에도 `sem_dim_products` 에도 있음
- `user_id` 는 fact 에도 `sem_dim_users` 에도 있음
- `daily_cogs` 는 두 테이블을 조인하므로 BigQuery 가 어느 쪽인지 고를 수 없음
- `dataform compile` 은 **못 잡음** — 문자열일 뿐이라 통과하고 실행 단계에서 에러가 남

- **왜 중괄호인가** — 접두사를 붙이려면 어느 토큰이 컬럼인지 알아야 함
- 정규식으로 추측하면 예외가 끝없이 나옴

```
COUNTIF(status = "returned")     → "returned" 가 문자열인지 컬럼인지
CAST(x AS INT64)                 → INT64 는 타입명
EXTRACT(YEAR FROM record_date)   → YEAR · FROM 은 키워드
`sale price`                     → 백틱 식별자
```

- 키워드 목록을 늘려도 BigQuery의 예약어·타입명·날짜 단위가 수백 개라 따라잡을 수 없음
- 그리고 **큰따옴표 문자열은 조용히 틀림** — `"base.returned"`도 유효한 문자열이라 에러 없이 아무것도 매칭되지 않음
- P18이 막으려는 바로 그 유형임

- 중괄호로 표시하면 추측할 것이 없음
- **바깥은 건드리지 않음.**

| 수식 | 결과 |
|---|---|
| `SUM({sale_price})` | `SUM(base.sale_price)` |
| `SUM({product.unit_cost})` | `SUM(product.unit_cost)` |
| `COUNTIF({status} = "returned")` | `COUNTIF(base.status = "returned")` |
| `SUM(CAST({sale_price} AS INT64))` | `SUM(CAST(base.sale_price AS INT64))` |

- **중괄호를 깜빡하면** 접두사가 붙지 않은 채 남아 원래의 ambiguous 에러가 남 — **값이 틀리는 대신 바로 멈춤.** 이게
  추측 방식과의 차이임

- `{sale_price` 처럼 짝이 안 맞으면 치환되지 않고 중괄호가 남으므로, 그것도 잡음

- **`product`는 어디서 온 이름인가** — `entities.js`의 `joins`에 적힌 이름임
- builder 가 만든 이름이 아니므로 선언이 builder 내부에 기대지 않음 (P5)
- 선언되지 않은 이름을 쓰면 `exprJoins`가 컴파일 타임에 막음

```
[t] expr 의 'warehouse.unit_cost' — 조인 'warehouse'가 선언되지 않았다.
사용 가능: product, user (P6)
```

### 12-2. dim 컬럼을 measure로 쓸 때의 주의

- `{product.unit_cost}`는 **현재 카탈로그 원가**고, `{unit_cost}`는 **주문 시점에 기록된 원가**임
- 둘 다 정당한 수요지만 앞의 것은 과거 숫자가 나중에 바뀜 — `sem_dim_users` · `sem_dim_products`는 현재
  상태만 담고 있고 SCD 이력 커버리지가 4.46%임

- Kimball이 measure를 fact에 두라고 한 이유이고, 이 DW가 `unit_cost`를 주문 시점에 fact에 기록해 둔
  이유이기도 함
- **기능은 열되 기본은 fact임.**

---

## 13. `module.exports` — Dataform에서의 동작

- 각 파일 끝에서 무엇을 밖으로 내보낼지 정함

```js
// includes/naming.js
module.exports = {
  MART_PREFIX, martName,
  dailyName, periodName, metricName,
  RECORD_DATE, valueColumn, baseColumn,
};

// includes/periods.js
module.exports = { PERIODS, CUMULATIVE, END_FLAGS, SHIFTS };

// includes/entities.js
module.exports = { ENTITIES, allDims, allJoins, refreshOf, servingDims };

// includes/metrics.js
module.exports = { METRICS, RATIOS, EXCLUDED, HLL_PRECISION };

// includes/build.js
module.exports = {
  seq, renderExpr, exprJoins, LOOKBACK_DAYS, incrementalPreOps,
  resolveDims, resolveJoins, servingAxes, rollupAxes, rollupNames,
  usablePeriods, valueColumns, comparePlan, endFlagNames,
  dailySQL, periodSQL, metricSQL,
};
```

- 내보내지 않은 것은 파일 안에서만 쓰임 — `entities.js`의 `self`, `metrics.js`의 `uniform`·`hll`,
  `build.js`의 `dimSelect`·`joinClause`·`baseCTE`·`gridCTE`·`rollupSelect`가 그러함
- helper 를 밖으로 내보내면 그것도 계약이 되어 바꾸기 어려워짐

- 받는 쪽은 구조 분해로 필요한 것만 꺼냄
- `includes/build.js:11-13`:

```js
const { ENTITIES, allDims, allJoins, servingDims } = require("includes/entities");
const { PERIODS, CUMULATIVE, END_FLAGS } = require("includes/periods");
const { dailyName, periodName, martName,
        RECORD_DATE, valueColumn, baseColumn } = require("includes/naming");
```

- `periods.js`는 4개를 내보내는데 `build.js`는 3개만 받음 — `SHIFTS` 는 안 씀
- 무엇을 쓰는지가 파일 맨 위에 드러남

**`includes/`의 파일은 두 가지로 쓸 수 있음.**

```js
// (1) 다른 include 에서 — 명시적 require
const { ENTITIES } = require("includes/entities");

// (2) definitions 의 sqlx/js 에서 — 파일명이 전역으로 주입됨
${metrics.select()}
```

- 이 레포는 (1)만 씀
- 명시적이라 어느 파일이 무엇을 읽는지 추적할 수 있음

- **`require("includes/x")`는 Dataform의 경로 규칙**이라 순수 node로는 해석되지 않음
- 로컬에서 테스트하려면 `Module._resolveFilename`을 패치해야 함

---

## 14. `Array.from({ length: n })` — 숫자 범위 만들기

- `includes/build.js:16`

```js
const seq = (n) => Array.from({ length: n }, (_, i) => i + 1).join(", ");

seq(4)   // → "1, 2, 3, 4"
```

- `GROUP BY 1, 2, 3, 4`를 만드는 데 씀
- 컬럼 수가 선언에 따라 달라지므로 계산해야 함

- `{ length: n }`은 **유사 배열(array-like)** 임. `length`만 있으면 `Array.from`이 배열로 바꿔줌
- 두 번째 인자는 각 원소를 만드는 함수. `(원소, 인덱스)`를 받는데 원소는 `undefined`라 안 씀
- **`_`는 "이 인자는 쓰지 않는다"는 관례**임. 문법이 아니라 약속이고, `x`라고 써도 동작은 같음

---

## 15. `switch` + `return` — `break`가 없는 이유

- `includes/build.js` 의 `foldExpr`

```js
function foldExpr(col, additive) {
  switch (additive) {
    case true:     return `SUM(${col})`;
    case "sketch": return `HLL_COUNT.MERGE_PARTIAL(${col})`;
    case "last":   return `ANY_VALUE(${col} HAVING MAX ${RECORD_DATE})`;
    default:       return null;
  }
}
```

- `switch`는 보통 `break`가 필요함
- 없으면 다음 `case`로 흘러내림(fall-through)
- 여기서는 **`return`이 함수를 즉시 끝내므로** `break`가 필요 없음

- `default: return null`이 "rollup 할 수 없다"는 신호임
- 호출한 쪽(`dimFold`)이 `!== null`로 검사해 예외를 던질지 정함 — 판정과 처리가 나뉘어 있음

---

## 16. `in` 연산자 — "키가 없다"와 "값이 falsy다"는 다름

- `includes/build.js:38-40`

**이 파일에서 가장 미묘한 부분임.**

```js
    if (!(d in m.additive)) {
      throw new Error(`[${name}] dimension '${d}'의 가산성이 선언되지 않았다 (P9)`);
    }
    if (m.additive[d] === false) {
      throw new Error(
        `[${name}] dimension '${d}'가 비가산이다. entity를 옮기거나 sketch 로 바꾼다 (P10)`
      );
    }
```

- `additive`의 값으로 `false`가 올 수 있기 때문에 두 검사를 나눠야 함

- 설명용 예시로 값을 하나 두고 보자

```js
const additive = { time: true, category: false };

"category" in additive     // true   ← 선언은 되어 있다
additive.category          // false  ← 값이 falsy
!additive.category         // true   ← 이걸로 검사하면 "미선언"으로 오판한다
```

- `in`은 **키의 존재**만 봄
- 값이 `false`든 `0`이든 상관없음

- 두 오류는 고치는 방법이 다름 — 앞은 선언을 추가하는 것이고, 뒤는 entity를 옮기거나 sketch 로 바꾸는 것임
- 그래서 메시지도 다름

---

## 17. `continue` — 이번 회차만 건너뛰기

- `includes/build.js:96-109` — `exprJoins` 전문

```js
function exprJoins(name, m, sql, where) {
  const used = new Set();
  for (const [, head, tail] of sql.matchAll(COLUMN_REF)) {
    if (!tail) continue;                                   // {col} 은 fact 컬럼
    if (!(head in (ENTITIES[m.entity].joins || {}))) {
      throw new Error(/* 선언되지 않은 조인 */);
    }
    used.add(head);
  }
  return used;
}
```

- `break`는 루프를 끝내지만 `continue`는 다음 회차로 넘어감
- `{sale_price}` 처럼 점이 없는 참조는 fact 컬럼이라 조인이 필요 없으므로 넘김
- 점이 있는 `{product.unit_cost}` 만 조인 이름을 검사함

- 같은 뜻을 `if (tail) { ... }`로 감쌀 수도 있지만, **들여쓰기가 한 단계 줄어서** `continue` 쪽이 읽기 쉬움
- 뒤따르는 검사가 길수록 차이가 커짐

- **초기 반환(guard clause)과 같은 발상임** — 처리할 게 아닌 것을 위에서 걸러내고 본론을 왼쪽에 붙여 씀

---

## 18. 상수 하나로 문제를 옮기기 — `NULL` 을 값으로 바꿈

- `includes/build.js` 의 `UNKNOWN`

```js
const UNKNOWN = "(unknown)";
...
`COALESCE(${d}, '${UNKNOWN}') AS ${d}`
```

- dimension이 `NULL`이면 `=` 비교가 `TRUE`도 `FALSE`도 아닌 `NULL`이 되고, `ON` 절에서 그 행은
  매칭되지 않음
- GoogleSQL 에는 `IS NOT DISTINCT FROM` 이 있어서 `NULL = NULL` 을 `TRUE` 로 보지만, 그것으로
  풀지 않음

- **BigQuery 가 그 연산자를 해시 조인 키로 쓰지 못하기 때문임.** 등가 조인이면 양쪽을 해시로 나눠 붙이는데, `IS NOT
  DISTINCT FROM` 은 일반 술어라 중첩 루프가 됨
- 평범한 조인에서는 차이가 드러나지 않다가 구간 self-join 에서 CPU 한도를 넘겼음

- 구간 self-join 에서 CPU 한도를 넘겨 실패함 ([findings.md](findings.md) 8)

- 고치는 방법이 둘이었음

| | |
|---|---|
| 조인 술어를 바꿈 | `COALESCE(l,'x') = COALESCE(r,'x')` — 조인마다 식이 붙음 |
| **값에서 `NULL` 을 없앰** | 한 단계에서 `'(unknown)'` 으로 바꾸면 이후 조인이 전부 `=` 임 |

- 뒤쪽을 골랐음
- `NULL` 이 사라지는 것이 아니라 **이름을 얻음** — 뜻은 그대로 "값이 없는 bucket"(P6-1)이고,
  `sem_dim_products` 가 `brand_name` 에 쓰는 방식과 같음
- 소비자도 `IS NULL` 대신 `= '(unknown)'` 을 씀

- `'(all)'` 과는 겹치지 않음
- `'(unknown)'` 은 값이 없는 bucket이고 `'(all)'` 은 그 축을 rollup 한 행임

- **상수를 파일 맨 위에 둔 이유**도 여기 있음
- 문자열이 여러 곳에 흩어지면 하나를 고쳤을 때 나머지가 조용히 어긋남 — `'(all)'` 과 `'(unknown)'` 둘 다 그러함

---

## 19. 병렬 누적 배열 — 조인과 컬럼을 같이 모으기

- `includes/build.js` 의 `metricSQL`

- 비교 컬럼은 8개인데 shift 간격은 5개뿐임
- **간격 하나가 컬럼 여럿을 채움** — `1 YEAR` 하나로 `yoy_base`·`mtd_yoy_base`·`ytd_yoy_base`
  셋이 나옴
- 그래서 먼저 간격으로 묶음

```js
  const byInterval = new Map();
  for (const c of plan) {
    if (!byInterval.has(c.interval)) byInterval.set(c.interval, []);
    byInterval.get(c.interval).push(c);
  }

  const joins = [...byInterval.keys()].map((interval) => {
    const a = shiftAlias(interval);
    return `LEFT JOIN ${src} AS ${a}\n` +
           `  ON ${a}.${RECORD_DATE} = DATE_SUB(c.${RECORD_DATE}, INTERVAL ${interval})\n` +
           axes.map((d) => ` AND ${a}.${d} = c.${d}`).join("\n");
  });

  const bases = plan.map((c) =>
    `  ${shiftAlias(c.interval)}.${valueColumn(name, c.period)} AS ${c.column}`);
```

- **`joins` 는 간격으로, `bases` 는 컬럼으로 돎.** 길이가 다름 (5 대 8)
- 둘을 잇는 것은 `shiftAlias(interval)` 뿐임 — 같은 간격이면 같은 alias 가 나오므로 `bases` 가
  `joins` 가 만든 alias 를 그대로 가리킴

- `1 YEAR` 회차가 만드는 것:

```sql
SELECT ..., b_1_year.net_revenue     AS yoy_base
            b_1_year.net_revenue_mtd AS mtd_yoy_base      ← bases 3줄
            b_1_year.net_revenue_ytd AS ytd_yoy_base
FROM period_net_revenue AS c
LEFT JOIN period_net_revenue AS b_1_year ON ...            ← joins 1줄
```

- `shiftAlias` 는 `"364 DAY"` 를 `"b_364_day"` 로 바꿈
- 간격 문자열이 그대로 식별자가 되므로 공백과 대문자를 지움 — 값 하나에서 이름을 만드는 방식이라 간격을 추가해도 alias 규칙을 손댈
  일이 없음

---

## 20. `build.js` 읽는 순서

- 위 패턴을 알면 이 순서로 읽는 것이 가장 빠름

| 순서 | 대상 | 무엇을 보나 |
|---|---|---|
| 1 | `resolveDims` · `renderExpr` | **선언 검증.** 어떤 잘못을 어떻게 잡는지 (12번) |
| 2 | `resolveJoins` · `joinClause` | 선언된 조인 중 실제로 쓰이는 것만 (9번) |
| 3 | `dailySQL` | 1·2를 써서 SQL 문자열 하나를 만듦 (11번) |
| 4 | `foldExpr` · `dimFold` | `additive` → 합치는 함수 선택 (15번) |
| 5 | `baseCTE` · `gridCTE` | dimension 좁히기와 grid 채우기 |
| 6 | `cumWindowed` · `cumSketch` · `rollupSelect` | 5 위에 누적하고 마지막에 '(all)' 행을 만듦 |
| 7 | `comparePlan` · `metricSQL` | 비교 컬럼 판정과 간격별 조인 조립 (19번) |

- **6과 7이 나뉘어 있는 것이 핵심임.** 기간 확장을 `metricSQL` 안의 CTE 로 두면 `metricSQL` 이 그것을 여섯
  번 참조하게 되고(본 쿼리 1 + 비교 조인 5), 같은 집계가 그만큼 돎
- CTE 는 결과를 저장하지 않기 때문임

```
periodSQL   daily_ → 채운 grid → 누적 → '(all)' rollup  → period_<metric> 테이블
metricSQL   period_ 를 shift 해 자기 자신과 조인    → metric_<metric> 테이블
```

- `periodSQL` 은 CTE 세 개를 이어 붙이고 마지막에 rollup 단계를 붙임

```
base → grid → cumWindowed (가산) 또는 cumSketch (sketch) → rollupSelect
```

- `metricSQL` 은 두 부분으로 나뉨

```
1) joins/bases  간격마다 조인 한 줄, 컬럼마다 한 줄   → 길이가 다른 두 배열 (19번)
2) 조립          SELECT + joins                       → 최종 문자열
```

- `ctx`는 Dataform이 넘겨주는 객체임
- `ctx.ref(name)`이 이름을 정규화된 테이블 경로로 바꾸면서 **동시에 의존 관계를 등록함.** 그래서 `build.js`는
  프로젝트 이름도, 데이터셋 이름도 들어가지 않음 — 알 필요가 없게 만든 것임

---

## 21. `publish()` 체이닝과 `ctx` 콜백 — generator 의 모양

- `definitions/semantic/gen_daily.js` · `gen_period.js` · `gen_metric.js` ·
  `definitions/metadata/gen_registry.js` 넷이 같은 모양임

```js
Object.entries(METRICS).forEach(([name, m]) => {
  publish(dailyName(name), { type, schema, columns, assertions, bigquery })
    .preOps((ctx) => ctx.when(ctx.incremental(), incrementalPreOps(ctx, e)))
    .query((ctx) => dailySQL(ctx, name, m, { incremental: ctx.incremental() }));
});
```

- **선언 하나가 테이블 하나가 됨** (P17)
- 지표를 추가하면 `forEach` 가 한 바퀴 더 돎

### 21-1. `ctx` 가 콜백으로 오는 이유

- `publish()` 의 첫 인자(config)는 **컴파일 타임에 확정**되지만, `query` 와 `preOps` 는 **콜백**임
- Dataform 이 실행 직전에 `ctx` 를 넣어 호출함

```js
ctx.ref(name)        이름 → 정규화된 테이블 경로. 동시에 의존 관계를 등록한다
ctx.self()           이 테이블 자신의 경로
ctx.incremental()    지금이 증분 실행인가. 첫 적재에서는 false
ctx.when(조건, sql)  조건이 참일 때만 그 SQL 을 낸다
```

- `ctx.incremental()` 이 **config 가 아니라 콜백 안에 있는 것**이 중요함
- 첫 적재에서는 `false` 라 증분 조건이 붙지 않고 전 기간을 만들고, 이후 실행에서만 `true` 가 됨
- config 에서 판단했다면 그 구분을 할 수 없음

- `build.js` 는 `ctx` 를 받기만 하고 프로젝트 이름도 데이터셋 이름도 들어가지 않음 —
**알 필요가 없게 만든 것임.**

### 21-2. 계산된 키로 컬럼 문서를 만듦

```js
const columns = {
  [RECORD_DATE]: `집계 기준일. ${e.source}.${e.date_col}`,
  [name]: sketch ? `${m.description} — HLL sketch(BYTES)` : m.description,
};
for (const d of dims) columns[d] = `dimension. ${e.dims[d].via || "fact 자체 컬럼"}`;
```

- 컬럼 이름이 지표마다 다르므로 `[name]:` 로 넣음(6번)
- dimension은 개수가 달라서 루프로 붙임
- 이렇게 만든 설명이 **BigQuery 콘솔의 컬럼 설명으로 그대로 감.**

### 21-3. 넷의 차이

| | 읽는 것 | 특징 |
|---|---|---|
| `gen_daily.js` | `sem_*` | 조인이 실행됨. 증분이면 `preOps` 로 구간을 지움 |
| `gen_period.js` | `daily_` | 기간 4종 확장 |
| `gen_metric.js` | `period_` | shift self-join |
| `gen_registry.js` | **없음** | 선언만 읽어 리터럴로 만듦. `ref()` 가 하나도 없음 |

---

## 22. 요약 — 어디에 무엇이 쓰였나

| 패턴 | 쓰인 곳 |
|---|---|
| `Object.entries` 순회 | `periods.js` `build.js` `declarations.js` |
| IIFE | `periods.js` — `SHIFTS` |
| 파생 인덱스 | `periods.js` — 표 뒤집기 |
| `|| {}` 초기화 · 기본값 | `periods.js` `build.js` |
| 계산된 키 `[x]:` | `declarations.js` — 데이터셋명이 vars에서 옴 |
| `=> ({...})` | `entities.js` — `self()` |
| 스프레드 병합 | `build.js` — `{ name: d, ...def }` |
| `Set` 합집합 + 선언 순서 복원 | `build.js` — `resolveJoins` |
| `map`·`filter`·`join` | `build.js` 전반 |
| 템플릿 리터럴 | `build.js` — SQL 조립 |
| `throw` | `build.js` — 선언 검증 5곳 |
| `Array.from({length})` | `build.js` — `seq()` |
| `switch` + `return` | `build.js` — `foldExpr` |
| `in` 연산자 | `build.js` — 미선언과 `false` 구분 |
| `continue` | `build.js` — `exprJoins` |
| 콜백 `replace` + 캡처 그룹 | `build.js` — `renderExpr` |
| 병렬 누적 배열 | `build.js` — `joins` · `cols` |
| `publish()` 체이닝 · `ctx` 콜백 | `gen_*.js` 넷 |
