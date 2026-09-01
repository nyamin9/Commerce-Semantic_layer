# 코드에 쓰인 JS 패턴

`includes/`와 `definitions/`의 JS가 객체를 다루는 방식 정리.
문법 자체보다 **왜 그렇게 썼는지**에 무게를 둔다. 예시 값은 실제 코드를 실행한 결과다.

---

## 파일이 하는 일은 세 종류뿐이다

| 종류 | 예 | 성격 |
|---|---|---|
| **선언 데이터** | `PERIODS` `ENTITIES` `METRICS` `SOURCES` | 사람이 읽고 쓰는 설정. 로직 없음 |
| **파생 인덱스** | `COMPARE_LABELS` | 선언을 생성기가 쓰기 좋은 방향으로 가공 |
| **헬퍼 함수** | `allDims()` `uniform()` `self()` `dailySQL()` | 선언에서 필요한 조각을 꺼내거나 조립 |

선언은 손으로 쓰고, 파생과 헬퍼는 선언을 읽는다. **역방향은 없다** —
헬퍼가 선언을 고치지 않는다.

---

## 1. `Object.entries` — 객체를 순회 가능하게

객체는 그냥 `for...of`를 돌 수 없다. `[키, 값]` 배열로 바꿔야 한다.

```js
Object.entries({ daily: {...}, weekly: {...} })
// → [ ["daily", {...}], ["weekly", {...}] ]
```

`includes/periods.js:33-38` — 실제로 쓰인 곳. 중첩 두 겹이다.

```js
  for (const [pName, p] of Object.entries(PERIODS)) {
    for (const [label, interval] of Object.entries(p.compare)) {
      acc[label] = acc[label] || {};
      acc[label][pName] = interval;
    }
  }
```

`const [pName, p] of ...`는 그 쌍을 두 변수로 분해한다(구조 분해).
바깥 루프에서 `pName = "weekly"`, `p = { type, trunc, compare }`가 되고,
안쪽 루프가 그 `p.compare`를 다시 순회한다.

**변형 셋을 상황에 따라 골라 쓴다.**

```js
// 값은 안 쓰므로 keys — includes/build.js:120
const usable = Object.keys(PERIODS).filter((pName) => canRollup(m, pName));

// 키·값 둘 다 쓰고 순회만 하면 forEach — definitions/sources/declarations.js:26-28
Object.entries(SOURCES).forEach(([schema, tables]) => {
  tables.forEach((name) => declare({ schema, name }));
});
```

---

## 2. IIFE — `const`에 여러 줄 계산을 담기

`includes/periods.js:31-43` — 실제 코드 전문.

```js
const COMPARE_LABELS = (() => {
  const acc = {};
  for (const [pName, p] of Object.entries(PERIODS)) {
    for (const [label, interval] of Object.entries(p.compare)) {
      acc[label] = acc[label] || {};
      acc[label][pName] = interval;
    }
  }
  return acc;
})();
```

첫 줄과 마지막 줄만 떼어 보면 구조가 보인다.

```js
const COMPARE_LABELS = (() => { ... return acc; })();
//                     ^^^^^^^^^^^^^^^^^^^^^^^^^^ 함수 정의
//                                                ^^ 즉시 호출
```

`const`는 값 하나만 받는데 계산이 여러 줄일 때 쓴다. 이점이 둘이다.

- 임시 변수 `acc`가 모듈 바깥으로 새지 않는다
- 모듈 로드 시 **딱 한 번** 실행되고 결과가 고정된다

함수로 빼서 `const X = buildLabels()`로 해도 되지만, 그 함수를 다른 데서 부를 일이
없으면 이름을 만들지 않는 편이 읽기 쉽다.

---

## 3. 파생 인덱스 — 표를 뒤집기

`includes/periods.js:31-43`

`periods.js`의 `COMPARE_LABELS`가 대표 사례다. 선언과 사용의 **방향이 반대**라서 뒤집는다.

```
PERIODS          기간 → 비교 목록    "weekly는 wow와 yoy를 쓴다"      ← 사람이 쓰기 편한 방향
COMPARE_LABELS   비교 → 기간 목록    "yoy는 4개 기간에서 쓰인다"       ← 생성기가 쓰기 편한 방향
```

```js
const acc = {};
for (const [pName, p] of Object.entries(PERIODS)) {
  for (const [label, interval] of Object.entries(p.compare)) {
    acc[label] = acc[label] || {};   // 처음 보는 라벨이면 빈 객체
    acc[label][pName] = interval;
  }
}
```

실행 추적:

| pName | label | interval | `acc[label]` |
|---|---|---|---|
| daily | dod | 1 DAY | `undefined` → `{daily: "1 DAY"}` |
| daily | yoy | 1 YEAR | `undefined` → `{daily: "1 YEAR"}` |
| weekly | yoy | **364 DAY** | → `{daily: "1 YEAR", weekly: "364 DAY"}` |
| monthly | yoy | 1 YEAR | → `{daily, weekly, monthly}` |
| yearly | yoy | 1 YEAR | → `{daily, weekly, monthly, yearly}` |

결과 — 이 값이 만들어진다. 파일에 이렇게 적혀 있는 것은 아니다.

```js
COMPARE_LABELS = {
  dod: { daily: "1 DAY" },
  wow: { daily: "1 WEEK", weekly: "1 WEEK" },
  yoy: { daily: "1 YEAR", weekly: "364 DAY", monthly: "1 YEAR", yearly: "1 YEAR" },
  mom: { monthly: "1 MONTH" },
}
```

`yoy` 하나에 기간 4개가 쌓이면서 **`weekly`만 364일**이라는 사실이 보존된다.
이것이 `build.js`가 `CASE period_type`을 만드는 근거다.

---

## 4. `acc[x] = acc[x] || {}` — 없으면 초기화

`includes/periods.js:35 · includes/build.js:31`

```js
acc[label] = acc[label] || {};
acc[label][pName] = interval;
```

첫 줄이 없으면 `undefined`에 프로퍼티를 넣으려다 터진다.
`||`는 왼쪽이 falsy(`undefined` `null` `0` `""` `false`)면 오른쪽을 준다.

**주의** — 유효한 값이 falsy일 수 있으면 `??`(nullish 병합)를 써야 한다.
여기서는 `{}`나 배열만 담으므로 `||`로 충분하다.

같은 문법이 **기본값**에도 쓰인다.

```js
const dims = m.dims || allDims(m.entity);
// 지표가 dims 를 생략하면 그 entity 의 차원 전체를 쓴다
// → allDims("session") = ["country", "acquisition_channel",
//                         "entry_traffic_source", "browser"]
```

---

## 5. 계산된 키 `[변수]:` — 키 이름을 변수로

`definitions/sources/declarations.js:7-28` — 전문.

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

대괄호가 없으면 키가 문자열 `"dwDataset"`이 된다. 대괄호를 씌우면 **변수의 값**이 키가 된다.

```js
{ [dwDataset]: [...] }   // → { "dbt_dev_marts_core": [...] }
{ dwDataset: [...] }     // → { "dwDataset": [...] }        ← 틀림
```

첫 줄의 `dataform.projectConfig.vars`가 `workflow_settings.yaml`의 `vars`를 읽는다.
데이터셋 이름이 설정에서 오므로 키가 변수여야 한다.

마지막 세 줄이 실제로 Dataform에 등록하는 부분이다 — 데이터셋 하나에 테이블 여러 개이므로
`forEach` 두 겹으로 펼쳐 `declare()`를 9번 호출한다.

---

## 6. 화살표가 객체를 반환할 때 `({ ... })`

`includes/entities.js:13-14` — 정의.

```js
// from: null 이면 fact 자체 컬럼이라 조인이 필요 없다
const self = (col) => ({ from: null, key: null, col });
```

`includes/entities.js:22-30` — 쓰이는 곳. 마지막 줄만 `self()`다.

```js
    dims: {
      category:            { from: PRODUCT, key: "product_id", col: "category"   },
      brand:               { from: PRODUCT, key: "product_id", col: "brand"      },
      department:          { from: PRODUCT, key: "product_id", col: "department" },
      country:             { from: USER,    key: "user_id",    col: "country"             },
      age_group:           { from: USER,    key: "user_id",    col: "age_group"           },
      gender:              { from: USER,    key: "user_id",    col: "gender"              },
      acquisition_channel: { from: USER,    key: "user_id",    col: "acquisition_channel" },
      order_status:        self("order_status"),
    },
```

`self("order_status")`가 만드는 값은 `{ from: null, key: null, col: "order_status" }`다.
매번 `{ from: null, key: null, col: "..." }`를 쓰지 않으려고 만든 헬퍼다.

**괄호를 빼면 동작이 달라진다.** `{`가 객체 리터럴이 아니라 함수 본문 블록으로 읽혀서
`undefined`를 반환한다.

```js
(col) => ({ ... })   // 객체 반환
(col) =>  { ... }    // 본문 블록. return 이 없으면 undefined
```

**축약 프로퍼티** — `col: col` 대신 `col`만 썼다. 변수명과 키가 같으면 생략할 수 있다.

같은 형태가 `includes/metrics.js:16-20`에도 있다. 이쪽은 블록이라 `return`이 있다.

```js
const uniform = (entity, value) => {
  const acc = { time: value };
  for (const d of allDims(entity)) acc[d] = value;
  return acc;
};
```

`uniform("session", true)`가 `{ time: true, country: true, acquisition_channel: true,
entry_traffic_source: true, browser: true }`를 만든다. 축마다 손으로 쓰면 차원이 늘 때
지표 14개를 다 고쳐야 하므로, 선언은 짧게 두고 펼치는 일은 코드가 한다.

---

## 7. 스프레드 `...` — 객체 병합과 배열 펼치기

`includes/build.js:33-50` — `resolveDims`가 돌려주는 값을 만드는 부분.

```js
  return dims.map((d) => {
    const def = e.dims[d];
    // ... 검증 세 개 (11번 참조)
    return { name: d, ...def };
  });
```

선언에 없던 `name`을 붙여서 나중 단계가 차원 이름을 알 수 있게 한다.

```
def            { from: "sem_dim_products", key: "product_id", col: "category" }
{name, ...def} { name: "category", from: "sem_dim_products", key: "product_id", col: "category" }
```

원본 `def`는 바뀌지 않는다 — 새 객체가 만들어진다.
**뒤에 오는 것이 이긴다.** `{ ...def, name: d }`였다면 `def`에 `name`이 있을 때 그쪽이 덮인다.
여기서는 `name`을 먼저 뒀으므로 `def.name`이 이긴다.

배열에도 쓴다. `includes/build.js:57`:

```js
  return [...slots.values()];   // Map 의 값들을 배열로 펼침
```

`Map.values()`는 이터레이터라 그대로는 `map`·`join`을 쓸 수 없다. 배열로 펼쳐야 한다.

---

## 8. `Map` — 순서를 지키며 중복 제거

`includes/build.js:53-58` — 실제 코드 전문. **세 번째 줄이 밀도가 높다.**

```js
// 같은 (테이블, 키) 면 조인 한 번. 키가 다르면 별도 조인으로 남는다
const resolveJoins = (dims) => {
  const slots = new Map();
  for (const d of dims) if (d.from && !slots.has(joinAlias(d))) slots.set(joinAlias(d), d);
  return [...slots.values()];
};
```

그 한 줄을 풀어 쓰면 이렇다. **동작은 같고, 파일에는 위 형태로 들어 있다.**

```js
for (const d of dims) {
  if (!d.from) continue;                       // fact 자체 컬럼은 조인이 없다
  const slot = joinAlias(d);                   // "sem_dim_users__user_id"
  if (!slots.has(slot)) slots.set(slot, d);    // 처음 본 슬롯만 담는다
}
```

`for` 다음에 중괄호 없이 문장 하나만 오면 그 문장이 본문 전체다.
`&&`가 왼쪽이 거짓이면 오른쪽을 실행하지 않는 성질(단축 평가)을 조건으로 썼다.

`order_item`의 차원 8개 중 7개가 조인이 필요한데, 실제 조인은 **2번**이다.

```
category · brand · department              → sem_dim_products__product_id
country · age_group · gender · channel     → sem_dim_users__user_id
```

**키를 `(테이블, 키)` 조합으로 만드는 이유** — `joinAlias`가 `${d.from}__${d.key}`를
만든다(`build.js:24`). 테이블 이름만 쓰면 같은 dim을 서로 다른 키로 두 번 참조하는
경우(역할 차원)가 하나로 합쳐져 조용히 틀린 값이 나온다.

객체 대신 `Map`을 쓴 이유는 삽입 순서가 보장되기 때문이다. 생성되는 SQL의
`LEFT JOIN` 순서가 매번 같아야 diff를 읽을 수 있다.

---

## 9. 고차 함수 — `map` · `filter` · `join`

SQL 조립은 대부분 이 셋의 조합이다. `includes/build.js:76-79`:

```js
  ${dims.map(dimSelect).join(",\n  ")},
  ${m.expr} AS ${name}
FROM ${ctx.ref(e.source)} AS base
${joins.map((d) => joinClause(ctx, d)).join("\n")}
```

`map`이 배열을 배열로 바꾸고 `join`이 문자열 하나로 합친다.

```
["category", "country"]
  → map(dimSelect)  ["p.category AS category", "u.country AS country"]
  → join(",\n  ")   "p.category AS category,\n  u.country AS country"
```

`dimSelect`를 괄호 없이 넘긴 것에 주의. `map(dimSelect)`는 함수 자체를 넘기는 것이고
`map(dimSelect(d))`였다면 호출 결과를 넘기는 것이라 틀린다.
인자가 더 필요하면 `(d) => joinClause(ctx, d)`처럼 감싼다.

`filter`로 후보를 거른다. `includes/build.js:120`:

```js
  const usable = Object.keys(PERIODS).filter((pName) => canRollup(m, pName));
```

**콜백에서 구조 분해**도 자주 쓴다. `includes/build.js:133-137`:

```js
    const applicable = Object.entries(byPeriod).filter(([pName]) => usable.includes(pName));
    if (applicable.length === 0) continue;

    const a  = `b_${label}`;
    const in_ = applicable.map(([pName]) => `'${pName}'`).join(", ");
```

`([pName])`는 `[키, 값]` 쌍에서 첫 원소만 꺼내고 값은 버린다는 뜻이다.
둘 다 필요하면 `([pName, iv])`로 받는다.

---

## 10. 템플릿 리터럴 — SQL 조립

`includes/build.js:68-82` — `dailySQL` 전문.

```js
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
```

백틱 문자열은 줄바꿈과 `${}` 삽입을 지원한다.

- **중첩 가능** — `${m.filter ? \`WHERE ${m.filter}\` : ""}`처럼 안에 또 백틱을 쓴다
- **조건부 절**은 삼항 연산자로. `filter`가 없으면 빈 문자열이 되어 그 줄이 사라진다
- 맨 앞 줄바꿈을 없애려고 `.trim()`을 붙인다

`ctx.ref(...)`는 Dataform이 주는 함수로, 이름을 정규화된 테이블 경로로 바꾸고
**동시에 의존 관계를 등록한다.** 문자열을 직접 쓰면 그래프에 엣지가 생기지 않는다.

`includes/build.js:60-65`의 두 헬퍼도 같은 방식이다.

```js
const dimSelect = (d) =>
  d.from ? `${joinAlias(d)}.${d.col} AS ${d.name}` : `base.${d.col} AS ${d.name}`;

const joinClause = (ctx, d) =>
  `LEFT JOIN ${ctx.ref(d.from)} AS ${joinAlias(d)}\n` +
  `  ON base.${d.key} = ${joinAlias(d)}.${d.ref_key || d.key}`;
```

`dimSelect`는 삼항 연산자로 두 형태를 고른다 — 조인해서 온 차원이면 별칭을 붙이고,
fact 자체 컬럼(`from: null`)이면 `base.`를 쓴다.

---

## 11. `throw` — 컴파일 타임에 멈추기

`includes/build.js:27-51` — `resolveDims` 전문. 예외 세 개가 여기 모여 있다.

```js
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
```

이 한 함수에 앞서 본 패턴이 여섯 개 들어 있다.

| 줄 | 패턴 |
|---|---|
| `m.dims \|\| allDims(m.entity)` | 기본값 (4번) |
| `dims.map((d) => {...})` | 고차 함수 (9번) |
| `` `[${name}] ...` `` | 템플릿 리터럴 (10번) |
| `!(d in m.additive)` | 키 존재 검사 (15번) |
| `m.additive[d] === false` | 값 검사 — 15번과 짝 |
| `{ name: d, ...def }` | 스프레드 병합 (7번) |

`build.js` 전체에서 `throw`는 5곳이고 전부 **선언이 잘못됐을 때**다.
나머지 둘은 `metricSQL`의 "생성 가능한 기간이 없다"와 위 `알 수 없는 entity`다.

Dataform은 include를 컴파일할 때 이 코드를 실행하므로, 예외가 나면
`dataform compile`이 실패한다. **런타임에 조용히 틀린 숫자가 나오는 대신
배포 전에 멈춘다.**

메시지에 `사용 가능:` 목록을 붙이는 이유는 오타 하나에 파일을 뒤지지 않게 하려는 것이다.

---

## 12. `module.exports` — Dataform에서의 동작

각 파일 끝에서 무엇을 밖으로 내보낼지 정한다.

```js
// includes/naming.js:16
module.exports = { MART_PREFIX, martName, dailyName, metricName, baseColumn };

// includes/periods.js:42
module.exports = { PERIODS, COMPARE_LABELS };

// includes/entities.js:79
module.exports = { ENTITIES, allDims };

// includes/metrics.js:133
module.exports = { METRICS, RATIOS, EXCLUDED, HLL_PRECISION };

// includes/build.js:174-178
module.exports = {
  seq, eqNullSafe, joinAlias,
  resolveDims, resolveJoins, rollupExpr, canRollup,
  dailySQL, metricSQL,
};
```

내보내지 않은 것은 파일 안에서만 산다 — `entities.js`의 `self`, `metrics.js`의
`uniform`·`hll`, `build.js`의 `dimSelect`·`joinClause`·`rollupBlock`이 그렇다.
헬퍼가 밖으로 새면 그것도 계약이 되어 바꾸기 어려워진다.

받는 쪽은 구조 분해로 필요한 것만 꺼낸다. `includes/build.js:11-13`:

```js
const { ENTITIES, allDims }      = require("includes/entities");
const { PERIODS, COMPARE_LABELS } = require("includes/periods");
const { dailyName, baseColumn }   = require("includes/naming");
```

`naming.js`는 5개를 내보내는데 `build.js`는 2개만 받는다. 무엇을 쓰는지가 파일 맨 위에 드러난다.

**`includes/`의 파일은 두 가지로 쓸 수 있다.**

```js
// (1) 다른 include 에서 — 명시적 require
const { ENTITIES } = require("includes/entities");

// (2) definitions 의 sqlx/js 에서 — 파일명이 전역으로 주입됨
${metrics.select()}
```

이 레포는 (1)만 쓴다. 명시적이라 어느 파일이 무엇을 읽는지 추적할 수 있다.

**`require("includes/x")`는 Dataform의 경로 규칙**이라 순수 node로는 해석되지 않는다.
로컬에서 테스트하려면 `Module._resolveFilename`을 패치해야 한다.

---

## 13. `Array.from({ length: n })` — 숫자 범위 만들기

`includes/build.js:16`

```js
const seq = (n) => Array.from({ length: n }, (_, i) => i + 1).join(", ");

seq(4)   // → "1, 2, 3, 4"
```

`GROUP BY 1, 2, 3, 4`를 만드는 데 쓴다. 컬럼 수가 선언에 따라 달라지므로 계산해야 한다.

- `{ length: n }`은 **유사 배열(array-like)** 이다. `length`만 있으면 `Array.from`이 배열로 바꿔준다
- 두 번째 인자는 각 원소를 만드는 함수. `(원소, 인덱스)`를 받는데 원소는 `undefined`라 안 쓴다
- **`_`는 "이 인자는 쓰지 않는다"는 관례**다. 문법이 아니라 약속이고, `x`라고 써도 동작은 같다

---

## 14. `switch` + `return` — `break`가 없는 이유

`includes/build.js:85-93`

```js
function rollupExpr(col, additive) {
  switch (additive) {
    case true:     return `SUM(${col})`;
    case "sketch": return `HLL_COUNT.MERGE_PARTIAL(${col})`;
    case "last":   return `ANY_VALUE(${col} HAVING MAX dt)`;
    default:       return null;
  }
}
```

`switch`는 보통 `break`가 필요하다. 없으면 다음 `case`로 흘러내린다(fall-through).
여기서는 **`return`이 함수를 즉시 끝내므로** `break`가 필요 없다.

`default: return null`이 "롤업할 수 없다"는 신호다. 호출한 쪽(`canRollup`)이
`!== null`로 검사해 생성 여부를 정한다 — 예외를 던지지 않고 값으로 표현했다.

---

## 15. `in` 연산자 — "키가 없다"와 "값이 falsy다"는 다르다

`includes/build.js:41-48`

**이 파일에서 가장 미묘한 부분이다.**

```js
    if (!(d in m.additive)) {
      throw new Error(`[${name}] 차원 '${d}'의 가산성이 선언되지 않았다 (P9)`);
    }
    if (m.additive[d] === false) {
      throw new Error(
        `[${name}] 차원 '${d}'가 비가산이다. entity를 옮기거나 스케치로 바꾼다 (P10)`
      );
    }
```

`additive`의 값으로 `false`가 올 수 있기 때문에 두 검사를 나눠야 한다.

설명용 예시로 값을 하나 두고 보자.

```js
const additive = { time: true, category: false };

"category" in additive     // true   ← 선언은 되어 있다
additive.category          // false  ← 값이 falsy
!additive.category         // true   ← 이걸로 검사하면 "미선언"으로 오판한다
```

`in`은 **키의 존재**만 본다. 값이 `false`든 `0`이든 상관없다.

두 오류는 고치는 방법이 다르다 — 앞은 선언을 추가하는 것이고,
뒤는 entity를 옮기거나 스케치로 바꾸는 것이다. 그래서 메시지도 다르다.

---

## 16. `continue` — 이번 회차만 건너뛰기

`includes/build.js:132-137`:

```js
  for (const [label, byPeriod] of Object.entries(COMPARE_LABELS)) {
    const applicable = Object.entries(byPeriod).filter(([pName]) => usable.includes(pName));
    if (applicable.length === 0) continue;

    const a  = `b_${label}`;
    const in_ = applicable.map(([pName]) => `'${pName}'`).join(", ");
```

`break`는 루프를 끝내지만 `continue`는 다음 회차로 넘어간다.
쓸 수 있는 기간이 하나도 없는 비교 라벨은 컬럼을 만들지 않고 넘긴다.

**언제 그런 일이 생기나** — `additive.time`이 `false`인 지표는 `usable`에 `daily`만 남는다.
그러면 `mom`(monthly 전용)은 `applicable`이 비어 `mom_base` 컬럼 자체가 만들어지지 않는다.
NULL로 채운 컬럼을 두면 소비자가 "값이 없다"와 "만들지 않았다"를 구별할 수 없다.

같은 뜻을 `if (applicable.length > 0) { ... }`로 감쌀 수도 있지만,
**들여쓰기가 한 겹 줄어서** `continue` 쪽이 읽기 쉽다.

---

## 17. 이중 이스케이프 — JS 문자열 안의 SQL 문자열

`includes/build.js:20-21`

```js
const eqNullSafe = (l, r) =>
  `COALESCE(CAST(${l} AS STRING), '\\u0000') = COALESCE(CAST(${r} AS STRING), '\\u0000')`;
```

JS 소스의 `\\u0000`이 만드는 **문자열**은 `\u0000`(백슬래시 + u0000, 6글자)이다.
JS는 여기서 아무 문자도 만들지 않는다 — 그냥 텍스트다.

그 텍스트가 SQL로 넘어가면 **BigQuery의 파서**가 `'\u0000'`을 NUL 문자로 해석한다.

```
JS 소스      '\\u0000'      ← 백슬래시를 이스케이프
생성된 SQL   '\u0000'       ← 6글자 텍스트. 실제 NUL 문자가 아니다
BigQuery     NUL 문자        ← SQL 파서가 해석
```

**이스케이프가 두 단계**라는 것이 요점이다. `\u0000`이라고 쓰면 JS가 먼저
NUL 문자를 만들어버려서 생성된 SQL 파일에 보이지 않는 제어문자가 섞인다.

NUL을 고른 이유는 실제 데이터에 나올 일이 없어 **차원 값과 충돌하지 않는 sentinel**이기
때문이다. `'~'`이나 `'__NULL__'`을 쓰면 그 값을 가진 행과 구별되지 않는다.

---

## 18. 병렬 누적 배열 — 조인과 컬럼을 같이 모으기

`includes/build.js:130-155` — 루프 전문.

```js
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
```

하나의 비교 라벨이 **SQL의 두 자리**에 흔적을 남긴다 — `SELECT` 절의 컬럼과 `FROM` 뒤의 조인.
두 자리가 떨어져 있으므로 배열을 둘 두고 같이 채운 뒤 마지막에 각각 `join()`한다.

`yoy` 한 번의 회차가 만드는 것:

```sql
SELECT ..., b_yoy.net_revenue AS yoy_base      ← cols 에 push
FROM rolled AS c
LEFT JOIN rolled AS b_yoy ON ...               ← joins 에 push
```

**둘의 순서가 어긋나면 안 되므로** 같은 루프에서 같이 push 한다.

`shift`의 삼항 연산자는 10번(템플릿 리터럴)과 9번(고차 함수)이 겹친 곳이다.
기간이 하나면 `DATE_SUB` 한 줄, 여럿이면 `CASE`를 조립한다 —
`applicable.length === 1`로 갈라 불필요한 `CASE`를 만들지 않는다.

`applicable[0][1]`은 `[["monthly", "1 MONTH"]]`의 첫 쌍의 두 번째 원소,
곧 `"1 MONTH"`다. 배열의 배열이라 인덱스가 두 겹이다.

---

## `build.js` 읽는 순서

위 패턴을 알면 이 순서로 읽는 것이 가장 빠르다.

| 순서 | 대상 | 무엇을 보나 |
|---|---|---|
| 1 | `resolveDims` | **선언 검증.** 어떤 잘못을 어떻게 잡는지 (15번) |
| 2 | `resolveJoins` · `joinAlias` | 차원 목록 → 조인 슬롯 (8번) |
| 3 | `dailySQL` | 1·2를 써서 SQL 한 덩이를 만든다 (10번) |
| 4 | `rollupExpr` · `canRollup` | `additive` → 함수 선택, 생성 가부 (14번) |
| 5 | `rollupBlock` | 기간 하나의 `SELECT` 블록 |
| 6 | `metricSQL` | 5를 `UNION ALL` + 비교 조인 조립 (16·18번) |

`metricSQL`은 세 덩이로 나뉜다.

```
1) blocks    기간별 SELECT 를 UNION ALL 로 이어 붙임        → rolled CTE 의 내용
2) joins/cols 비교 라벨마다 조인 한 줄 + 컬럼 한 줄          → 병렬 배열
3) 조립       WITH daily → rolled → SELECT + joins          → 최종 문자열
```

`ctx`는 Dataform이 넘겨주는 객체다. `ctx.ref(name)`이 이름을 정규화된 테이블
경로로 바꾸면서 **동시에 의존 관계를 등록한다.** 그래서 `build.js`는 프로젝트 이름도,
데이터셋 이름도 모른다 — 알 필요가 없게 만든 것이다.

---

## 요약 — 어디에 무엇이 쓰였나

| 패턴 | 쓰인 곳 |
|---|---|
| `Object.entries` 순회 | `periods.js` `build.js` `declarations.js` |
| IIFE | `periods.js` — `COMPARE_LABELS` |
| 파생 인덱스 | `periods.js` — 표 뒤집기 |
| `|| {}` 초기화 · 기본값 | `periods.js` `build.js` |
| 계산된 키 `[x]:` | `declarations.js` — 데이터셋명이 vars에서 옴 |
| `=> ({...})` | `entities.js` — `self()` |
| 스프레드 병합 | `build.js` — `{ name: d, ...def }` |
| `Map` 중복 제거 | `build.js` — `resolveJoins` |
| `map`·`filter`·`join` | `build.js` 전반 |
| 템플릿 리터럴 | `build.js` — SQL 조립 |
| `throw` | `build.js` — 선언 검증 5곳 |
| `Array.from({length})` | `build.js` — `seq()` |
| `switch` + `return` | `build.js` — `rollupExpr` |
| `in` 연산자 | `build.js` — 미선언과 `false` 구분 |
| `continue` | `build.js` — `metricSQL` 비교 루프 |
| 이중 이스케이프 | `build.js` — `eqNullSafe` |
| 병렬 누적 배열 | `build.js` — `joins` · `cols` |
