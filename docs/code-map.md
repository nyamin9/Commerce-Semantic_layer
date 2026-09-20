# 파일별 역할

- 무엇을 고치면 무엇이 바뀌는지
- 용어는 [glossary.md](glossary.md) 를 따름
- 설계의 근거는 [architecture.md](architecture.md) 에 있음

## 1. 한눈에

```
includes/            선언 계층 — 사람이 쓰는 곳
  naming.js      40   이름 규칙
  periods.js     86   기간 선언
  entities.js   167   entity 와 join graph
  metrics.js    176   지표 선언
  build.js      549   SQL builder — 선언을 검사하고 SQL 로 바꾸는 곳

definitions/         Dataform action — 선언을 테이블로 만드는 곳
  sources/declarations.js        28   DW 읽기 전용 참조
  mart/*.sqlx                     7개  semantic_mart
  assertions/upstream_contract.js 86   DW 감시
  assertions/partition_contract.js     파티션 컬럼 계약
  semantic/gen_daily.js           54   daily_<metric>           지표당 하나
  semantic/gen_period.js          65   period_<metric>[__조합]  조합마다 하나
  semantic/gen_metric.js          68   metric_<metric>[__조합]  조합마다 하나
  metadata/gen_registry.js       158   metric_registry

infra/               실행 계획 — GCP resource 선언
  workflows.json  63   언제 어떤 태그를 어떤 계정으로 돌리는가
  apply.js       119   위 선언을 Dataform 에 적용

workflow_settings.yaml  19   프로젝트 · 리전 · 데이터셋 이름
```

## 2. 무엇을 고칠 때 어디를 여는가

| 하려는 일 | 여는 파일 | 바뀌는 것 |
|---|---|---|
| 지표 추가 | `metrics.js` 한 항목 | 테이블 3개 + registry 1행 |
| 새 fact 위의 지표 | `entities.js` + `metrics.js` | 위와 같고 entity 항목이 하나 늚 |
| dimension 추가 | `entities.js` 의 `dims` | 그 entity 의 모든 지표 |
| 서빙 dimension 변경 | `entities.js` 의 `serving_dims` | 그 entity 의 모든 지표의 dimension 조합 |
| 한 지표만 dimension 을 좁힘 | `metrics.js` 의 `serving_dims` | 그 지표의 `period_`·`metric_` 만 |
| 기간 추가 | `periods.js` 한 항목 | 전 지표에 값 컬럼 1개 + 비교 컬럼 n개 |
| 비교 간격 변경 | `periods.js` 의 `compare` | 그 기간의 비교 컬럼 |
| 갱신 방식 변경 | `entities.js` 의 `refresh` | 그 entity 의 `daily_` |
| 스케줄 변경 | `infra/workflows.json` → `node infra/apply.js` | Dataform 의 실행 설정 |
| 구조 변경 | `build.js` | 전부. 거의 열지 않음 |

- **지표 하나를 추가할 때 만지는 파일은 `metrics.js` 하나임.** 나머지는 고정임

- dimension 선언은 세 칸임

| | 어디 | 뜻 |
|---|---|---|
| `dims` | `entities.js` | 그 fact 의 dimension 전체. **`daily_` 가 언제나 이것을 가짐** |
| `serving_dims` | `entities.js` | 그 entity 지표들의 `period_` dimension. 기본값 |
| `serving_dims` | `metrics.js` | 이 지표만의 `period_` dimension. 생략하면 entity 것 |

- **지표는 `dims` 를 선언할 수 없음.** `daily_` 가 fallback 계층이라 거기서 dimension 을 빼면 나중에 그
  축으로 보고 싶어도 복원할 방법이 없음
- 20만 행 · 17 MB 라 넓게 둬도 비용이 없고, 비용이 드는 곳은 `period_` 의 dimension 조합임

```js
// entity 기본값을 쓴다 — 지금 17개 지표 전부 이렇다
net_revenue: { entity: "order_item", expr: "SUM({net_revenue})", ... }

// 이 지표만 period_ 의 dimension 을 좁힌다. daily_ 는 dimension 전체를 그대로 갖는다
buyer_count: { entity: "order_item", serving_dims: ["country", "purchase_type"], ... }
```

- dimension 조합이 커졌을 때 쪼개는 길이기도 함
- 자세한 내용은 [porting.md](porting.md) 4장

---

## 3. `includes/` — 선언 계층

### 3-1. `naming.js` (93줄)

- 이름 규칙을 한 곳에 모음
- 규칙이 흩어지면 `ctx.ref()` 가 끊어짐

| export | 산출 |
|---|---|
| `DATASETS` | `semantic_mart` · `semantic` · `semantic_metadata`. 각 파일은 `schema` 를 명시하고 값만 여기 둠 |
| `TAGS` | `mart` · `semantic` · `monitoring`. `infra/apply.js` 도 이것을 읽어 `workflows.json` 을 검증함 |
| `martName(base)` | `sem_` 접두사. DW 와 이름이 겹치면 `ref()` 가 충돌함 |
| `dailyName` · `periodName` · `metricName` | `daily_<metric>` · `period_<metric>` · `metric_<metric>` |
| `RECORD_DATE` | `record_date`. 세 단계가 같은 날짜 컬럼 이름을 씀 |
| `valueColumn(metric, period)` | `net_revenue` · `net_revenue_wtd` |
| `baseColumn(period, label)` | `wow_base` · `wtd_wow_base` |

- **이 파일은 아무것도 읽지 않음.** 이름 규칙이 다른 선언에 의존하면 순환함

### 3-2. `periods.js` (86줄)

- 기간을 선언함
- 기간은 행이 아니라 컬럼임

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
| `CUMULATIVE` | PTD 기간 이름 목록. 선언 순서를 유지함 |
| `END_FLAGS` | `is_week_end` 등 완결 플래그와 그 `trunc` |
| `SHIFTS` | 간격 → 그 간격으로 가져올 [기간, 라벨]. `PERIODS` 를 뒤집은 것 |

- 주의할 점이 셋 있음

- **PTD 는 좁은 것부터 선언해야 함.** sketch PTD 가 가장 넓은 구간으로 한 번만
  self-join 하고 좁은 기간을 `IF` 로 걸러내기 때문에, 마지막 것이 조인 범위가 됨
- **`wtd` 의 `yoy` 만 364일임.** `1 YEAR` 로 하면 요일이 어긋남
- **`SHIFTS` 가 self-join 수를 정함.** 비교 컬럼 8개가 간격 5개에서 나오므로 조인은 5번임

### 3-3. `entities.js` (167줄)

- 지표를 산출하는 fact 가 entity 가 됨
- entity 가 정해지면 grain 과 쓸 수 있는 dimension 이 따라서 정해짐

| 항목 | 무엇 | 바꾸면 |
|---|---|---|
| `source` | 읽을 `sem_fct_*` | 그 entity 의 모든 지표가 다른 테이블을 읽음 |
| `pk` · `grain` | surrogate key 와 한 행의 뜻 | 문서용. assertion 이 검사함 |
| `date_col` | `record_date` 가 될 컬럼 | 모든 지표의 날짜 축 |
| `joins` | 어느 테이블에 어느 키로 붙는가. **이름을 줌** | 지표 수식이 쓰는 이름 |
| `dims` | 그 조인에서 어느 컬럼을 dimension 으로 쓰는가 | `daily_` 의 컬럼 |
| `serving_dims` | `dims` 중 `period_`·`metric_` 이 가질 것. 지표가 덮어쓸 수 있음 | 서빙 테이블의 컬럼과 행 수 |
| `refresh` | `"incremental"` 또는 `"table"` | `daily_` 의 갱신 방식 |

- **`joins` 와 `dims` 를 나눠 선언함.** 둘을 합치면 조인에 붙일 이름이 없어짐
- 이름이 있어야 지표 수식이 dimension 테이블의 컬럼을 가리킬 수 있음

```js
joins: { product: { to: PRODUCT, key: "product_id" } },
dims:  { category: { via: "product", col: "category" } },
expr:  "SUM(IF({is_revenue_recognized}, {product.unit_cost}, 0))"
```

- `product` 는 여기 적힌 이름이지 builder 가 만든 alias 가 아님
- **선언이 builder 내부에 기대지 않음.** 이 이름이 그대로 SQL alias 가 되므로 예약어면 컴파일 타임에 거부됨

- 현재 4개 entity 가 있음

| entity | source | grain | `dims` | `serving_dims` | `refresh` |
|---|---|---|---|---|---|
| `order_item` | `sem_fct_order_items` | 주문 라인 1건 | 8 | 5 | `table` |
| `order` | `sem_fct_orders` | 주문 1건 | 6 | 5 | `table` |
| `session` | `sem_fct_sessions` | 세션 1건 | 4 | 2 | `table` |
| `user_event` | `sem_fct_user_events` | 이벤트 1건 | 3 | 1 | `incremental` |

- **`order` 에 상품 dimension 이 없는 것은 누락이 아님.** 한 주문이 여러 상품을 포함하므로 주문 grain 에서
  category 가 정의되지 않음

### 3-4. `metrics.js` (189줄)

| export | 내용 |
|---|---|
| `METRICS` | 지표 17개. `entity` · `expr` · `filter` · `serving_dims` · `rollups` · `additive` · `description` |
| `RATIOS` | 비율 지표 7개. 테이블을 만들지 않고 registry 행으로만 존재함 |
| `EXCLUDED` | 만들지 않기로 한 5개와 그 사유 |
| `HLL_PRECISION` | 15 고정 |

- 선언에 쓸 수 있는 키는 위 일곱 개뿐임
- **모르는 키는 컴파일이 거부함** — `serving_dims`·`rollups` 는 없어도 도는 선택 키라
  오타를 내면 아무 일도 일어나지 않고 기본 조합만 만들어짐 (P18)

- `additive` 는 플래그가 아니라 **축별 객체**임

```
true      그 축으로 합산 가능        SUM
"sketch"  병합 가능한 중간 상태      HLL_COUNT.MERGE_PARTIAL
"last"    스냅샷                    마지막 값
false     복원 불가                 생성 거부
```

- dimension 축에 `false` 가 나오면 기록할 사실이 아니라 **고칠 신호**임 — entity 가 틀렸음
- 현재 17개 지표에 `false` 는 하나도 없음

- **지표 수식의 컬럼은 중괄호로 표시함.** 중괄호 밖은 builder 가 건드리지 않으므로 어떤 SQL 이든 그대로 쓸 수 있음

```
{sale_price}          →  base.sale_price        fact 컬럼
{product.unit_cost}   →  product.unit_cost      조인해서 오는 컬럼
```

- 접두사가 없으면 조인한 dimension 테이블과 이름이 겹치는 순간 모호해짐

- `unit_cost` — fact 와 `sem_dim_products` 양쪽에 있음
- `user_id` — fact 와 `sem_dim_users` 양쪽에 있음
- `dataform compile` 은 문자열이라 통과시키고 BigQuery 실행 단계에서야 에러가 남

### 3-5. `build.js` (582줄)

- 선언의 규칙을 실제로 검사하는 곳
- 초기에 한 번 쓰고 거의 건드리지 않음

| 함수 | 역할 |
|---|---|
| `resolveDims(name, m)` | entity 의 dimension 전체 + 선언 검증. `additive` 키 누락, dimension 축 `false`, 지표가 `dims` 를 선언하면 예외 |
| `renderExpr(name, m, sql, where)` | `{col}` → `base.col`, `{join.col}` → `join.col` |
| `exprJoins(name, m, sql, where)` | 수식이 참조한 조인 이름. 선언 안 된 이름이면 예외 |
| `resolveJoins(name, m, dims)` | 실제로 쓰이는 조인만 선언 순서로. 예약어·`base` 이름이면 예외 |
| `rollupAxes(name, m, rollup)` | 그 조합의 축 ∩ entity 의 `dims`. `dims` 에 없는 값이면 예외 |
| `rollupNames(m)` | 이 지표가 만드는 조합. 첫 항목이 `null`(기본 조합, 접미어 없음) |
| `dailySQL(ctx, name, m)` | 조인 + `record_date × dims GROUP BY` |
| `foldExpr(col, additive)` | `additive` → 합치는 함수. `null` 이면 생성 거부 |
| `dimFold(name, m, dims)` | dimension 축을 합칠 함수. 축마다 가산성이 다르면 예외 |
| `periodSQL(ctx, name, m)` | `base` → `grid` → `cum` → rollup |
| `comparePlan(m)` | 비교 컬럼 8개와 각각의 기간·간격 |
| `metricSQL(ctx, name, m)` | 간격별 self-join 5번 + 비교 기준값 |

#### 3-5-1. `periodSQL` 이 만드는 네 단계

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
cum AS (   -- PTD. 가산은 window function, sketch 는 구간 self-join
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

#### 3-5-2. 읽는 순서

| 순서 | 대상 | 무엇을 보나 |
|---|---|---|
| 1 | `resolveDims` · `renderExpr` | 선언 검증. 어떤 잘못을 어떻게 잡는지 |
| 2 | `resolveJoins` · `joinClause` | 선언된 조인 중 실제로 쓰이는 것만 |
| 3 | `dailySQL` | 1·2를 써서 SQL 문자열 하나를 만듦 |
| 4 | `foldExpr` · `dimFold` | `additive` → 함수 선택 |
| 5 | `baseCTE` · `gridCTE` | dimension 좁히기와 빈 날 채우기 |
| 6 | `cumWindowed` · `cumSketch` · `rollupSelect` | PTD 두 갈래와 `'(all)'` 행 |
| 7 | `comparePlan` · `metricSQL` | 비교 컬럼 판정과 간격별 조인 |

- JS 문법이 낯설면 [js-patterns.md](js-patterns.md) 를 먼저 봄

---

## 4. `definitions/` — Dataform action

- builder 가 SQL 문자열을 만들고, generator 가 그것을 Dataform action 으로 만듦

| | 파일 | 하는 일 |
|---|---|---|
| **builder** | `includes/build.js` | 선언을 읽어 SQL 문자열을 만듦 |
| **generator** | `definitions/**/gen_*.js` | builder 를 불러 테이블을 만듦 |

### 4-1. `sources/declarations.js` (28줄)

- DW 테이블을 읽기 전용으로 선언함
- **여기 없는 DW 테이블은 참조할 수 없음.** `dbt_dev_marts_core` 8개와 `snapshots` 1개를 선언함

### 4-2. `mart/*.sqlx` (7개)

- DW 를 `semantic_mart` 로 정규화함
- **사람이 SQL 을 쓰는 유일한 곳**임

| 파일 | 하는 일 |
|---|---|
| `sem_dim_users` · `sem_dim_products` | 이름 정규화, 파생 dimension(`age_group` 등), `'(unknown)'` 채우기 |
| `sem_dim_date` | 2018~2031 날짜. `grid` 의 날짜 원천 |
| `sem_fct_*` (4개) | surrogate key 부여, 자연키 제거, grain 보증 |

- 각 파일에 gate assertion 이 붙음
- 깨지면 파이프라인이 멈춤

### 4-3. `assertions/partition_contract.js`

- 마트의 파티션 컬럼이 `entities.js` 의 `date_col` 과 같은지 봄
- **gate 임** — 우리가 만든 테이블이고 우리가 고칠 수 있으므로 깨지면 멈춤

- 두 선언은 서로를 읽지 않음

```
entities.js   date_col: "ordered_date"      build.js 가 daily_ 의 날짜 축과
                                            증분 WHERE·경계에 쓴다
*.sqlx        partitionBy: "ordered_date"   물리 저장 설정
```

- 어긋나면 증분이 파티션을 걸러내지 못해 매번 전체를 읽음
- **결과는 맞고 비용만 늚** ([findings.md](findings.md) 10)

- 구조로 묶지 않고 감시하는 이유는 방향 때문임
- 마트가 `entities.js` 를 참조하게 만들면 **상류가 하류를 읽게 되고**, 마트를 다른 팀이 소유하면 결합이 조직 경계를 넘음

- `sem_dim_*` 3개는 entity 가 아니라 검사 대상이 아님

### 4-4. `assertions/upstream_contract.js` (86줄)

- DW 가 계약을 어겼는지 감시함
- **gate 가 아니라 감시임** — 깨져도 파이프라인은 돎
- 원인이 dbt-airflow 쪽에 있어 우리가 고칠 수 없기 때문임
- 태그가 `monitoring` 이라 별도 워크플로로 돎

- 현재 3건이 상시 실패 상태이고, 그것이 정상임
- 내용은 [operations.md](operations.md) 에 있음

### 4-5. `semantic/gen_daily.js` · `gen_period.js` · `gen_metric.js`

- 각각 17개 테이블을 만듦
- 셋 다 모양이 같음

```js
Object.entries(METRICS).forEach(([name, m]) => {
  publish(dailyName(name), { type, schema, columns, assertions, bigquery })
    .preOps((ctx) => ctx.when(ctx.incremental(), incrementalPreOps(ctx, e)))
    .query((ctx) => dailySQL(ctx, name, m, { incremental: ctx.incremental() }));
});
```

- **선언 하나가 테이블 하나가 됨.** 지표를 추가하면 `forEach` 가 한 바퀴 더 돎

- `gen_daily.js` 만 `preOps` 가 있음
- 증분 구간을 지우고 다시 넣기 위해서임

#### 4-5-1. 셋은 독립이고 테이블은 사슬임

- 두 가지를 구분해야 함

| | 독립인가 |
|---|---|
| 생성기 파일 | **독립.** 서로를 `require` 하지 않고 `includes/` 만 읽음 |
| 선언 입력 | **공유.** 셋 다 `metrics.js` · `entities.js` 를 읽음 |
| 만들어지는 테이블 | **사슬.** `daily_` → `period_` → `metric_` |

- `period_` 는 원본 fact 를 다시 읽지 않고 `daily_` 를 읽고, `metric_` 은 `period_` 만 읽음
- 조인을 `daily_` 에서 한 번만 실행하기 위해서임 (P5·P11)
- 의존 그래프 전체는 아래 [테이블 간](#6-2-테이블-간) 에 있음

#### 4-5-2. dimension 을 정하는 함수가 갈라져 있음

```
gen_daily.js    resolveDims(name, m)          →  allDims(m.entity)       entity 전체
gen_period.js   rollupAxes(name, m, rollup)   →  조합의 축              period_ dimension
gen_metric.js   rollupAxes(name, m, rollup)   →  같음
```

- **`gen_daily.js` 는 `rollupAxes` 를 `require` 하지 않음.** 그래서 지표에 `serving_dims`
  를 선언해도 `daily_` 로 새지 않음

```js
buyer_count: { serving_dims: ["country", "purchase_type"] }

// 컴파일 결과
daily_buyer_count     dimension 8개   그대로
period_buyer_count    dimension 2개
metric_buyer_count    dimension 2개
```

- 반대 방향도 막혀 있음
- `rollupAxes` 가 `resolveDims` 의 결과와 교집합을 취하므로 **어떤 조합이든 언제나 `daily_` dimension 의 부분집합**임
- `dims` 에 없는 것을 `serving_dims` 에 적으면 컴파일이 거부함

### 4-6. `metadata/gen_registry.js` (178줄)

- `metric_registry` 를 만듦
- **`ctx.ref()` 가 없는 유일한 generator** 로, 테이블을 하나도 읽지 않고 선언만 읽어 리터럴로 만듦

- 세 종류가 한 테이블에 들어감

```
METRICS    테이블이 생성된다                       is_generated = true
RATIOS     테이블을 만들지 않는다                   is_generated = false
EXCLUDED   의도적으로 만들지 않는다. 사유를 남긴다   is_generated = false
```

- "생성되지 않았다" 와 "존재하지 않는다" 는 다름
- 비율 7개와 제외 5개는 registry 가 유일한 거처임

---

- `rollups` 컬럼이 **어떤 조합이 어느 테이블에 있는지의 단일 원천**임
- 쿼리를 보고 테이블을 골라주는 계층이 없으므로 소비자가 여기서 찾음
- 필드 이름은 `rollup` 이 아니라 `rollup_name` 임 — `ROLLUP` 이 GoogleSQL 예약어라
  STRUCT 필드 이름으로도 못 씀 ([findings.md](findings.md) 19)

## 5. `infra/` — 실행 계획

- Dataform 의 release configuration 과 workflow configuration 은 GCP resource 라 git 에 남지
  않음
- 레포만 보고는 무엇이 언제 도는지 알 수 없음

| 파일 | 하는 일 |
|---|---|
| `workflows.json` | 그 설정의 원천. 태그 · 스케줄 · 실행 계정 |
| `apply.js` | 선언과 실제 상태를 비교해 맞춤. `node infra/apply.js --dry-run` 으로 차이를 봄 |

#### 5-0-1. 태그 오타가 조용히 지나가지 못하게 함

- `workflows.json` 은 JSON 이라 `naming.js` 의 `TAGS` 를 못 읽음
- 문자열을 손으로 다시 치므로 오타가 남
- **오타의 결과가 나쁨.**

```
$ dataform run --tags semantik
Compiled successfully.
No actions to run.
```

- 매칭되는 액션이 없으면 아무것도 안 만들고 `SUCCEEDED` 로 끝남
- 스케줄이 매일 돌면서 0개를 실행하고 알림도 없음 — 데이터가 며칠 멈춘 뒤에야 알게 됨

- 그래서 `apply.js` 가 적용 전에 둘을 봄

| 검사 | 잡는 것 |
|---|---|
| `naming.js` 의 `TAGS` 에 있는 이름인가 | 오타 |
| 컴파일 그래프에 그 태그를 가진 액션이 있는가 | 상수엔 있는데 아무도 안 붙인 태그 |

```
실패: workflowConfig/semantic-daily: 'semantik' 는 naming.js 의 TAGS 에 없다
실패: workflowConfig/upstream-monitoring: 'cohort' 를 가진 액션이 하나도 없다.
      이대로 적용하면 매일 0개를 실행하고 성공으로 끝난다
```

- `naming.js` 가 아무것도 `require` 하지 않아서 Dataform 밖의 평범한 node 스크립트에서도 읽힘
- `dataformCoreVersion` 도 `workflow_settings.yaml` 에서 읽음

---

## 6. 무엇이 무엇을 참조하는가

### 6-1. 파일 간

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

- `naming.js` 는 아무것도 읽지 않음
- `build.js` 가 나머지를 모두 읽고, 선언 파일끼리는 `naming → entities → metrics` 한 줄임

### 6-2. 테이블 간

- `dataform compile` 이 `ctx.ref()` 호출로 만드는 그래프임

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

- **마트 테이블끼리는 서로 참조하지 않음.** 전부 DW declaration 만 읽음 — fact 간 조인이 금지되어 있기 때문임

- `order_item` 의 `purchase_type` 은 예외처럼 보이지만 아님
- `sem_fct_order_items` 가 `sem_fct_orders` 를 읽는 것이 아니라, **`daily_` 를 만들 때 join
  graph 가 조인함.** 조인이 실행되는 자리는 언제나 `daily_` 임 (P5)

- **`daily_` 는 `sem_dim_date` 를 조인하지 않음.** `dims` 전체(최대 8개)로 빈 날을 채우면 지표 하나가
  수백만 행이 됨
- 빈 날을 채우는 곳은 `period_` 의 `grid` 임

---

**다음으로 읽을 것**

| | |
|---|---|
| 왜 이 구조인가 | [architecture.md](architecture.md) |
| 테이블 구조 | [tables.md](tables.md) |
| 판단 기준 P1~P22 | [principles.md](principles.md) |
| 실측과 실패 기록 | [findings.md](findings.md) |
| 지표 추가 절차 | [metrics.md](metrics.md) 7장 |
| JS 문법 | [js-patterns.md](js-patterns.md) |
