# 파일별 역할

무엇을 고치면 무엇이 바뀌는지. 용어는 [glossary.md](glossary.md) 를 따른다.
설계의 근거는 [architecture.md](architecture.md) 에 있다.

## 한눈에

```
includes/            선언 계층 — 사람이 쓰는 곳
  naming.js      40   이름 규칙
  periods.js     86   기간 선언
  entities.js   156   entity 와 join graph
  metrics.js    147   지표 선언
  build.js      518   SQL builder — 정책이 집행되는 곳

definitions/         Dataform action — 선언을 테이블로 만드는 곳
  sources/declarations.js        28   DW 읽기 전용 참조
  mart/*.sqlx                     7개  semantic_mart
  assertions/upstream_contract.js 86   DW 감시
  semantic/gen_daily.js           54   daily_<metric>
  semantic/gen_period.js          61   period_<metric>
  semantic/gen_metric.js          64   metric_<metric>
  metadata/gen_registry.js       158   metric_registry

infra/               실행 계획 — GCP 리소스 선언
  workflows.json  63   언제 어떤 태그를 어떤 계정으로 돌리는가
  apply.js       119   위 선언을 Dataform 에 적용

workflow_settings.yaml  19   프로젝트 · 리전 · 데이터셋 이름
```

## 무엇을 고칠 때 어디를 여는가

| 하려는 일 | 여는 파일 | 바뀌는 것 |
|---|---|---|
| 지표 추가 | `metrics.js` 한 항목 | 테이블 3개 + registry 1행 |
| 새 fact 위의 지표 | `entities.js` + `metrics.js` | 위와 같고 entity 항목이 하나 는다 |
| dimension 추가 | `entities.js` 의 `dims` | 그 entity 의 모든 지표 |
| 서빙 dimension 변경 | `entities.js` 의 `serving_dims` | `period_`·`metric_` 의 컬럼과 행 수 |
| 기간 추가 | `periods.js` 한 항목 | 전 지표에 값 컬럼 1개 + 비교 컬럼 n개 |
| 비교 간격 변경 | `periods.js` 의 `compare` | 그 기간의 비교 컬럼 |
| 갱신 방식 변경 | `entities.js` 의 `refresh` | 그 entity 의 `daily_` |
| 스케줄 변경 | `infra/workflows.json` → `node infra/apply.js` | Dataform 의 실행 설정 |
| 구조 변경 | `build.js` | 전부. 거의 열지 않는다 |

**지표 하나를 추가할 때 만지는 파일은 `metrics.js` 하나다.** 나머지는 고정이다.

---

## `includes/` — 선언 계층

### `naming.js` (40줄)

이름 규칙을 한 곳에 모은다. 규칙이 흩어지면 `ctx.ref()` 가 끊어진다.

| export | 산출 |
|---|---|
| `martName(base)` | `sem_` 접두사. DW 와 이름이 겹치면 `ref()` 가 충돌한다 |
| `dailyName` · `periodName` · `metricName` | `daily_<metric>` · `period_<metric>` · `metric_<metric>` |
| `RECORD_DATE` | `record_date`. 세 단계가 같은 날짜 컬럼 이름을 쓴다 |
| `valueColumn(metric, period)` | `net_revenue` · `net_revenue_wtd` |
| `baseColumn(period, label)` | `wow_base` · `wtd_wow_base` |

**이 파일은 아무것도 읽지 않는다.** 이름 규칙이 다른 선언에 의존하면 순환한다.

### `periods.js` (86줄)

기간을 선언한다. 기간은 행이 아니라 컬럼이다.

```js
PERIODS = {
  daily: { type: "passthrough", trunc: null,           end_flag: null,           compare: { dod, wow, yoy } },
  wtd:   { type: "cumulative",  trunc: "WEEK(MONDAY)", end_flag: "is_week_end",  compare: { wow, yoy: "364 DAY" } },
  mtd:   { type: "cumulative",  trunc: "MONTH",        end_flag: "is_month_end", compare: { mom, yoy } },
  ytd:   { type: "cumulative",  trunc: "YEAR",         end_flag: "is_year_end",  compare: { yoy } },
}
```

| export | 무엇 |
|---|---|
| `PERIODS` | 위 선언 |
| `CUMULATIVE` | PTD 기간 이름 목록. 선언 순서를 유지한다 |
| `END_FLAGS` | `is_week_end` 등 완결 플래그와 그 `trunc` |
| `SHIFTS` | 간격 → 그 간격으로 가져올 [기간, 라벨]. `PERIODS` 를 뒤집은 것 |

주의할 점이 셋 있다.

- **PTD 는 좁은 것부터 선언해야 한다.** sketch PTD 가 가장 넓은 구간으로 한 번만
  self-join 하고 좁은 기간을 `IF` 로 걸러내기 때문에, 마지막 것이 조인 범위가 된다
- **`wtd` 의 `yoy` 만 364일이다.** `1 YEAR` 로 하면 요일이 어긋난다
- **`SHIFTS` 가 self-join 수를 정한다.** 비교 컬럼 8개가 간격 5개에서 나오므로 조인은 5번이다

### `entities.js` (156줄)

지표를 산출하는 fact 가 entity 가 된다. entity 가 정해지면 grain 과 쓸 수 있는
dimension 이 따라서 정해진다.

| 항목 | 무엇 | 바꾸면 |
|---|---|---|
| `source` | 읽을 `sem_fct_*` | 그 entity 의 모든 지표가 다른 테이블을 읽는다 |
| `pk` · `grain` | surrogate key 와 한 행의 뜻 | 문서용. assertion 이 검사한다 |
| `date_col` | `record_date` 가 될 컬럼 | 모든 지표의 날짜 축 |
| `joins` | 어느 테이블에 어느 키로 붙는가. **이름을 준다** | 지표 수식이 쓰는 이름 |
| `dims` | 그 조인에서 어느 컬럼을 dimension 으로 쓰는가 | `daily_` 의 컬럼 |
| `serving_dims` | `dims` 중 `period_`·`metric_` 이 가질 것 | 서빙 테이블의 컬럼과 행 수 |
| `refresh` | `"incremental"` 또는 `"table"` | `daily_` 의 갱신 방식 |

**`joins` 와 `dims` 를 나눠 선언한다.** 둘을 합치면 조인에 부를 이름이 없어진다.
이름이 있어야 지표 수식이 dimension 테이블의 컬럼을 가리킬 수 있다.

```js
joins: { product: { to: PRODUCT, key: "product_id" } },
dims:  { category: { via: "product", col: "category" } },
expr:  "SUM(IF({is_revenue_recognized}, {product.unit_cost}, 0))"
```

`product` 는 여기 적힌 이름이지 builder 가 만든 alias 가 아니다. **선언이 builder
내부를 모른다.** 이 이름이 그대로 SQL alias 가 되므로 예약어면 컴파일 타임에 거부된다.

현재 4개 entity 가 있다.

| entity | source | grain | `dims` | `serving_dims` |
|---|---|---|---|---|
| `order_item` | `sem_fct_order_items` | 주문 라인 1건 | 7 | 4 |
| `order` | `sem_fct_orders` | 주문 1건 | 5 | 4 |
| `session` | `sem_fct_sessions` | 세션 1건 | 4 | 2 |
| `user_event` | `sem_fct_user_events` | 이벤트 1건 | 3 | 1 |

**`order` 에 상품 dimension 이 없는 것은 누락이 아니다.** 한 주문이 여러 상품을
포함하므로 주문 grain 에서 category 가 정의되지 않는다.

### `metrics.js` (147줄)

| export | 내용 |
|---|---|
| `METRICS` | 지표 15개. `entity` · `expr` · `filter` · `dims` · `additive` · `description` |
| `RATIOS` | 비율 지표 7개. 테이블을 만들지 않고 registry 행으로만 존재한다 |
| `EXCLUDED` | 만들지 않기로 한 5개와 그 사유 |
| `HLL_PRECISION` | 15 고정 |

`additive` 는 플래그가 아니라 **축별 객체**다.

```
true      그 축으로 합산 가능        SUM
"sketch"  병합 가능한 중간 상태      HLL_COUNT.MERGE_PARTIAL
"last"    스냅샷                    마지막 값
false     복원 불가                 생성 거부
```

dimension 축에 `false` 가 나오면 기록할 사실이 아니라 **고칠 신호**다 — entity 가 틀렸다.
현재 15개 지표에 `false` 는 하나도 없다.

**지표 수식의 컬럼은 중괄호로 표시한다.** 중괄호 밖은 builder 가 건드리지 않으므로
어떤 SQL 이든 그대로 쓸 수 있다.

```
{sale_price}          →  base.sale_price        fact 컬럼
{product.unit_cost}   →  product.unit_cost      조인해서 오는 컬럼
```

접두사가 없으면 조인한 dimension 테이블과 이름이 겹치는 순간 모호해진다 — `unit_cost` 는
fact 와 `sem_dim_products` 양쪽에, `user_id` 는 fact 와 `sem_dim_users` 양쪽에 있다.
`dataform compile` 은 문자열이라 통과시키고 BigQuery 실행 단계에서야 터진다.

### `build.js` (518줄)

정책이 실제로 집행되는 곳. 초기에 한 번 쓰고 거의 건드리지 않는다.

| 함수 | 역할 |
|---|---|
| `resolveDims(name, m)` | 선언 검증. 미선언 dimension, `additive` 키 누락, dimension 축 `false` 면 예외 |
| `renderExpr(name, m, sql, where)` | `{col}` → `base.col`, `{join.col}` → `join.col` |
| `exprJoins(name, m, sql, where)` | 수식이 참조한 조인 이름. 선언 안 된 이름이면 예외 |
| `resolveJoins(name, m, dims)` | 실제로 쓰이는 조인만 선언 순서로. 예약어·`base` 이름이면 예외 |
| `servingAxes(name, m)` | `serving_dims` ∩ 그 지표가 선언한 `dims` |
| `dailySQL(ctx, name, m)` | 조인 + `record_date × dims GROUP BY` |
| `foldExpr(col, additive)` | `additive` → 합치는 함수. `null` 이면 생성 거부 |
| `dimFold(name, m, dims)` | dimension 축을 합칠 함수. 축마다 가산성이 다르면 예외 |
| `periodSQL(ctx, name, m)` | `base` → `grid` → `cum` → rollup |
| `comparePlan(m)` | 비교 컬럼 8개와 각각의 기간·간격 |
| `metricSQL(ctx, name, m)` | 간격별 self-join 5번 + 비교 기준값 |

#### `periodSQL` 이 만드는 네 단계

```sql
WITH daily AS ( SELECT * FROM daily_<metric> ),
base AS (  -- serving_dims 로 집계. rollup 행은 아직 없다
  SELECT record_date, COALESCE(country,'(unknown)') AS country, ..., SUM(v) FROM daily GROUP BY ...
),
grid AS (  -- sem_dim_date × base 의 dimension 조합. 없으면 0 / NULL
  SELECT d.record_date, c.country, ..., COALESCE(a.v, 0) AS v
  FROM (dates) d CROSS JOIN (SELECT DISTINCT ... FROM base) c
  LEFT JOIN base a ON a.record_date = d.record_date AND a.country = c.country AND ...
),
cum AS (   -- PTD. 가산은 창 함수, sketch 는 구간 self-join
  SELECT record_date, ..., v AS net_revenue,
         SUM(v) OVER (PARTITION BY ..., DATE_TRUNC(record_date, MONTH) ORDER BY record_date) AS net_revenue_mtd, ...
  FROM grid
)
-- rollup 단계. axis_mask 로 '(all)' 행을 만든다
SELECT cum.record_date,
       IF((axis_mask >> 0) & 1 = 1, cum.country, '(all)') AS country, ...,
       cum.record_date = LAST_DAY(cum.record_date, MONTH) AS is_month_end, ...,
       SUM(cum.net_revenue_mtd) AS net_revenue_mtd, ...
FROM cum CROSS JOIN UNNEST(GENERATE_ARRAY(0, 15)) AS axis_mask
GROUP BY 1, 2, 3, 4, 5
```

#### 읽는 순서

| 순서 | 대상 | 무엇을 보나 |
|---|---|---|
| 1 | `resolveDims` · `renderExpr` | 선언 검증. 어떤 잘못을 어떻게 잡는지 |
| 2 | `resolveJoins` · `joinClause` | 선언된 조인 중 실제로 쓰이는 것만 |
| 3 | `dailySQL` | 1·2를 써서 SQL 한 덩이를 만든다 |
| 4 | `foldExpr` · `dimFold` | `additive` → 함수 선택 |
| 5 | `baseCTE` · `gridCTE` | dimension 좁히기와 빈 날 채우기 |
| 6 | `cumWindowed` · `cumSketch` · `rollupSelect` | PTD 두 갈래와 `'(all)'` 행 |
| 7 | `comparePlan` · `metricSQL` | 비교 컬럼 판정과 간격별 조인 |

JS 문법이 낯설면 [js-patterns.md](js-patterns.md) 를 먼저 본다.

---

## `definitions/` — Dataform action

builder 가 SQL 문자열을 만들고, generator 가 그것을 Dataform action 으로 만든다.

| | 파일 | 하는 일 |
|---|---|---|
| **builder** | `includes/build.js` | 선언을 읽어 SQL 문자열을 만든다 |
| **generator** | `definitions/**/gen_*.js` | builder 를 불러 테이블을 만든다 |

### `sources/declarations.js` (28줄)

DW 테이블을 읽기 전용으로 선언한다. **여기 없는 DW 테이블은 참조할 수 없다.**
`dbt_dev_marts_core` 8개와 `snapshots` 1개를 선언한다.

### `mart/*.sqlx` (7개)

DW 를 `semantic_mart` 로 정규화한다. **사람이 SQL 을 쓰는 유일한 곳**이다.

| 파일 | 하는 일 |
|---|---|
| `sem_dim_users` · `sem_dim_products` | 이름 정규화, 파생 dimension(`age_group` 등), `'(unknown)'` 채우기 |
| `sem_dim_date` | 2018~2031 날짜. `grid` 의 날짜 원천 |
| `sem_fct_*` (4개) | surrogate key 부여, 자연키 제거, grain 보증 |

각 파일에 게이트 assertion 이 붙는다. 깨지면 파이프라인이 멈춘다.

### `assertions/upstream_contract.js` (86줄)

DW 가 계약을 어겼는지 감시한다. **게이트가 아니라 감시다** — 깨져도 파이프라인은 돈다.
원인이 dbt-airflow 쪽에 있어 우리가 고칠 수 없기 때문이다. 태그가 `monitoring` 이라
별도 워크플로로 돈다.

현재 3건이 상시 실패 상태이고, 그것이 정상이다. 내용은
[operations.md](operations.md) 에 있다.

### `semantic/gen_daily.js` · `gen_period.js` · `gen_metric.js`

각각 15개 테이블을 만든다. 셋 다 모양이 같다.

```js
Object.entries(METRICS).forEach(([name, m]) => {
  publish(dailyName(name), { type, schema, columns, assertions, bigquery })
    .preOps((ctx) => ctx.when(ctx.incremental(), incrementalPreOps(ctx, e)))
    .query((ctx) => dailySQL(ctx, name, m, { incremental: ctx.incremental() }));
});
```

**선언 하나가 테이블 하나가 된다.** 지표를 추가하면 `forEach` 가 한 바퀴 더 돈다.

`gen_daily.js` 만 `preOps` 가 있다. 증분 구간을 지우고 다시 넣기 위해서다.

### `metadata/gen_registry.js` (158줄)

`metric_registry` 를 만든다. **`ctx.ref()` 가 없는 유일한 generator** 로, 테이블을 하나도
읽지 않고 선언만 읽어 리터럴로 만든다.

세 종류가 한 테이블에 들어간다.

```
METRICS    테이블이 생성된다                       is_generated = true
RATIOS     테이블을 만들지 않는다                   is_generated = false
EXCLUDED   의도적으로 만들지 않는다. 사유를 남긴다   is_generated = false
```

"생성되지 않았다" 와 "존재하지 않는다" 는 다르다. 비율 7개와 제외 5개는 registry 가
유일한 거처다.

---

## `infra/` — 실행 계획

Dataform 의 release configuration 과 workflow configuration 은 GCP 리소스라 git 에
남지 않는다. 레포만 보고는 무엇이 언제 도는지 알 수 없다.

| 파일 | 하는 일 |
|---|---|
| `workflows.json` | 그 설정의 원천. 태그 · 스케줄 · 실행 계정 |
| `apply.js` | 선언과 실제 상태를 비교해 맞춘다. `node infra/apply.js --dry-run` 으로 차이를 본다 |

---

## 무엇이 무엇을 참조하는가

### 파일 간

```
naming.js ──→ entities.js ──┬──→ metrics.js
                            │
     ┌──────────────────────┘
     │
periods.js ──┬──→ build.js
naming.js  ──┘

build.js ────────→ gen_daily.js · gen_period.js · gen_metric.js
metrics.js ──────→ gen_registry.js   (테이블을 안 읽는다)
```

`naming.js` 는 아무것도 읽지 않는다. `build.js` 가 나머지를 모두 읽고, 선언 파일끼리는
`naming → entities → metrics` 한 줄이다.

### 테이블 간

`dataform compile` 이 `ctx.ref()` 호출로 만드는 그래프다.

```
dim_products     → sem_dim_products
dim_users        → sem_dim_users
fct_order_items  → sem_fct_order_items
fct_orders       → sem_fct_orders
fct_sessions     → sem_fct_sessions
fct_user_events  → sem_fct_user_events
(없음)           → sem_dim_date ──→ period_<metric>

sem_* ──→ daily_<metric> ──→ period_<metric> ──→ metric_<metric>
(없음)   →  metric_registry
```

**마트 테이블끼리는 서로 참조하지 않는다.** 전부 DW declaration 만 읽는다 — fact 간
조인이 금지되어 있기 때문이다.

**`daily_` 는 `sem_dim_date` 를 조인하지 않는다.** `dims` 전체(최대 7개)로 빈 날을
채우면 지표 하나가 수백만 행이 된다. 빈 날을 채우는 곳은 `period_` 의 `grid` 다.

---

**다음으로 읽을 것**

| | |
|---|---|
| 왜 이 구조인가 | [architecture.md](architecture.md) |
| 테이블 구조 | [tables.md](tables.md) |
| 판단 기준 P1~P22 | [principles.md](principles.md) |
| 지표 추가 절차 | [metrics.md](metrics.md) 7장 |
| JS 문법 | [js-patterns.md](js-patterns.md) |
