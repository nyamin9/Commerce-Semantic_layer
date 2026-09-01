# Commerce-Semantic_layer

BigQuery + Dataform 위에 커머스 semantic layer를 구축하는 프로젝트.

변환(transformation)은 **dbt-airflow**가 담당하고, 이 레포는 **semantic layer만** 담당한다.
DW 테이블은 만들지 않고 `declaration`으로 읽기만 한다.

- 판단 기준은 [docs/principles.md](docs/principles.md) — P1~P21
- 지표 정의는 [docs/metrics.md](docs/metrics.md) — 기본 14 · 비율 7 · 제외 5
- 코드 읽는 법은 [docs/js-patterns.md](docs/js-patterns.md) — JS 패턴 18가지 · `build.js` 읽는 순서

---

## 이 레이어가 만드는 것

1. **지표 정의가 단일 원천이 된다.** `net_revenue`가 무엇인지가 `includes/metrics.js` 한 곳에만 있다
2. **사람이 손으로 만들던 집계 테이블이 선언에서 생성된다.** 지표 추가 비용이 선언 한 항목으로 고정된다
3. **GROUP BY를 조절해 원하는 집계를 뽑되, 틀린 집계는 막힌다** — `additive`, join graph, assertion이 막는 것은 전부 *에러가 나지 않고 숫자만 틀리는* 사고다

---

## 정석과 무엇이 같고 무엇이 다른가

Looker · Cube · dbt MetricFlow 같은 기성 semantic layer와 비교하면 **다른 지점은 하나뿐이다.**

### 같은 것

| | |
|---|---|
| 선언한 차원만 쓸 수 있다 | 정석도 동일. view · cube · semantic model에 없으면 못 쓴다 |
| 표준화된 지표를 서빙한다 | semantic layer의 정의 그 자체 |
| 사전 집계를 만든다 | Cube `pre-aggregations` · Looker aggregate awareness · AtScale 전부 한다 |
| 롤업 vs 직접 `GROUP BY` | 가산 지표면 **결과가 동일하다.** 덧셈의 결합법칙 |
| entity · dimension · metric 분리 선언 | 전부 동일 |
| grain 선언 · 가산성 분류 · conformed dimension | Kimball, 1996 |

### 다른 것 — 폴백 경로가 없다

```
정석     선언 → 런타임이 판단 → 사전 집계로 답할 수 있으면 거기서
                             → 없으면 원자 fact 로 폴백
이 레포   선언 → 컴파일 타임에 테이블 생성 → 그 테이블이 답할 수 있는 것만
```

**폴백이 넓히는 것은 "무엇을 물어볼 수 있나"가 아니라 "어느 테이블이 답하나"다.**

```
선언된 차원    category · brand · country · retail_price
사전 집계      date × category × country 로만

"brand 별 매출"          → 사전 집계에 brand 없음 → 원자 fact 로 폴백 → 답함
"retail_price > 100"     → retail_price 는 선언됨  → 원자 fact 로 폴백 → 답함
"product_name 에 blue"   → 선언 안 됨              → 정석도 거부
```

핵심은 **선언된 차원을 조건으로 쓸 수 있느냐**다. 정석은 차원을 필터에만 쓸 수 있지만,
사전 집계는 `GROUP BY`에 넣은 차원으로만 거를 수 있다. 그래서 고유값이 많은 컬럼
(`retail_price` 4,212 · `product_name` 27,309)은 이 구조에서 차원이 될 수 없고,
`price_tier` 같은 **버킷으로 승격**해야 한다 (P4).

Dataform이 컴파일 타임 도구라 런타임 조립이 구조적으로 불가능하기 때문이다.
기능 부족이 아니라 도구의 층위이고, dbt Core도 같은 이유로 못 한다.

### 서빙 레이어가 생기면

`semantic_mart`와 선언은 그대로 두고 그 위에 Cube를 올리는 것이 정석 경로다.
`entities.js`와 `metrics.js`가 Cube의 `cubes`·`dimensions`·`measures`와 거의 1:1로 대응한다.

그때 `daily_*` · `metric_*`은 **없어지는 것이 아니라 캐시로 강등된다.** 코드는 고치지 않는다.

---

## 이 구조가 버는 것

효율은 **쿼리 속도가 아니라 변경 비용**에서 온다.

| | 값 |
|---|---|
| `daily_` 행 수 / 원자 fact 행 수 | **99.9%** |
| 원자 fact 전 기간 + dim 조인 + 임의 필터 | **8.5 MB** |

이 규모에서 사전 집계는 성능을 거의 벌어주지 않는다. 버는 것은 이쪽이다.

```
지표 14 × 기간 4 × 비교 4 = 224가지 산출물

손으로 만들면    지표당 모델 5개 × 14 = 70개 SQL 파일 + 비교 로직 반복
선언으로 만들면  metrics.js 14항목 + 고정 파일 5개
```

- 기간 하나 추가 → `periods.js` 한 줄 → **14개 지표에 전부 적용**
- 지표 하나 추가 → `metrics.js` 한 항목 → **기간 4종 · 비교 4종 자동**

`weekly`의 YoY를 364일로 고친 것이 실제 사례다. 한 줄로 14개 지표의 주간 비교가
전부 맞아졌다. 손으로 만들었다면 14곳을 고쳐야 했고 하나는 빠뜨렸을 것이다.

### 커스텀 요청은 어디까지 답하는가

어떤 구조로도 임의 요청을 전부 처리할 수는 없다. 서빙 레이어가 있어도 마찬가지다.
질문은 **어디까지 책임지고 어디부터 놓아주나**가 된다.

| 층 | 답할 수 있는 것 | 지표 정의 보장 |
|---|---|---|
| `metric_` 조회 | 선언한 축 조합 | ✅ |
| 서빙 레이어 *(없음)* | 선언한 차원의 임의 조합 · 필터 | ✅ |
| **`semantic_mart` 직접 SQL** | **임의 필터 · 조인 · 표현식** | ❌ |
| 원자 소스 직접 | 무엇이든 | ❌ |

세 번째 줄이 현실의 탈출구이고, 마트를 만들어 둔 값이 여기서 다시 나온다.
자유롭게 SQL을 써도 자연키가 없어 잘못된 조인이 불가능하고, 차원 PK 유일성이
assertion으로 보장되어 fan trap이 생기지 않는다. **거버넌스는 없지만 바닥이 올라가 있다.**

| 상황 | 처리 |
|---|---|
| 한 번뿐인 질문 | 마트에 직접 SQL. **지표로 만들지 않는다** |
| 같은 필터가 반복 | 차원으로 승격 (P4) |
| 같은 지표가 반복 | `metrics.js`에 선언 추가 |
| 선언으로 표현 불가 | 별도 모델 + registry에 `custom` 등록 (P17) |

첫 줄이 핵심이다. **같은 것을 세 번 물어보면 그때 지표이거나 차원이다.**

---

## 전체 흐름

```
dbt_dev_marts_core           DW. 소유하지 않음. dbt-airflow가 만든다
        │
        │  definitions/sources/declarations.js   ← ref() 로 읽기만
        ▼
semantic_mart                우리 소유. 이름 정규화 · 자연키 제거 · grain 보증
  sem_dim_products / sem_dim_users / sem_dim_date
  sem_fct_order_items / sem_fct_orders / sem_fct_sessions / sem_fct_user_events
        │
        │  includes/build.js  ← entities.js 의 join graph 만큼 LEFT JOIN
        ▼
semantic.daily_<metric>      날짜 × 차원 집계. 재집계 가능한 중간 상태
        │                    ※ 미구현
        │  includes/build.js  ← periods.js 의 기간만큼 롤업 + 비교 기준값
        ▼
semantic.metric_<metric>     기간 4종 + 비교 기준값. 서빙 표면
semantic_metadata.metric_registry   지표 카탈로그   ※ 미구현
```

---

## 진행 상태

| 단계 | 산출물 | 상태 |
|---|---|---|
| 1 | `includes/` 선언 계층 + 조립기 | ✅ |
| 2 | `semantic_mart` 7개 + 감시 assertion | ✅ BigQuery 생성 완료 |
| 3 | `sem_dim_date` | ✅ 2단계에 포함 |
| 4 | `gen_daily.js` · `gen_metric.js` | ⬜ |
| 5 | `gen_registry.js` | ⬜ |
| 6 | `rpt_*` 대조 후 SSOT 전환 | ⬜ |

---

## 파일 구조

```
workflow_settings.yaml              프로젝트 설정 · 데이터셋 vars

includes/                           선언 계층 — 사람이 쓰는 곳
  naming.js                         이름 규칙
  periods.js                        기간 4종 + 비교 간격
  entities.js                       join graph
  metrics.js                        지표 선언
  build.js                          SQL 조립기 (정책 집행부)

definitions/                        Dataform action
  sources/declarations.js           DW 읽기 전용 참조
  mart/*.sqlx                       semantic_mart 7개
  assertions/upstream_contract.js   상류 계약 감시

docs/
  principles.md                     P1~P21 · 확정된 결정 · 알려진 결함
  metrics.md                        지표 정의서 · 집계 경로 · 추가 절차
  js-patterns.md                    코드에 쓰인 JS 패턴 18가지 + build.js 읽는 순서
```

---

## `includes/` — 선언 계층

**지표를 하나 추가할 때 만지는 파일은 `metrics.js` 하나다.** 나머지는 거의 고정이다.

### `naming.js` (16줄)

이름 규칙을 한 곳에 모은다. 규칙이 흩어지면 `ref()`가 끊어진다.

| export | 산출 |
|---|---|
| `martName(base)` | `sem_` 접두사 — DW와 이름이 겹치면 `ref()`가 충돌한다 |
| `dailyName(metric)` | `daily_<metric>` |
| `metricName(metric)` | `metric_<metric>` |
| `baseColumn(label)` | `<label>_base` — 증감률이 아니라 기준 기간의 값 |

### `periods.js` (42줄)

```js
PERIODS = {
  daily:   { type: "passthrough", trunc: null,           compare: { dod, wow, yoy } },
  weekly:  { type: "rollup",      trunc: "WEEK(MONDAY)", compare: { wow, yoy: "364 DAY" } },
  monthly: { type: "rollup",      trunc: "MONTH",        compare: { mom, yoy } },
  yearly:  { type: "rollup",      trunc: "YEAR",         compare: { yoy } },
}
```

- **`weekly`의 YoY만 364일**이다. `1 YEAR`로 하면 주 시작일에 떨어지지 않아 매칭이 전부 실패한다
- `COMPARE_LABELS`는 위 선언을 뒤집어 `라벨 → { period_type: 간격 }`을 만든다. 라벨마다 컬럼이 하나 생긴다
- **WTD·MTD·YTD는 없다.** 저장하지 않고 소비 시점에 파생한다 (P15)

### `entities.js` (79줄)

지표를 산출하는 fact 테이블이 entity가 된다. `dims`가 **join graph**이고, 여기 없는 차원은 쓸 수 없다.

| entity | source | pk | date_col | 차원 |
|---|---|---|---|---|
| `order_item` | `sem_fct_order_items` | `order_item_key` | `ordered_date` | 8 |
| `order` | `sem_fct_orders` | `order_key` | `ordered_date` | 5 |
| `session` | `sem_fct_sessions` | `session_id` | `session_date` | 4 |
| `user_event` | `sem_fct_user_events` | `event_key` | `event_date` | 3 |

각 차원은 `{ from, key, col }` — 어느 dim에 어느 키로 붙어 어느 컬럼을 얻는지.
`from: null`이면 fact 자체 컬럼이라 조인이 없다.

**`order`에 상품 차원이 없는 것은 누락이 아니다.** 한 주문이 여러 상품을 포함하므로
주문 grain에서 카테고리가 정의되지 않는다. `order_count`가 여기 있는 근거다.

### `metrics.js` (133줄)

| export | 내용 |
|---|---|
| `METRICS` | 기본 지표 14개. `entity` · `expr` · `filter` · `dims` · `additive` · `description` |
| `RATIOS` | 비율 지표 7개. `numerator` · `denominator`. **테이블을 만들지 않는다** |
| `EXCLUDED` | 의도적으로 제외한 5개와 그 이유. registry에는 남는다 |
| `HLL_PRECISION` | 15 고정. 바꾸면 과거 스케치와 병합할 수 없다 |

`additive`는 플래그가 아니라 **축별 객체**다.

```
true      그 축으로 가산            → SUM
"sketch"  병합 가능한 중간 상태      → HLL_COUNT.MERGE_PARTIAL
"last"    스냅샷                    → 마지막 값
false     복원 불가                 → 생성 거부
```

차원 축에 `false`가 나오면 기록할 사실이 아니라 **고칠 신호**다 — entity가 틀렸다.
현재 14개 지표에 `false`는 하나도 없다.

### `build.js` (178줄)

정책이 실제로 집행되는 곳. 초기에 한 번 쓰고 거의 건드리지 않는다.

| 함수 | 역할 |
|---|---|
| `resolveDims(name, m)` | **선언 검증.** 미선언 차원, `additive` 키 누락, 차원 축 `false`면 예외 |
| `resolveJoins(dims)` | 같은 `(테이블, 키)`면 조인 한 번. 역할 차원은 별도 슬롯 |
| `dailySQL(ctx, name, m)` | 조인 + `날짜 × 차원 GROUP BY`. **조인이 실행되는 유일한 곳** |
| `rollupExpr(col, additive)` | `additive` → 롤업 함수. `null`이면 생성 거부 |
| `canRollup(m, pName)` | 그 기간을 만들 수 있는가 |
| `metricSQL(ctx, name, m)` | 기간별 `UNION ALL` + 비교 기준값 self-join |
| `eqNullSafe(l, r)` | 차원 NULL 비교. BigQuery에 `IS NOT DISTINCT FROM`이 없다 |

---

## `definitions/` — Dataform action

### `sources/declarations.js` (28줄)

`dbt_dev_marts_core` 8개 + `snapshots` 1개를 `declare()`로 등록한다.
Dataform이 만들지 않고 `ref()`로 읽기만 하는 대상이다.

### `mart/*.sqlx` (7개)

DW와 구조가 같더라도 **반드시 물리 테이블로 만든다.** 이유는 넷이다.

1. **차원 로직의 자리** — 파생 차원을 집계 SQL의 `CASE WHEN`으로 만들면 정의가 지표 수만큼 복제된다
2. **assertion의 자리** — declaration에는 `config{}`가 없어 `uniqueKey`를 걸 수 없다
3. **키 정규화** — 자연키를 제거해 잘못된 조인을 구조적으로 불가능하게 만든다
4. **상류 변경 흡수** — DW 컬럼명이 바뀌어도 충격이 여기서 멈춘다

| 파일 | 소스 | grain | 한 일 |
|---|---|---|---|
| `sem_dim_products.sqlx` | `dim_products` | 상품 1건 | `category_name` → `category` 등 이름 정규화 |
| `sem_dim_users.sqlx` | `dim_users` | 고객 1건 | conformed 축(`country` · `acquisition_channel`) |
| `sem_dim_date.sqlx` | **없음** | 날짜 1건 | 우리가 소유. 2018~2031 날짜 스파인 |
| `sem_fct_order_items.sqlx` | `fct_order_items` | 주문 라인 1건 | 자연키 · 행 단위 비율 제거 |
| `sem_fct_orders.sqlx` | `fct_orders` | 주문 1건 | 자연키 · `user_gender_at_order` 제거 |
| `sem_fct_sessions.sqlx` | `fct_sessions` | 세션 1건 | 퍼널 플래그 제거 (상류 결함 7) |
| `sem_fct_user_events.sqlx` | `fct_user_events` | 이벤트 1건 | 자연키 제거 |

**허용** — 이름 변경 · 컬럼 제거 · 차원 속성 파생 · grain 선언 · surrogate key 승격
**금지** — measure 의미 변경 · fact 간 조인 · 집계 · 비즈니스 사유의 행 필터

> 계산을 시작하면 dbt를 다시 만드는 것이다. 이 레이어는 **번역기**지 변환기가 아니다.

각 파일의 `config.assertions`가 `uniqueKey`와 `nonNull`을 건다. 깨지면 파이프라인이 멈춘다.

### `assertions/upstream_contract.js` (86줄)

상류 계약 **감시**. 게이트가 아니다 — 여기서 깨지는 것은 우리가 고칠 수 없다.

```
tags: ["mart"]        마트가 보장하는 것.  깨지면 파이프라인을 멈춘다
tags: ["monitoring"]  상류가 어긴 것.      별도 워크플로로 돌려 보고만 한다
```

| assertion | 감시 대상 |
|---|---|
| `upstream_natural_key_reuse` | 결함 1. `order_id` · `order_item_id` 중복 |
| `upstream_order_key_null` | 결함 2. `order_key` NULL |
| `upstream_orders_without_items` | 결함 3. line item 없는 주문 |
| `upstream_orders_load_lag` | 결함 4. `fct_orders` 적재 지연 2일 초과 |
| `upstream_session_funnel_flags` | 결함 7. 퍼널 플래그 모순 |

---

## 무엇이 무엇을 참조하는가

### 파일 간

```
entities.js ──┬──→ metrics.js   allDims() 로 축별 가산성을 펼친다
              │
              └──┐
periods.js ──────┼──→ build.js   ENTITIES · PERIODS · naming 을 모두 읽는다
naming.js  ──────┘

build.js ────────→ (미구현) gen_daily.js · gen_metric.js
```

`build.js`만 다른 셋을 모두 읽는다. 선언 파일끼리는 `entities → metrics` 하나뿐이다.

### 테이블 간 (`dataform compile`이 만드는 그래프)

```
dim_products     → sem_dim_products
dim_users        → sem_dim_users
fct_order_items  → sem_fct_order_items
fct_orders       → sem_fct_orders
fct_sessions     → sem_fct_sessions
fct_user_events  → sem_fct_user_events
(없음)           → sem_dim_date

sem_* ──→ daily_<metric> ──→ metric_<metric>        ※ 미구현
```

마트 테이블끼리는 서로 참조하지 않는다. 전부 DW declaration만 읽는다 —
**fact 간 조인이 금지**되어 있기 때문이다.

---

## 개발

```bash
# 컴파일 검증 (로컬. BigQuery 접근 불필요)
npx @dataform/cli@3.0.65 compile

# 의존 그래프 확인
npx @dataform/cli@3.0.65 compile --json > graph.json
```

`dataform run`은 `.df-credentials.json` 또는 ADC가 필요하다.
실제 운영은 Dataform 콘솔의 서비스 계정으로 돌아가므로 로컬 실행은 편의 목적이다.

`main`이 Dataform이 추적하는 브랜치다. 콘솔 workspace는 자동 동기화되지 않으므로
푸시 후 `Pull from default branch`를 눌러야 반영된다.

### 현재 BigQuery 상태

| 데이터셋 | 내용 |
|---|---|
| `semantic_mart` | 7개 테이블 생성됨. 게이트 assertion 14개 통과 |
| `semantic` | 비어 있음 — 4단계에서 `daily_*` 14 + `metric_*` 14 |
| `semantic_metadata` | 비어 있음 — 5단계에서 `metric_registry` |
| `semantic_assertions` | assertion 결과 |
