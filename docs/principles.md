# Semantic Layer 원칙

이 문서는 이 레포에서 semantic layer 를 만들 때의 판단 기준이다.
구현 방법이 아니라 **논쟁이 생겼을 때 되돌아올 근거**를 적는다.

용어는 [glossary.md](glossary.md) 를 따른다.

## 이 layer가 만드는 것

**하나 — 지표 정의가 단일 원천이 된다.**
`net_revenue`가 무엇인지가 `includes/metrics.js` 한 곳에만 있다.
정의를 바꾸면 그것을 쓰는 모든 산출물이 함께 바뀐다. 찾아다닐 곳이 없다.

**둘 — 사람이 손으로 만들던 집계 테이블이 선언에서 생성된다.**
지표 하나를 추가하는 비용이 선언 한 항목으로 고정된다.
기간 컬럼 4개와 비교 컬럼 8개, 각 축의 `'(all)'` rollup이 따라온다.
SQL 파일은 늘지 않는다.

| | 이전 | 이후 |
|---|---|---|
| 사람이 쓰는 집계 SQL | 지표 수 × 기간 수 | **0** |
| 새 지표 비용 | 모델 작성 + 하위 단계 복제 | 선언 1항목 |
| 새 기간 비용 | 지표 수만큼 작성 | 선언 1줄 |
| 지표 정의 조회 | 불가능 | `metric_registry` |

**셋 — 결과 테이블에서 GROUP BY만 조절해 원하는 집계를 뽑되, 틀린 집계는 막힌다.**

이것이 이 구조의 값이다. 편의만 목적이면 집계 캐시로 충분하다.
아래 장치들이 막는 것은 전부 **에러가 나지 않고 숫자만 틀리는** 종류의 사고다.

| 장치 | 막는 것 |
|---|---|
| `additive` 축별 선언 | 비가산 축을 `SUM` 으로 합산하는 것 (활성 사용자 5일 누적에서 17.4% 부풀었다) |
| join graph (`dims`) | 선언되지 않은 dimension 조합 — chasm trap |
| surrogate key 강제 | 자연키 조인의 조용한 fan-out |
| `uniqueKey` assertion | dimension PK가 깨져 합계가 부푸는 것 |
| 비율 컬럼 미저장 | dimension 을 rollup 한 뒤 비율을 다시 더하거나 평균 내는 것 |
| 컴파일 타임 검증 | 선언 누락이 런타임 오답으로 나타나는 것 |

### 하지 못하는 것

**런타임에 요청을 받아 SQL을 조립하지 않는다.** 선언한 지표 × 선언한 dimension ×
기간 컬럼 4개 안에서만 움직인다. 그 밖의 임의 조합은 서빙 계층의 몫이며,
서빙 계층은 여기서 만든 선언을 입력으로 받으므로 순서를 건너뛸 수 없다.

선언하지 않은 dimension 은 나중에 rollup 할 수 없다. `daily_`가 이미 집계된 결과라
없는 dimension은 복원되지 않는다. dimension은 넉넉히 선언한다.

**`serving_dims` 밖의 축은 누계로 못 본다.** `period_`·`metric_` 이 dimension 4개만 갖기 때문에, `category` 별 MTD 는 `daily_` 에서 구간을 잘라 합해야 한다 (P4·P15).

---

## 1. 소유 경계

| 레이어 | 소유 | 이 레포의 권한 |
|---|---|---|
| `raw_thelook` | dbt-airflow | 없음 |
| `dbt_dev_staging` (view) | dbt-airflow | 없음 |
| `dbt_dev_marts_core` | dbt-airflow | **읽기만.** declaration |
| `semantic_mart` | **이 레포** | 소유 |
| `semantic` | **이 레포** | 소유 |
| `semantic_metadata` | **이 레포** | 소유 |
| `dbt_dev_marts_reporting` | dbt-airflow | `rpt_daily_revenue` 폐기 가능. 나머지 2개는 존치 |

```
dbt_dev_marts_core          DW. 소유하지 않음
    │
    │  ◄── 계약 경계. 여기부터 이 레포의 책임
    ▼
semantic_mart               grain 선언 + dimension 정의 + 키 정규화
    │                       sem_dim_products / sem_dim_users / sem_dim_date
    │                       sem_fct_order_items / sem_fct_orders
    │                       sem_fct_sessions / sem_fct_user_events
    ▼
semantic.daily_<metric>     record_date × dimension 전체. sketch 는 sketch 로 보관
    │
    ▼
semantic.period_<metric>    record_date × serving_dims. rollup 행 + PTD 컬럼
    │
    ▼
semantic.metric_<metric>    서빙 표면. + 비교 기준값
semantic_metadata.metric_registry
```

---

## 2. 중간 마트 (`semantic_mart`)

DW와 구조가 동일하더라도 **반드시 정의하고 물리 테이블로 만든다.**

### 왜 두는가

1. **dimension 로직의 자리** — 파생 dimension을 집계 SQL의 `CASE WHEN`으로 만들면
   그 정의가 지표 수만큼 복제된다. semantic layer가 없애려던 문제를 그대로 재현한다.
2. **assertion의 자리** — declaration에는 `config{}`가 없어 `uniqueKey`를 걸 수 없다.
   물리 테이블이어야 fan trap 방어 장치가 제자리에 온다.
3. **키 정규화** — 자연키를 아예 제거해서 잘못된 조인을 구조적으로 불가능하게 만든다.
4. **상류 변경 흡수** — DW 컬럼명이 바뀌어도 충격을 한 곳에서 받는다.

### 허용

- 컬럼 이름 변경 (`category_name` → `category`)
- 컬럼 제거 (자연키, 미사용 컬럼)
- **dimension 속성 파생** (bucket, 등급, 플래그)
- grain 선언과 assertion
- surrogate key를 정식 PK로 승격

### 금지

- **measure 의미 변경.** `net_revenue`는 DW가 `is_revenue_recognized`로
  이미 정의했다. 다시 정의하면 정의가 두 군데로 갈라진다
- **fact 간 조인**
- **집계.** 이 레이어의 grain은 상류 grain과 같다
- **비즈니스 사유의 행 필터**

> 계산을 시작하면 dbt를 다시 만드는 것이다. 이 레이어는 **번역기**지 변환기가 아니다.

### 이름

DW와 **다른 이름**을 쓴다. Dataform `ref()`가 이름으로 해석하므로
`dim_products`가 양쪽에 있으면 충돌한다. `sem_` 접두사로 구분한다.

```
dbt_dev_marts_core.dim_products     →   semantic_mart.sem_dim_products
dbt_dev_marts_core.fct_order_items  →   semantic_mart.sem_fct_order_items
```

접두사는 데이터셋이 아니라 **테이블 이름**에 붙인다. `ref("sem_fct_order_items")`처럼
이름만으로 어느 레이어인지 드러나야 lineage를 읽을 때 헷갈리지 않는다.

---

## 3. 원칙

### 키와 grain

**P1. grain은 선언한다. 가정하지 않는다.**
모든 fact/dim에 `uniqueKey` assertion을 건다. 깨지면 파이프라인이 멈춘다.

**P2. 조인은 surrogate key로만 한다.**
이 DW의 자연키는 유일하지 않다 — `order_id` 4,038행, `order_item_id` 5,161행 중복.
소스가 ID를 재사용한다. 자연키로 조인하면 **에러 없이 조용히 fan-out** 된다.
`semantic_mart`에서 자연키를 제거해 실수를 구조적으로 막는다.

**P3. dimension의 PK 유일성은 장식이 아니라 fan trap 방어 장치다.**
dimension이 1쪽이 아니게 되는 순간 fact 행이 복제되고 합계가 조용히 부푼다.

### dimension

**P4. dimension 로직은 dimension 안에 산다. 고유값이 많은 컬럼은 dimension이 될 수 없다.**
집계 SQL 안에서 bucket을 만들지 않는다. 파생 dimension은 `semantic_mart`의 `sem_dim_*`에서 만든다.

고유값이 많으면 grid가 그만큼 부풀고, **그러면 기간 rollup이 작동하지 않는다.**
`brand`(2,753개)를 dimension 으로 뒀을 때 2,754일치를 연 단위로 집계해도 행이 5%밖에 줄지 않았다.

| | `brand` 포함 | `brand` 제외 |
|---|---|---|
| `daily` 행 | 187,477 | 184,598 |
| 월 단위로 집계했을 때 | 186,292 | 150,837 |
| 연 단위로 집계했을 때 | **178,916** | **83,320** |

게다가 그 크기로 비교 self-join 4개를 돌리면 BigQuery on-demand 의 CPU 한도에
걸려 `metric_` 6개가 생성 자체를 못 했다 (2026-09-13). `brand` 를 빼서 해결했다.
브랜드별 집계가 필요하면 `semantic_mart` 에 직접 SQL 을 쓴다.

**P5. dimension은 fact에 붙이지 않는다. 조인은 `daily_` 생성 시 딱 한 번 실행한다.**

`semantic_mart`는 star schema를 유지한다 — dim과 fact를 분리한다.
조인 관계는 `entities.js`의 `joins`에, 그 조인에서 뽑아 쓸 컬럼은 `dims`에
선언하고, generator가 그 선언을 읽어 `daily_<metric>`을 만들 때 조인을 실행한다.

```
sem_fct_order_items  ─┐
sem_dim_products     ─┼─→  daily_<metric>  ─→  metric_<metric>
sem_dim_users        ─┘    (dimension 이 컬럼으로     (조인 없음)
                            들어가 있다)
```

**`daily_`는 이미 비정규화된 결과물이다.** dimension이 평범한 컬럼으로 들어가 있어서
그 위의 모든 집계는 조인이 필요 없다. 조인 비용은 지표당 하루 한 번이지
조회할 때마다가 아니다.

fact에 dimension을 미리 붙이지 않는 이유는 셋이다.

1. **dimension 추가가 fact 재생성을 부른다.** 선언 한 줄이어야 할 일이 대형 테이블 재빌드가 된다
2. **역할 dimension을 표현할 수 없다.** 같은 dim을 두 키로 참조하는 경우(주문일/배송일) 평탄화가 깨진다
3. **dimension 변경 시점이 fact에 고정된다.** point-in-time을 나중에 도입할 여지가 사라진다

**P5-1. 조인에는 이름을 준다. 그 이름이 곧 SQL alias 다.**

```js
joins: { product: { to: PRODUCT, key: "product_id" } },
dims:  { category: { via: "product", col: "category" } },
```

이름이 있어야 지표 수식이 dim 컬럼을 가리킬 수 있다.

```js
expr: "SUM(IF({is_revenue_recognized}, {product.unit_cost}, 0))"
```

`product`는 여기 적힌 이름이지 builder가 만든 alias 가 아니다.
**선언은 builder 내부를 모른다** — alias 규칙을 바꿔도 `metrics.js`는 그대로다.

세 가지를 컴파일 타임에 검사한다.

| 검사 | 이유 |
|---|---|
| GoogleSQL 예약어 금지 | 이름이 그대로 alias 가 된다. `order`가 예약어다 |
| `base` 금지 | fact 의 alias 와 겹친다 |
| `via`가 `joins`에 있을 것 | 오타가 런타임 오답이 되지 않게 |

역할 dimension(같은 dim을 두 키로 참조)은 이름만 다르게 주면 된다.

```js
joins: {
  ordered_date: { to: DATE, key: "ordered_date", ref_key: "date_day" },
  shipped_date: { to: DATE, key: "shipped_at",   ref_key: "date_day" },
}
```

**P5-2. 지표 수식의 컬럼은 중괄호로 표시한다.**

```
{sale_price}          →  base.sale_price       fact 컬럼
{product.unit_cost}   →  product.unit_cost     조인해서 오는 컬럼
```

테이블 접두사가 없으면 조인한 dim과 이름이 겹치는 순간 모호해진다 — `unit_cost`는 fact와
`sem_dim_products` 양쪽에, `user_id`는 fact와 `sem_dim_users` 양쪽에 있다.
`dataform compile`은 문자열이라 통과시키고 **BigQuery 실행 단계에서야 터진다.**

어느 토큰이 컬럼인지 정규식으로 추측하지 않는 이유는 조용히 틀리기 때문이다.
`COUNTIF(status = "returned")`에서 `"returned"`를 컬럼으로 보면 `"base.returned"`가
되는데, **그것도 유효한 문자열이라 에러 없이 결과만 0이 된다**(P18).

중괄호를 깜빡하면 접두사가 붙지 않은 채 남아 ambiguous 에러가 난다. 값이 틀리는 대신 바로 멈춘다.

> dim 컬럼을 measure로 쓰면 **과거 숫자가 나중에 바뀐다.** `sem_dim_*`는 현재 상태만
> 담고 SCD 이력 커버리지가 4.46%다. 기능은 열되 기본은 fact다.

**P6. join graph에 선언하지 않은 dimension은 쓸 수 없다.**
가능한 조합을 이어주는 것보다 **불가능한 조합을 막는 쪽**이 중요하다. chasm trap 예방.

**P6-1. dimension의 `NULL`은 값이 빠진 것이 아니라 하나의 bucket이다.**

`daily_`는 `LEFT JOIN`이므로 fact 키가 dim에 없어도(orphan) 행이 남고 dimension만
`NULL`이 된다. `GROUP BY`가 `NULL`을 한 그룹으로 묶으므로 **measure는 정상적으로
집계되고 총합도 맞는다.** 숫자가 틀리는 문제가 아니다.

| 조회 | 결과 |
|---|---|
| 총합 · 국가별 전부 나열 · `WHERE country = 'China'` | 정확 |
| `WHERE country IS NOT NULL` · 대시보드가 `NULL` 행을 숨김 | 그만큼 빠진다 |

서빙 테이블에서는 이 `NULL` 이 `'(unknown)'` bucket이 된다 (P6-3). 비교 기준값도 그 값으로 맞물리므로 비지 않는다 (P14).

다만 `NULL`의 출처가 둘인데 구별되지 않는다 — **키가 dim에 없는 것**과
**dim에 있는데 값이 `NULL`인 것**이다. 구별이 필요해지면 Kimball의 unknown member
(dim에 `'Unknown'` 행을 두어 항상 조인되게 하는 것)를 쓴다.

**규모를 먼저 잰다.** `daily_`가 생기면 `NULL` bucket이 그대로 보인다.
0이면 아무것도 하지 않고, 있으면 그때 5장에 등재한다.
재보지 않고 assertion을 걸면 항상 실패 상태로 남아 아무도 보지 않게 된다.

**P6-2. dimension은 그 entity의 grain 에서 나온 것이어야 한다.**

`order_item` 은 라인 grain 이므로 라인 상태(`order_item_status`)를 쓴다.
헤더 상태(`order_status`)를 쓰면 한 주문에 배송분과 반품분이 섞일 때 갈라진다.
DW 의 `is_revenue_recognized` 도 라인 상태에서 나온다.

같은 이유로 지표 수식이 보는 컬럼과 dimension이 같은 grain 이어야 한다 —
`units_returned` 가 `{order_item_status}` 를 세는데 dimension은 헤더 상태였던 것이
그 불일치였다.

**필터로 박을 것인가 dimension으로 둘 것인가**도 여기서 갈린다. dimension으로 두면 소비
시점에 거를 수 있어 **양쪽을 다 볼 수 있다.** `buyer_count` 에서 매출 인식 필터를
뺀 것이 그 예다 — 필터를 박으면 전체 구매자를 낼 방법이 없어진다 (P4).

**P6-3. 서빙 테이블의 dimension에는 `NULL` 을 두지 않는다. `'(unknown)'` bucket이 된다.**

뜻은 P6-1 그대로다. 바뀌는 것은 조인이다.

`NULL` 을 남기면 조인을 `IS NOT DISTINCT FROM` 으로 써야 하는데, **BigQuery 가 그것을
해시 조인 키로 쓰지 못한다.** 등가 조인이면 양쪽을 해시로 나눠 붙이는데 일반 술어라
중첩 루프가 된다. 평범한 조인에서는 티가 안 나다가 구간 자기조인에서 터진다.

```
period_buyer_count 의 누계 단계 — grid 2,023,920 행 × 1년 구간
IS NOT DISTINCT FROM   CPU 88,022초   한도 5,100 초과로 실패
=                      통과
```

조인마다 `COALESCE` 를 붙이는 대신 **값에서 `NULL` 을 없앤다.** 한 단계에서 바꾸면
이후 조인이 전부 `=` 다. `sem_dim_products` 가 `brand_name` 에 쓰는 방식과 같다.

`'(all)'` 과는 겹치지 않는다.

| | |
|---|---|
| `'(unknown)'` | 그 축의 값이 없는 bucket (P6-1) |
| `'(all)'` | 그 dimension 을 rollup 한 행 (P4) |

`daily_` 에는 `NULL` 이 그대로 남는다. 원자 집계라 상류가 준 모양을 바꾸지 않는다.

**P7. conformed dimension은 이름과 의미가 같아야 한다.**
`country`는 어느 fact에서 오든 같은 뜻이어야 한다. 그래야 fact를 나란히 놓을 수 있다.

### 지표

**P8. 지표는 한 번만 선언한다.**
출력 테이블마다 집계 SQL을 손으로 쓰지 않는다.

**P9. 가산성은 (measure × 축)의 속성이다.**
플래그 하나가 아니라 축별로 선언한다.
`COUNT(DISTINCT order_key)`는 날짜축 가산이지만 카테고리축 비가산이다.

**P10. 비가산 축이 나오면 지표를 잘못된 entity에 선언한 것이다.**
순서대로 시도한다.

| | 방법 | 예 |
|---|---|---|
| **P10-1** | entity를 옮긴다 | `order_count`를 `sem_fct_orders`(주문 1건 = 1행)로 옮기면 `COUNT(*)`가 되고 카테고리축 자체가 사라진다 |
| **P10-2** | 못 옮기면 sketch로 | `buyer_count` by category |
| **P10-3** | sketch도 안 되면 | 중앙값·분위수는 daily만 만들고 rollup을 거부한다 |

**P11. `daily_`와 `metric_`은 둘 다 재집계 가능한 형태로 저장한다.**

확정(sketch → 정수, 분자 ÷ 분모)은 저장 시점이 아니라 **소비 시점**에 한다.
확정된 값은 더 이상 rollup할 수 없으므로, 물리 테이블에 확정값을 넣으면
dimension 을 rollup 하는 순간 쓸 수 없게 된다.

| measure 유형 | 두 테이블 모두 저장하는 것 | 소비 시점 |
|---|---|---|
| 합계·건수 | 값 | 그대로 |
| distinct 수 | **HLL sketch(BYTES)** | `HLL_COUNT.EXTRACT` |
| 평균·비율 | **저장하지 않는다** | 분자 ÷ 분모 (P12) |

두 테이블을 나누는 이유는 확정 시점이 아니라 역할이다.

| | 역할 |
|---|---|
| `daily_<metric>` | **조인이 실행되는 유일한 곳.** 날짜 × dimension 집계 |
| `period_<metric>` | 기간 4종으로 확장 |
| `metric_<metric>` | `period_`를 시프트해 자기 자신과 조인. 비교 기준값 |

**셋으로 나눈 이유는 비용이다.** 기간 확장을 CTE 로 두면 `metric_` 이 다섯 번
참조해(본 쿼리 1 + 비교 조인 4) 같은 집계가 다섯 번 돈다. CTE 는 결과를 저장하지
않기 때문이다. dimension 7개 지표에서 CPU 3,600초를 써 BigQuery on-demand 의
CPU/바이트 비율 제한에 걸렸다 — 스캔은 14 MB 라 **비용이 아니라 낭비가 문제였다.**

조인 술어를 바꿔도 변하지 않았고(`=` · `COALESCE` · `IS NOT DISTINCT FROM` 전부
3,600대), 중간 단계를 테이블로 저장하니 통과했다 (2026-09-13).

분리해 두면 `metric_`을 다시 만들 때 atomic fact와 dimension을 다시 읽지 않는다.

**P12. 비율은 어느 테이블에도 저장하지 않는다. 증감률도 비율이다.**
일별 비율의 평균은 기간 비율이 아니다. 분자와 분모를 **각각 독립된 지표로 선언**하고,
비율은 registry에 `type: "ratio"` + 분자·분모 지표명으로만 등록한다. 나눗셈은 소비 시점에 한다.

같은 이유로 `yoy` · `mom` 같은 **증감률 컬럼을 저장하지 않는다.** dimension을 하나라도
rollup 하는 순간 저장된 증감률은 더하지도 평균 내지도 못한다.

```
category 를 rollup 하고 country 별로만 볼 때 (2026-01 · China)
  저장된 yoy 를 AVG   0.9969   ✕
  저장된 yoy 를 SUM  24.9235   ✕
  yoy_base 로 재계산   0.9140   ✓
```

> **비율은 분자·분모의 dimension 교집합에서만 유효하다.**
> `aov = net_revenue / order_count`인데 `net_revenue`는 `order_item` entity라 `category`가 있고
> `order_count`는 `order` entity라 없다. 따라서 **카테고리별 AOV는 정의가 성립하지 않는다.**
> 카테고리별 주문 수가 비가산이기 때문이며(P9), 이것은 도구의 한계가 아니라 사실이다.

### 시간

**P13. 기간은 행이 아니라 컬럼이다. 날짜 컬럼은 `record_date` 하나다.**

서빙 테이블(`period_`·`metric_`)의 한 행은 **그 날짜의 모든 것**이다.
`daily`·`wtd`·`mtd`·`ytd` 가 나란히 컬럼으로 놓인다.

```
record_date  country  is_week_end is_month_end is_year_end
2026-08-31   China    FALSE       TRUE         FALSE

  net_revenue        그날 하루
  net_revenue_wtd    주 시작 ~ record_date
  net_revenue_mtd
  net_revenue_ytd
```

`period_start` 는 두지 않는다. `record_date` 에서 결정되기 때문이다 —
`wtd` 의 시작은 `DATE_TRUNC(record_date, WEEK(MONDAY))` 다.

**`weekly`·`monthly`·`yearly` 는 만들지 않는다.** 완결 기간의 rollup은 같은 축에서
누계와 값이 같다. 실측으로 완결 주 10,080 조합 전부 일치했다 (2026-09-16).

```
monthly  =  mtd  where is_month_end
```

행으로 두면 값은 중복되면서 **미완결 기간이 미래 날짜를 단다.** 직전 구조에서
데이터가 9/17까지인데 진행 중인 주의 `weekly` 행이 아직 오지 않은 9/20을 달고
있었고, 그 행의 `wow_base` 가 4일치를 지난주 7일 전체와 맞댔다. 누계에는 그 문제가
없다 — `record_date` 는 항상 실제로 지난 날이다.

**P13-1. 기간 접두어가 없으면 `daily` 다.**

```
net_revenue                        daily 값
net_revenue_wtd                    누계 값
dod_base · wow_base · yoy_base     daily 기준 비교
wtd_wow_base · mtd_mom_base · ...  누계 기준 비교
```

가로 구조에서 `wow_base` 하나로는 `daily` 의 WoW 인지 `wtd` 의 WoW 인지 구분이
안 된다. 둘 다 존재하고 값이 다르다. 누계 쪽에만 접두어를 붙이면 기존 `daily`
소비자의 쿼리가 그대로 동작한다.

**P14. 비교는 기준값(`_base`)만 저장한다. 날짜 조인으로 만들고 `LAG`를 쓰지 않는다.**

`_base`는 집계가 아니라 조회다 — 같은 테이블에서 시프트한 행의 값을 복사한다.
원래 값이 가산이면 `_base`도 가산이다 — **단 모든 행에 채워져 있을 때만** (P14-1).

```sql
LEFT JOIN period_x AS b
  ON  b.record_date = DATE_SUB(c.record_date, INTERVAL 1 YEAR)
  AND <모든 dimension NULL-safe 비교>
→ b.net_revenue     AS yoy_base        -- daily 기준
  b.net_revenue_mtd AS mtd_yoy_base    -- 같은 조인에서 누계 기준까지
```

**조인은 간격 단위로 묶는다.** 비교 컬럼 8개가 서로 다른 시프트 5개
(`1 DAY`·`1 WEEK`·`1 MONTH`·`1 YEAR`·`364 DAY`)에서 나오므로 자기조인도 5번이다.

- **시프트 간격은 기간마다 다를 수 있다.** `wtd`의 YoY를 `1 YEAR`로 하면
  요일이 어긋난다 — 2026-03-02(월)의 1년 전은 일요일이다. 주간 비교는
  **52주(364일)** 시프트여야 같은 요일에 떨어진다
- **`DATE_SUB` 이 월말을 보정한다.** `2026-03-31 - 1 MONTH = 2026-02-28` 이라 월말
  `mtd` 끼리 맞물린다. 대신 3/30 과 3/31 이 둘 다 2/28 로 간다
- `LEFT JOIN`이어야 한다. `INNER`면 기준 기간이 없을 때 현재 행까지 사라진다
- `LAG`는 거래 없는 기간의 행이 비어 있으면 다른 시점을 가리킨다

**P14-1. `_base` 는 선언된 dimension 그대로 조회할 때만 유효하다. rollup 하면 과소 집계된다.**

P14 는 "원래 값이 가산이면 `_base` 도 가산이므로 dimension 을 rollup 해도 남는다" 고 했다.
**모든 행에 `_base` 가 채워져 있을 때만 참이다.**

시프트한 기간에 **같은 dimension 조합이 없으면** `_base` 는 `NULL` 이고, `SUM` 은 `NULL` 을
빼고 더한다. dimension이 잘게 쪼개져 있을수록 매칭이 드물어 누락이 커진다.

> 2026-09-13 실측. `metric_net_revenue` 의 daily 행 194,406개 중 전년 동일 조합이
> 있는 행은 **1,754개(0.9%)** 다. `yoy_base` 를 부서별로 합산하면 85,912 인데
> 부서 grain 에서 직접 계산한 전년 매출은 4,845,125 다 — **56배 차이**다.

`NULL` 은 0 이 아니라 **"그 기간에 같은 조합이 없었다"** 는 뜻이다.

| 조회 | `_base` |
|---|---|
| 그 행의 dimension 그대로 | 유효 |
| dimension 을 rollup 하며 `SUM` | **쓰지 말 것** |

rollup 해야 한다면 **`'(all)'` 행을 읽는다** (P4). 그 dimension 을 rollup 한 행이 이미 테이블로 저장돼
있고, 그 행의 `_base` 는 같은 grain 에서 시프트 조인한 값이라 맞는다. 이것이
`'(all)'` 을 미리 만들어 두는 이유 중 하나다.

**P15. 기간 누계(WTD·MTD·YTD)는 채운 grid 위에 저장한다. 희소하게 만들면 무너진다.**

누계는 소비 시점 파생으로도 낼 수 있지만, 모든 소비자가 기간 경계와 sketch 병합
규칙을 각자 알아야 한다. 그것이 semantic layer 가 없앨 지식이다 (P1).

대신 **grid를 채우는 것이 조건**이다. 활동한 날에만 PTD 행을 만들면 dimension 을 rollup 하는
순간 대부분이 사라진다.

> 실측. 희소하게 만든 `mtd` 로 "2026-08-14 기준 국가별 MTD" 를 내면 전사 합계가
> 25,618 인데 실제는 192,871 이다 — **13%만 나온다.** 8/14에 안 팔린 조합의
> 8/1~8/13 매출이 통째로 빠지기 때문이다.

```
1) 날짜 × dimension조합 을 전부 만든다     sem_dim_date CROSS JOIN 조합
2) daily_ 를 LEFT JOIN 해 값을 붙인다   없으면 0 (가산) · NULL (sketch)
3) 그 위에 누적한다
```

2번의 `0` 이 핵심이다. 그날 활동이 없어도 행이 생기고, 누적값이 앞 구간을 그대로
들고 가므로 rollup 해도 빠지지 않는다.

**grid 크기는 (조합 수 × 날짜)로만 정해진다.** 원본 행 수와 무관하다. 그래서
서빙 테이블의 dimension을 `serving_dims` 4축으로 좁힌다 (P4) — `category`(26) 하나만
넣어도 26배가 된다.

| | 조합 | 날짜 | 행 |
|---|---|---|---|
| 전체 dimension 7개 | 27,749 | 2,811 | 7,800만 |
| **conformed 4축 + rollup** | **1,708** | 2,811 | **480만** |

**P15-1. `sem_dim_date`는 grid의 기준 날짜 목록다. `daily_` 의 날짜를 쓰지 않는다.**

`daily_` 의 날짜를 쓰면 전사적으로 거래가 0인 날이 통째로 빠져 누계의 연속성이
끊긴다 — 실측으로 2,811일 중 **44일**이 그랬다. 빈 날짜를 행으로 만드는 것이 이
dimension 테이블의 존재 이유다.

범위는 `daily_` 가 가진 구간으로 자른다. 그러지 않으면 2018~2031 날짜 전체가
조합 수만큼 곱해지고, **데이터가 없는 미래 날짜에 행이 생긴다** (P13).

`daily_` 자체는 `sem_dim_date` 를 조인하지 않는다. 거래가 있었던 날만 들어가면
된다. 그 밖의 시계열 구멍은 조회 시점에 `sem_dim_date` 를 왼쪽에 놓고 메운다.

**P16. 나눗셈은 전부 `SAFE_DIVIDE`.**

### 생성

**P17. 기계적인 것은 생성한다.**
사람이 쓰는 SQL은 generator가 표현할 수 없는 것에 한한다.
그런 지표도 registry에는 등록한다 — "생성되지 않았다"와 "존재하지 않는다"는 다르다.

**P18. builder는 틀린 결과를 내느니 거부한다.**
`additive: false` 조합은 빈 테이블을 만들지 않고 건너뛴다.
빈 테이블이 남으면 소비자가 "값이 0"으로 오해한다.

**P19. 이름 규칙은 한 파일에만 둔다.**
어긋나면 `dataform compile`이 실패해야 한다. 런타임이 아니라 컴파일 타임에 잡는다.

### 상류 계약

**P20. DW 소스에 건 assertion은 게이트가 아니라 감시다.**
깨져도 우리가 고칠 수 없다. dbt에 보고하고, 여기서 덮지 않는다.

**P21. 알려진 상류 결함은 우회하지 말고 기록한다.**
조용한 우회는 문제를 숨긴다. 5장에 적고 assertion으로 감시한다.

**P22. 갱신 방식은 상류를 따른다. 상류보다 촘촘하게 잡지 않는다.**

`daily_`의 증분 구간은 **상류 raw 의 불변 경계**에서 나온다.
`orders` · `order_items` · `events` 가 매 런마다 `[ds-3, ds]` 4일치를 덮어쓰므로,
그보다 오래된 raw 는 바뀌지 않는다. 같은 값을 쓴다 (`build.js`의 `LOOKBACK_DAYS`).

| | |
|---|---|
| 좁게 잡으면 | 늦게 도착한 행을 **영원히** 놓친다. 5장의 결함 2·3·4가 전부 그 구간이다 |
| 넓게 잡으면 | 이득 없이 다시 읽기만 한다 |

기준일은 `CURRENT_DATE`가 아니라 **이미 적재된 `MAX(record_date)`** 다.
파이프라인이 며칠 멈췄다 재개해도 그 사이가 비지 않는다.

**상류가 전체 재생성하는 fact 위에는 증분을 올리지 않는다.**
`fct_sessions`가 그렇다 — 과거 구간의 값이 바뀔 수 있다는 뜻이므로 `session` entity는
`refresh: "table"`이다. 판단 근거는 `entities.js`의 선언에 적는다.

상류 **모델 로직**이 바뀌어 과거 값이 달라지는 것은 구간으로 못 잡는다.
그때는 `--full-refresh`다.

**증분 구간을 서브쿼리로 잡으면 파티션 프루닝이 걸리지 않는다.**
`(SELECT MAX(record_date) FROM self)` 는 실행 시점에야 값이 정해져서 BigQuery 가 파티션을
미리 걸러내지 못한다. 실측으로 리터럴 날짜 15,896 B 대 서브쿼리 3,000,288 B 였다.

`CURRENT_DATE` 기준으로 바꾸면 프루닝은 되지만 **fact 날짜가 오늘보다 뒤처져 있어
증분이 0행을 처리한다** (2026-09-13 기준 소스 최대일이 2026-09-04).
정적 하한을 덧붙이면 프루닝이 살아나지만, 그 기간보다 오래 멈추면 `daily_` 에
에러 없이 구멍이 생긴다 — 그쪽이 더 나쁘다 (P18).

현재 비용은 40 MiB 대 30 MiB 다. **정확성을 택하고 한계를 기록한다.**
테이블이 커져 실제로 아프면 그때 정적 하한과 신선도 assertion 을 같이 넣는다.

**증분은 MERGE 가 아니라 구간을 지우고 다시 넣는다 (insert_overwrite).**

`MERGE` 는 지우지 않는다. dim 속성이 바뀌면 `(record_date, dimension)` 키가 달라져 옛 행이
매칭되지 않고 그대로 남는다 — **유령 행**이 되어 합계가 부푼다.
`uniqueKey` assertion 도 못 잡는다. 키는 여전히 유일하기 때문이다.

> 2026-09-13 실측. 마트를 12일치 최신화하고 증분을 돌렸더니 유령 행 3,933개가
> 남아 `net_revenue` 가 188,992.92 부풀었다.

구간 경계는 `preOps` 의 `DECLARE` 로 **한 번만 계산해 고정한다.** `DELETE` 가
`MAX(record_date)` 를 바꾸므로 `DELETE` 와 본 쿼리가 각자 계산하면 서로 다른 구간을 보고
그 사이가 중복되거나 빈다.

경계는 `LEAST(우리 max, 소스 max) - 3` 이다. 소스 기준만 쓰면 우리가 며칠 쉬는
동안 들어온 날짜가 빈 채로 남는다.

---

## 4. 확정된 결정

| 항목 | 결정 |
|---|---|
| SSOT | semantic layer. `rpt_daily_revenue` 는 대조 완료 — 폐기 가능 |
| `rpt_daily_funnel` · `rpt_user_cohort_retention` | **존치.** 우리가 의도적으로 만들지 않은 영역이다 (P17).<br>퍼널은 상류 결함 7, 코호트는 사용자 생애주기 — 후속 페이즈 |
| `dim_date` | semantic layer가 소유. 변환이 아니라 축이다.<br>**`period_` grid의 기준 날짜 목록**다. `daily_` 는 조인하지 않는다 (P15-1) |
| 파생 dimension | `semantic_mart`의 `dim_*`에서 생성 |
| 비율 지표 | registry에 선언만. 테이블 생성 안 함 |
| HLL precision | **15 고정.** 나중에 바꾸면 과거 sketch와 병합 불가 |
| 지표당 테이블 | **3개** — `daily_` + `period_` + `metric_`. 전부 물리 테이블 |
| 날짜 컬럼 | `record_date` 하나. 세 단계가 같은 이름을 쓴다 (P13) |
| 기간 | **컬럼**이다 (P13). `<m>` `<m>_wtd` `<m>_mtd` `<m>_ytd`.<br>`weekly`·`monthly`·`yearly` 는 만들지 않고 `is_*_end` 로 고른다 |
| 서빙 dimension | `serving_dims` 4축 + 각 축의 `'(all)'` rollup 행. `daily_` 는 전체 dimension (P4) |
| 비교 | 8컬럼. `dod_base` `wow_base` `yoy_base` + `wtd_`·`mtd_`·`ytd_` 접두어.<br>증감률은 저장하지 않음. 주간 YoY는 364일 시프트 |
| SCD | 당분간 현재 상태만 사용. 이력 커버리지 4.46% |
| `daily_` 갱신 | entity별. 상류를 따른다 (P22). 증분 구간 `[ds-3, ds]` |
| `period_`·`metric_` 갱신 | 전부 `table`. 하루가 늘면 grid가 하루 늘고 364일·1년 뒤 비교 기준값까지 바뀐다 |
| clustering | **걸지 않는다.** BigQuery 권장 기준이 64 MB인데 `daily_*` 15개 실측 최대가 16.72 MB다 |

`period_` 와 `metric_` 은 한 행에 `daily` 와 누계를 함께 담는다. 셋 다 재집계 가능한
형태로 저장하며(P11), 차이는 저장 형식이 아니라 역할이다 — `daily_` 는 전체 dimension의
원자 집계, `period_` 는 `serving_dims` rollup의 기간 확장, `metric_` 은 거기에 비교를 붙인 서빙 표면이다.

---

## 5. 알려진 상류 결함

우회하지 않고 assertion으로 감시한다. 원인은 dbt-airflow 쪽에 있다.

| # | 현상 | 규모 | 영향 |
|---|---|---|---|
| 1 | 자연키 재사용 | `order_id` 4,038행 / `order_item_id` 5,161행 중복 | P2로 대응 |
| 2 | `fct_order_items.order_key` NULL | 1,673행 (2026-08-19~26). **backfill로 해소** | 재발하면 `COUNT(DISTINCT order_key)`가 최근 구간 과소집계 |
| 3 | line item 없는 주문 | 477건 (2026-08-17~24) | 두 fact 정합 불일치 |
| 4 | `fct_orders` 적재 지연 | order_items는 08-26, orders는 08-24까지 | 주문 grain 지표가 최근 이틀 결측 |
| 5 | SCD 이력 부족 | `valid_from` 최솟값 2026-08-15, fact는 2019-01-13부터 | point-in-time 매칭률 4.46% |
| 6 | `dim_date` 부재 | — | semantic layer가 생성 |
| 8 | `dim_products.brand_name` 결측 | 상품 29,120개 중 **24개**. 주문 라인 154행 | 마트에서 `'(unknown)'` 로 라벨 |
| 9 | `rpt_daily_revenue.order_count` 이중 계산 | department 별 합산 **183,826** vs 실제 **138,061** (33% 과다) | `COUNT(DISTINCT order_key)` 를 department 별로 센 것. department 를 rollup 하면 틀린다 (P9).<br>우리는 `order` entity 로 옮겨 department 를 없앴다 (P10-1) |
| 7 | `fct_sessions` 퍼널 플래그 모순 | `purchased`인데 `viewed_product`가 아닌 세션 72,045건. 세션 구매율 77.1% | **퍼널 전환 지표를 이 플래그로 만들 수 없다** |

2~4번은 모두 최근 구간에 몰려 있어 late-arriving 문제로 보인다.

7번은 성격이 다르다. 전자상거래 세션 구매율은 통상 1~3%인데 77.1%가 나온다.
`purchased`가 이름대로 동작하지 않는다는 뜻이므로 **원인이 밝혀지기 전까지
세션 퍼널 지표를 정의하지 않는다.**
