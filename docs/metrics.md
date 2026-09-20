# 지표 정의서

[principles.md](principles.md) 의 P8~P12 를 이 프로젝트의 실제 지표에 적용한 것.
`includes/metrics.js` 는 이 문서의 기계 판독 가능한 형태이고, **이 문서가 정본이다.**

용어는 [glossary.md](glossary.md) 를 따른다.

- **기본 지표 17개** — 직접 집계된다. `daily_` + `period_` + `metric_` 세 테이블을 갖는다
- **비율 지표 7개** — 기본 지표의 나눗셈이다. registry에만 등록하고 테이블을 만들지 않는다 (P12)

---

## 1. entity와 dimension

**지표를 산출하는 fact 테이블이 entity가 된다.** entity가 정해지면 grain과
사용 가능한 dimension이 따라서 정해진다.

| entity | 소스 | grain | 날짜 컬럼 |
|---|---|---|---|
| `order_item` | `sem_fct_order_items` | 주문 라인 1건 | `ordered_date` |
| `order` | `sem_fct_orders` | 주문 1건 | `ordered_date` |
| `session` | `sem_fct_sessions` | 세션 1건 | `session_date` |
| `user_event` | `sem_fct_user_events` | 이벤트 1건 | `event_date` |

### dimension 도달 경로 (join graph)

entity마다 **어떤 키로 어떤 dim에 닿아 어떤 dimension을 얻는지**를 선언한 것이 join graph다.
표에 `●`가 없으면 그 entity에서 그 dimension을 쓸 수 없다 (P6).

| dimension | 조인 이름 | 출처 | 조인 키 | `order_item` | `order` | `session` | `user_event` |
|---|---|---|---|:---:|:---:|:---:|:---:|
| `category` | `product` | `sem_dim_products` | `product_id` | ● | | | |
| `department` | `product` | `sem_dim_products` | `product_id` | ● | | | |
| `country` | `user` | `sem_dim_users` | `user_id` | ● | ● | ● | ● |
| `age_group` | `user` | `sem_dim_users` | `user_id` | ● | ● | | |
| `gender` | `user` | `sem_dim_users` | `user_id` | ● | ● | | |
| `acquisition_channel` | `user` | `sem_dim_users` | `user_id` | ● | ● | ● | |
| `order_item_status` | — | fact 자체 | 조인 없음 | ● | | | |
| `order_status` | — | fact 자체 | 조인 없음 | | ● | | |
| `purchase_type` | `order_header` | `sem_fct_orders` | `order_key` | ● | ●&nbsp;(fact 자체) | | |
| `entry_traffic_source` | — | fact 자체 | 조인 없음 | | | ● | |
| `browser` | — | fact 자체 | 조인 없음 | | | ● | |
| `event_type` | — | fact 자체 | 조인 없음 | | | | ● |
| `traffic_source` | — | fact 자체 | 조인 없음 | | | | ● |

**`country`와 `acquisition_channel`만 네 entity를 가로지른다.** 이 둘이 conformed
dimension이고, 서로 다른 fact의 지표를 나란히 놓을 수 있는 축은 이것뿐이다 (P7).

`purchase_type` 만 fact 를 조인해서 온다. `sem_fct_orders` 에서 한 번 계산하고
`order_item` 은 `order_header` 라는 이름으로 가져온다 — `order` 는 GoogleSQL 예약어라
조인 이름으로 못 쓴다 (P5-1). `order_key` 가 유일해서 fan-out 이 생기지 않는다.

**`serving_dims` 는 이 표에서 뽑아낸 것이다.** `period_`·`metric_` 은 entity 별로
아래 축만 갖고, 각 축의 `'(all)'` rollup 행까지 테이블로 저장한다 (P4·P15).

| entity | `serving_dims` |
|---|---|
| `order_item` · `order` | `country` · `age_group` · `gender` · `acquisition_channel` · `purchase_type` |
| `session` | `country` · `acquisition_channel` |
| `user_event` | `country` |

지표별로 덮어쓸 수도 있다. `metrics.js` 에 `serving_dims` 를 적으면 그 지표의 큐브만
좁아지고 `daily_` 는 넓게 남는다 — dimension 하나가 행 수를 곱하는 곳은 `period_` 이고
`daily_` 는 거의 안 커지기 때문이다.

**`daily_` 쪽은 좁힐 수 없다.** 지표가 `dims` 를 선언하면 컴파일이 거부한다.
`daily_` 가 fallback 계층이라 거기서 빼면 복원할 방법이 없다 (P4-1).

나머지 축(`category`·`department`·`order_item_status`·`browser` 등)은 `daily_` 에만
있다. grid가 조합 수만큼 부풀어서 서빙 테이블에 올릴 수 없다.

**`order`에 상품 dimension이 비어 있는 것은 누락이 아니다.** 한 주문이 여러 상품을
포함하므로 주문 grain에서 카테고리는 정의되지 않는다. 이 공백이 P10의 근거다.

---

## 2. 집계 경로 — 선언에서 결과까지

지표 하나가 선언에서 최종 숫자까지 가는 전 과정. `net_revenue`를 예로 든다.
dimension은 설명을 위해 `category` · `country` 둘만 쓴다.

### 단계 0 — 선언

사람이 쓰는 것은 이 두 조각뿐이다. SQL은 쓰지 않는다.

```js
// includes/entities.js — dimension에 닿는 경로
order_item: {
  source: "sem_fct_order_items", pk: "order_item_key", date_col: "ordered_date",
  joins: {
    product: { to: "sem_dim_products", key: "product_id" },
    user:    { to: "sem_dim_users",    key: "user_id"    },
  },
  dims: {
    category: { via: "product", col: "category" },
    country:  { via: "user",    col: "country"  },
  },
}

// includes/metrics.js — 무엇을 어떻게 집계하는가
net_revenue: {
  entity:   "order_item",
  expr:     "SUM({net_revenue})",
  dims:     ["category", "country"],
  additive: { time: true, category: true, country: true },
}
```

### 단계 1 — `daily_net_revenue`

builder가 `entity.source`를 base로 놓고, `joins`에 선언된 만큼 `LEFT JOIN`을 붙이고,
`date_col` + dimension으로 `GROUP BY` 한다. **조인이 실행되는 곳은 여기 한 번뿐이다** (P5).

```sql
SELECT
  base.ordered_date     AS record_date,
  product.category      AS category,
  user.country          AS country,
  SUM(base.net_revenue) AS net_revenue        -- ← metrics.js 의 expr
FROM semantic_mart.sem_fct_order_items AS base
LEFT JOIN semantic_mart.sem_dim_products AS product ON base.product_id = product.product_id
LEFT JOIN semantic_mart.sem_dim_users    AS user    ON base.user_id    = user.user_id
GROUP BY 1, 2, 3
```

결과 — dimension이 평범한 컬럼으로 테이블로 저장된다. **이 시점부터 조인은 더 필요 없다.**

| record_date | category | country | net_revenue |
|---|---|---|---|
| 2026-03-02 | Jeans | China | 49.00 |
| 2026-03-03 | Jeans | China | 97.99 |
| 2026-03-04 | Jeans | China | 0.00 |

> **테이블은 지표당 하나다. dimension 조합마다 생기지 않는다.**
> 선언한 dimension 전부가 한 테이블의 컬럼으로 들어가고, 행은 `날짜 × 실제로 존재하는 dimension 조합`이다.
> dimension 을 덜 쓰고 싶으면 그 컬럼을 `SUM` 으로 rollup 한다 — **단 가산 축만** 가능하고,
> 그래서 `additive`가 축별로 필요하다 (P9).

### 단계 2 — `period_net_revenue`

`daily_` 를 **`serving_dims` rollup × 기간 컬럼**으로 편다. 한 행이 "그 `record_date` 의 모든 것" 이다 (P13).

세 단계다.

```
base    daily_ 를 serving_dims 로 집계한다.           rollup 행은 아직 없다
grid    sem_dim_date × 조합 을 전부 만들고 값을 붙인다.  없으면 0 / NULL
cum     그 위에 누적한다.                              daily 는 그대로 통과
rollup  각 축의 '(all)' 행을 만든다.                    마스크 CROSS JOIN
```

`base` 는 `category`·`department`·`order_item_status` 를 없앤다. rollup 행은 아직 없다.

```sql
SELECT record_date, country, age_group, gender, acquisition_channel,
       SUM(net_revenue) AS v                  -- sketch면 HLL_COUNT.MERGE_PARTIAL
FROM semantic.daily_net_revenue
GROUP BY 1, 2, 3, 4, 5
```

`rollup` 이 마지막에 `'(all)'` 행을 만든다. 마스크를 `CROSS JOIN` 으로 붙여 입력을
한 번만 읽고 행을 2ⁿ 배로 펼친다. 비트가 0인 축이 `'(all)'` 이 된다.

```sql
SELECT cum.record_date,
       IF((axis_mask >> 0) & 1 = 1, cum.country, '(all)') AS country,
       ...
       SUM(cum.net_revenue_mtd) AS net_revenue_mtd
FROM cum
CROSS JOIN UNNEST(GENERATE_ARRAY(0, 15)) AS axis_mask
GROUP BY 1, 2, 3, 4, 5
```

> **`CUBE` 도 `GROUPING SETS` 도 못 쓴다.** `CUBE` 는 다른 grouping element 와 섞이지
> 않고, `GROUPING SETS` 는 집합마다 입력을 다시 읽어 sketch 지표가 CPU 한도에 걸린다
> ([findings.md](findings.md) 7).

> **rollup 이 PTD 보다 나중인 이유.** 순서를 바꿔도 값은 같지만, 먼저 rollup 하면 `'(all)'`
> 행의 sketch가 조밀해지고 그것을 1년 구간 자기조인에서 하루당 180여 번씩 읽는다.

`grid` 는 `sem_dim_date` 를 기준 날짜 목록로 빈 날짜를 채운다 (P15-1). 활동한 날에만 누계를
만들면 rollup 하는 순간 대부분이 사라진다 ([findings.md](findings.md) 4).

`cum` 은 가산이면 창 함수, sketch면 구간 자기조인이다. **출력 컬럼은 양쪽이 같다.**

```sql
-- 가산
SUM(v) OVER (PARTITION BY <dims>, DATE_TRUNC(record_date, MONTH) ORDER BY record_date) AS net_revenue_mtd

-- sketch. MERGE_PARTIAL 은 analytic function 을 지원하지 않는다
HLL_COUNT.MERGE_PARTIAL(IF(b.record_date >= DATE_TRUNC(g.record_date, MONTH), b.v, NULL)) AS buyer_count_mtd
```

### 단계 3 — `metric_net_revenue`

`period_` 를 시프트해 자기 자신과 조인하고 **기준값만** 붙인다. 증감률은 저장하지
않는다 (P12·P14).

```sql
LEFT JOIN period_net_revenue AS b_1_year
  ON b_1_year.record_date = DATE_SUB(c.record_date, INTERVAL 1 YEAR)
 AND <dimension NULL-safe 비교>
→ b_1_year.net_revenue     AS yoy_base
  b_1_year.net_revenue_mtd AS mtd_yoy_base
  b_1_year.net_revenue_ytd AS ytd_yoy_base
```

비교 컬럼 8개가 서로 다른 시프트 5개에서 나오므로 자기조인도 5번이다.

| 컬럼 | 기준 | 시프트 |
|---|---|---|
| `dod_base` · `wow_base` · `yoy_base` | daily | `-1 DAY` · `-1 WEEK` · `-1 YEAR` |
| `wtd_wow_base` · `wtd_yoy_base` | wtd | `-1 WEEK` · `-364 DAY` |
| `mtd_mom_base` · `mtd_yoy_base` | mtd | `-1 MONTH` · `-1 YEAR` |
| `ytd_yoy_base` | ytd | `-1 YEAR` |

> **`wtd` 의 YoY 만 364일이다.** `1 YEAR` 로 하면 요일이 어긋난다 —
> 2026-03-02(월)의 1년 전은 일요일이다. 52주 시프트가 같은 요일에 떨어진다.
> **`DATE_SUB` 이 월말을 보정한다.** `2026-03-31 - 1 MONTH = 2026-02-28` 이라 월말
> `mtd` 끼리 맞물린다.

> **증감률을 저장하면 안 되는 이유.** dimension 을 rollup 할 때 저장된 비율은 `AVG` 로도
> `SUM` 으로도 틀린 값이 나온다. `SAFE_DIVIDE(SUM(v) - SUM(base), SUM(base))` 가
> 정답이고, 그래서 기준값만 저장한다. rollup 해야 한다면 `'(all)'` 행을 읽는 쪽이
> 더 정확하다 (P14-1).

### 합치는 함수는 `additive` 가 고른다

여러 행을 한 행으로 만드는 집계다. 축이 둘이다.

```
dimension 축   category · department · order_item_status 를 없앤다     ← 마스크 CROSS JOIN
시간 축   daily 여러 날을 기간 누계로 만든다                       ← 창 함수 / 구간 병합
```

어떤 함수를 쓸지는 `additive` 가 정한다. 사람은 고르지 않는다.

| 축 | additive | 패턴 |
|---|---|---|
| dimension | `true` | `SUM` + 마스크 `CROSS JOIN` |
| dimension | `"sketch"` | `HLL_COUNT.MERGE_PARTIAL` + 마스크 `CROSS JOIN` |
| 시간 | `true` | `SUM(v) OVER (PARTITION BY ... ORDER BY record_date)` |
| 시간 | `"sketch"` | 구간 자기조인 + `HLL_COUNT.MERGE_PARTIAL` |
| 시간 | 그 밖 | **누계 컬럼을 만들지 않는다.** `daily` 하나만 남는다 (P10-3) |
| 어느 축이든 | `false` | **생성 거부** (P18) |

sketch 는 합쳐도 sketch 로 남는다. `MERGE` 로 정수를 만들면 더 합칠 수 없다 (P11).

> **`'(all)'` 행도 같은 규칙을 따른다.** sketch 지표의 전사 값은 `SUM` 이 아니라
> `HLL_COUNT.MERGE` 다. 지금 conformed 축은 전부 user 속성이라 사용자를 분할하지만,
> 겹치는 축이 들어오면 `SUM` 은 깨진다.

### `additive`는 어디서 읽히는가

축마다 소비처가 다르다. **시간 축만 builder가 자동으로 쓴다.**

```
선언 (metrics.js)
  additive: { time: true, category: true, country: true }
        │
        ├── time ──────→ 【builder가 읽는다 · 컴파일 타임】
        │                 period.type × additive.time  →  위 표에서 SQL 템플릿 선택
        │                 false면 그 기간 테이블을 아예 만들지 않는다 (P18)
        │
        └── dimension 축 ────→ 【builder는 쓰지 않는다】
                          dimension 축 rollup은 소비 시점에 Dataform 밖에서 일어난다
                          ① metric_registry 컬럼으로 나가 소비 측이 읽는다
                          ② 설계 시점의 신호 — false면 entity가 틀린 것이다 (P10)
```

dimension 축에 `false`를 쓰게 되면 기록하고 넘어갈 사실이 아니라 **고쳐야 할 신호**다.
현재 기본 지표 17개에는 `false`가 하나도 없다. `order_count`를 `order` entity로
옮기면서 마지막 하나가 사라졌다.

`metrics.js`의 `dims`에 있는 dimension이 `additive`에 없으면 `dataform compile`이 실패한다 (P19).

```js
dims:     ["category", "brand", "country"]
additive: { time: true, category: true, country: true }
                                  ↑ brand 누락 → 컴파일 실패
```

이 검증이 없으면 `brand` 축으로 rollup 해도 되는지 아무도 모르는 채로 테이블이 만들어진다.
선언 누락이 조용히 틀린 숫자로 나타나는 것을 막는 마지막 장치다.

### 잘못 선언하면 무슨 일이 생기는가

`additive.time` 을 `true` 로 잘못 선언하면 `SUM` 이 선택되어 distinct count 가 부푼다.
에러는 나지 않고 숫자만 틀린다 ([findings.md](findings.md) 11).

### 요약

```
선언 (JS)              생성 (Dataform)                  결과 (BigQuery)
─────────────────────  ──────────────────────────────  ───────────────────────
entities.js  ─┐
              ├──→  조인 + 날짜×dimension GROUP BY  ──→  daily_<metric>    중간 상태
metrics.js   ─┘                                          │
                                                         ▼
periods.js   ────→  기간 rollup + 비교 기준값 조인  ──→  metric_<metric>  서빙 표면
```

이 구조가 주는 것은 순서대로 이렇다.

1. **정의가 하나다.** `net_revenue`가 무엇인지가 `metrics.js` 한 줄에만 있다.
   이것이 semantic layer의 존재 이유이고 나머지는 부수 효과다
2. **daily 이후 조인이 없다.** 소비 경로가 단순해지고 빨라진다
3. **대가 — 선언한 dimension으로만 자를 수 있다.** 새 dimension은 선언 추가와 재생성이 필요하다

속도만 목적이라면 집계 캐시로 충분하다. 이 구조는 1번을 위한 것이다.

> 예시 쿼리는 `semantic_mart`가 아직 없어 DW 테이블에 직접 실행한 결과다.
> 마트를 만든 뒤에는 컬럼명이 규칙에 맞게 바뀐다 — `category_name` → `category`.

---

## 3. 기본 지표

직접 집계되는 지표. 각각 `daily_` · `period_` · `metric_` 세 테이블을 갖는다.
`daily_` 는 언제나 **그 entity의 dimension 전체**를 갖는다 (1장 표). 지표가 좁힐 수 없다.

가산성 — `●` 가산 / `○` sketch

| 지표 | entity | 집계식 | 필터 | 가산성 |
|---|---|---|---|:---:|
| `gross_revenue` | `order_item` | `SUM({sale_price})` | — | ● |
| `net_revenue` | `order_item` | `SUM({net_revenue})` | — | ● |
| `cogs` | `order_item` | `SUM(IF({is_revenue_recognized}, {unit_cost}, 0))` | — | ● |
| `gross_profit` | `order_item` | `SUM({net_gross_profit})` | — | ● |
| `order_item_count` | `order_item` | `COUNT(*)` | — | ● |
| `units_sold` | `order_item` | `COUNTIF({is_revenue_recognized})` | — | ● |
| `units_returned` | `order_item` | `COUNTIF({order_item_status} = 'returned')` | — | ● |
| `buyer_count` | `order_item` | `HLL_COUNT.INIT({user_id})` | — | ○ |
| `paying_buyer_count` | `order_item` | `HLL_COUNT.INIT({user_id})` | `{is_revenue_recognized}` | ○ |
| `void_buyer_count` | `order_item` | `HLL_COUNT.INIT({user_id})` | `NOT {is_revenue_recognized}` | ○ |
| `order_count` | `order` | `COUNT(*)` | — | ● |
| `returned_order_count` | `order` | `COUNTIF({order_status} = 'returned')` | — | ● |
| `session_count` | `session` | `COUNT(*)` | — | ● |
| `bounce_count` | `session` | `COUNTIF({is_bounce})` | — | ● |
| `visitor_count` | `session` | `HLL_COUNT.INIT({user_id})` | — | ○ |
| `event_count` | `user_event` | `COUNT(*)` | — | ● |
| `active_user` | `user_event` | `HLL_COUNT.INIT({user_id})` | — | ○ |

### DW 정의를 그대로 쓰는 지표

`net_revenue`, `gross_profit`은 DW가 이미 계산해 둔 컬럼을 합산만 한다.
매출 인식 규칙을 semantic layer가 다시 정의하지 않는다 (금지 항목).

> DW 검증 결과 — `gross_profit = sale_price - unit_cost` 불일치 0건,
> `net_revenue`는 인식 시 `sale_price`·미인식 시 0, 불일치 0건.
> `is_revenue_recognized = order_item_status NOT IN ('cancelled', 'returned')`.

### `order_count`가 `order` entity에 있는 이유

이 표에서 **entity 선택이 결과를 바꾸는 유일한 사례**이자 P10의 실제 적용이다.

```
order_item entity에 두면   COUNT(DISTINCT order_key)   카테고리축 비가산
order entity로 옮기면      COUNT(*)                    전 축 가산
```

주문 grain에는 카테고리라는 축이 애초에 존재하지 않으므로 비가산성이 소멸한다.
비가산 축은 잘못된 entity 선언의 증상이다.

대가는 4장에 있다 — 카테고리별 AOV를 낼 수 없게 된다.

### 구매자를 세 지표로 나눈 이유

매출은 `gross_revenue − net_revenue` 로 취소·반품분이 나온다. 라인마다 한 bucket 에만
들어가기 때문이다. **구매자는 그 뺄셈이 안 된다.**

한 사람이 완료 주문과 취소 주문을 둘 다 가질 수 있어서 bucket 이 겹친다. 뺄셈을 하면
양쪽에 다 있는 사람이 통째로 사라진다 ([findings.md](findings.md) 15). 그래서
`buyer_count` · `paying_buyer_count` · `void_buyer_count` 를 따로 만든다.

**세 값을 더해도 전체가 되지 않는다.** HLL 근사 때문이 아니라 distinct count 의
성질이라, 정확히 세도 마찬가지다.

`buyer_count − paying_buyer_count` 만 성립한다. `paying` 이 `buyer` 의 부분집합이라
그 차이가 "매출을 한 번도 내지 못한 고객" 이 된다 (12,752명).

### HLL 지표

`buyer_count` · `visitor_count` · `active_user` 셋은 sketch로 저장한다.
precision은 **15 고정**이며 나중에 바꾸면 과거 sketch와 병합할 수 없다.
기대 오차 약 1.6%이므로 정산·과금 용도로 쓰지 않는다.

---

## 4. 비율 지표 — registry 전용

테이블을 만들지 않는다. 분자와 분모가 각각 기본 지표이고, 나눗셈은 소비 시점에 한다 (P12).

| 지표 | 분자 | 분모 | 유효 dimension |
|---|---|---|---|
| `gross_margin_rate` | `gross_profit` | `net_revenue` | order_item 전 축 |
| `return_rate` | `units_returned` | `units_sold` | order_item 전 축 |
| `bounce_rate` | `bounce_count` | `session_count` | session 전 축 |
| `order_return_rate` | `returned_order_count` | `order_count` | order 전 축 |
| `aov` | `net_revenue` | `order_count` | **교집합만** |
| `units_per_order` | `units_sold` | `order_count` | **교집합만** |
| `revenue_per_buyer` | `net_revenue` | `buyer_count` | 교집합 + 근사 |

### 교집합 규칙

비율은 **분자와 분모가 공유하는 dimension에서만 유효하다.**

```
net_revenue   order_item entity   category  brand  department  country  age_group  gender  channel
order_count   order      entity                                country  age_group  gender  channel
                                  ─────────────────────────    ───────────────────────────────────
                                  aov 정의 불가                 aov 유효
```

**카테고리별 AOV는 정의가 성립하지 않는다.** 도구의 한계가 아니라,
"카테고리별 주문 수"라는 값이 존재하지 않기 때문이다 — 한 주문이 여러 카테고리에
걸치므로 카테고리별로 나눠 세면 합이 전체 주문 수를 넘는다.

이걸 굳이 내고 싶다면 분모를 다시 정의해야 한다.
예를 들어 "해당 카테고리 상품을 포함한 주문 수"는 계산 가능하지만
**`order_count`와 다른 지표**이므로 별도 이름으로 선언해야 한다.

`revenue_per_buyer`는 분모가 HLL 근사라 결과도 근사다. registry에 표시한다.

---

## 5. 정의하지 않는 지표

빠진 것이 아니라 **의도적으로 제외**한 것이다. 이유를 남긴다 (P17 — 등록과 생성은 다르다).

| 지표 | 제외 이유 |
|---|---|
| 세션 퍼널 전환율<br>(view → cart → purchase) | 상류 결함 7. `purchased`인데 `viewed_product`가 아닌 세션 72,045건, 세션 구매율 77.1%. 플래그가 이름대로 동작하지 않는다 |
| 코호트 리텐션 | daily 집계로 복원 불가능. 사용자 단위 식별자가 필요하므로 atomic fact 위의 별도 모델 |
| LTV | 위와 같음. 다일 상태(multi-day state) |
| 재구매율 | 사용자의 전체 이력이 필요 |
| 중앙값·분위수 계열 | sketch로도 병합 불가. daily만 만들고 rollup 거부 대상 (P10-3) |
| 주문 시점 상품 속성 | 상류 결함 5. SCD 이력 커버리지 4.46% |

앞의 넷은 **daily의 상위 집계가 아니라 atomic fact에 대한 다른 질문**이다.
generator 밖에서 별도 모델로 만들되 registry에는 `custom: true`로 등록한다.

---

## 6. 산출물

컬럼과 타입은 [tables.md](tables.md) 에 있다. 여기서는 각 테이블의 역할만 다룬다.

```
semantic_mart      sem_dim_* 3개  +  sem_fct_* 4개                    7
semantic           daily_<metric> 14  +  metric_<metric> 14          28
semantic_metadata  metric_registry                                    1
                                                                  ─────
                                                                     36
```

### `daily_<metric>` — 중간 상태

`sem_fct_*`에 `sem_dim_*`을 조인해 `날짜 × dimension`으로 집계한 결과.
distinct 계열은 HLL sketch(BYTES)로 남는다. 소비용이 아니라 `metric_`의 재료다.

### `period_<metric>` — 기간 확장

`daily_` 를 **`serving_dims` rollup × 기간 컬럼**으로 편 것. 비교는 아직 없다.

dimension 이 `serving_dims` 로 좁혀지므로 `category`·`department`·`order_item_status` 는 여기 없다. 그것이
필요하면 `daily_` 에서 직접 집계한다 (P4). 대신 남은 4개 dimension 의 `'(all)'` rollup 행이 테이블로 저장돼 있다.

`metric_` 이 이 테이블을 다섯 번 자기조인하므로 CTE 가 아니라 테이블이어야 한다.
비교 없이 기간별 집계만 필요한 소비자는 여기서 끝난다.

### `metric_<metric>` — 서빙 표면

`period_` 에 비교 기준값 8컬럼을 붙인 것.

**`daily_`와 같은 저장 원칙을 따른다** (P11) — sketch는 BYTES로 남고 증감률은 저장하지 않는다.
확정은 소비 시점에 한다.

| 컬럼 | 내용 |
|---|---|
| `record_date` | 기준일. `daily` 는 그날, 누계는 기간 시작부터 이 날까지 (P13) |
| `is_week_end` · `is_month_end` · `is_year_end` | 이 날이 그 기간의 마지막 날인가 |
| *(dimension 4축)* | `'(all)'` 은 그 dimension 을 rollup 한 행. `NULL` 은 값이 없는 bucket (P6-1) |
| `<m>` · `<m>_wtd` · `<m>_mtd` · `<m>_ytd` | 가산 지표는 값, distinct 계열은 sketch(BYTES) |
| `*_base` 8개 | 시프트한 시점의 값. 접두어가 없으면 `daily` 기준 (P13-1) |

소비 시점에 하는 일은 둘뿐이다.

```sql
-- 완결 월 + 증감률. monthly 를 따로 만들지 않고 is_month_end 로 고른다
SELECT record_date, country,
       net_revenue_mtd,
       SAFE_DIVIDE(net_revenue_mtd - mtd_yoy_base, mtd_yoy_base) AS yoy
FROM semantic.metric_net_revenue
WHERE is_month_end
  AND age_group = '(all)' AND gender = '(all)' AND acquisition_channel = '(all)'
ORDER BY record_date DESC LIMIT 12

-- sketch 지표는 EXTRACT 를 한 번 더 부른다
SELECT country, HLL_COUNT.EXTRACT(active_user_mtd) AS active_user_mtd
FROM semantic.metric_active_user
WHERE record_date = CURRENT_DATE()
```

**dimension 을 rollup 하며 `SUM` 하지 않는다.** `'(all)'` 행을 읽는다 — 이미 테이블로 저장돼 있고,
sketch 지표는 `SUM` 이 아니라 `HLL_COUNT.MERGE` 여야 하는데 그 지식이 필요 없어진다.
비교 기준값은 rollup 하면 특히 위험하다 (P14-1).

### 기간 누계 — 테이블에 있다

WTD·MTD·YTD 는 `<m>_wtd`·`<m>_mtd`·`<m>_ytd` 컬럼으로 저장돼 있다 (P15).
같은 행에 `daily` 값과 비교 기준값이 함께 있으므로 조회는 `record_date` 하나로 끝난다.

```sql
-- 전사 MTD 와 작년 같은 날까지 MTD
SELECT net_revenue_mtd, mtd_yoy_base
FROM semantic.metric_net_revenue
WHERE record_date = @as_of
  AND country = '(all)' AND age_group = '(all)'
  AND gender = '(all)' AND acquisition_channel = '(all)'
```

`record_date` 파티션 프루닝이 걸려 하루치 파티션만 읽는다.

`daily_` 에서 직접 구간 합을 내는 방법도 여전히 유효하다 — `category` 처럼
서빙 테이블에 없는 축으로 누계를 봐야 할 때가 그렇다.

```sql
SELECT category, SUM(net_revenue) AS mtd
FROM semantic.daily_net_revenue
WHERE record_date BETWEEN DATE_TRUNC(@as_of, MONTH) AND @as_of
GROUP BY category
```

### `metric_registry` — 지표 카탈로그

**`includes/metrics.js`의 선언을 BigQuery 테이블로 테이블로 저장한 것.** 행 하나가 지표 하나다.

선언이 JS 파일에만 있으면 어떤 쿼리로도 읽을 수 없다.
registry가 있으면 "`net_revenue`가 무엇인가"를 SQL로 답할 수 있다.

| 컬럼 | 내용 |
|---|---|
| `metric_name` | 지표 이름 |
| `metric_type` | `base` / `ratio` |
| `description` | 설명문 |
| `entity` · `entity_grain` | 산출 fact와 그 grain |
| `expression` · `filter` | 집계식과 필터 |
| `dimensions` | 사용 dimension 배열 |
| `additive_by_axis` | 축별 가산성 JSON |
| `numerator` · `denominator` | 비율 지표 전용 |
| `is_generated` | 테이블이 생성되었는가 (P17) |

예시 행:

| metric_name | metric_type | entity | expression | additive_by_axis | is_generated |
|---|---|---|---|---|---|
| `net_revenue` | base | order_item | `SUM({net_revenue})` | `{"time":true,...}` | true |
| `active_user` | base | user_event | `HLL_COUNT.INIT({user_id})` | `{"time":"sketch",...}` | true |
| `aov` | ratio | — | — | — | false |
| `cohort_retention` | base | order_item | — | — | false |

**비율 지표 7개는 테이블이 없으므로 registry가 유일한 거처다.**
5장의 제외 지표도 `is_generated: false`로 여기 남는다 — "생성되지 않았다"와
"존재하지 않는다"는 다르다 (P17).

쓰이는 곳은 셋이다.

1. **지표 카탈로그** — BI에 그대로 붙이면 지표 목록 화면이 된다
2. **소비 측 판단 근거** — `additive_by_axis` 를 읽고 그 축으로 rollup 해도 되는지 결정한다
3. **서빙 레이어의 경로 선택** — 나중에 서빙을 만들면 `additive`를 보고
   daily rollup을 쓸지 atomic fact로 내려갈지 고른다 (aggregate awareness)

---


## 7. 지표 하나를 추가하는 절차

새 지표 `cancelled_units`(취소된 수량)를 예로 전 과정을 따라간다.
**사람이 만지는 파일은 `includes/metrics.js` 하나뿐이다.**

### 1단계 — 질문을 문장으로 쓴다

> "어느 날, 어떤 카테고리에서, 몇 개가 취소되었는가"

문장에서 세 가지가 나온다 — 세는 대상(**수량**), 시간축(**날짜**), 자르는 축(**카테고리**).

### 2단계 — 세는 대상의 grain으로 entity를 고른다

수량은 주문 라인 단위다. 따라서 entity는 `order_item`, 소스 테이블은 `sem_fct_order_items`.

| 세는 대상 | entity | 소스 테이블 |
|---|---|---|
| 수량 · 금액 · 이익 | `order_item` | `semantic_mart.sem_fct_order_items` |
| 주문 건수 | `order` | `semantic_mart.sem_fct_orders` |
| 세션 | `session` | `semantic_mart.sem_fct_sessions` |
| 이벤트 | `user_event` | `semantic_mart.sem_fct_user_events` |

entity가 정해지면 쓸 수 있는 dimension이 [1장의 dimension 도달 경로 표](#dimension-도달-경로-join-graph)로
결정된다. 고를 여지가 없다. `order_item`의 경우 이렇다.

| 쓸 수 있는 dimension | 가져오는 곳 | 조인 키 |
|---|---|---|
| `category` · `brand` · `department` | `semantic_mart.sem_dim_products` | `product_id` |
| `country` · `age_group` · `gender` · `acquisition_channel` | `semantic_mart.sem_dim_users` | `user_id` |
| `order_item_status` | `sem_fct_order_items` 자체 컬럼 | 조인 없음 |

이 중 필요한 것만 `dims`에 적으면, builder가 그 dimension에 닿는 조인만 골라서 붙인다.

### 3단계 — 축별 가산성을 판단한다 (P9)

각 축마다 한 문장으로 자문한다.

> **"세는 대상 하나가 이 축의 두 bucket에 동시에 속할 수 있는가?"**

| 축 | 자문 | 답 | 가산성 |
|---|---|---|---|
| 날짜 | 취소된 라인 하나가 여러 날에 속하는가 | 아니다 | `true` |
| 카테고리 | 라인 하나가 여러 카테고리에 속하는가 | 아니다 (라인 = 상품 1개) | `true` |
| 국가 | 라인 하나가 여러 국가에 속하는가 | 아니다 | `true` |

전부 `true`다. **하나라도 `false`가 나오면 2단계로 돌아간다** (P10).

> **`buyer_count`는 3단계에서 걸렸다.**
>
> 구매자 수는 어제도 구매하고 오늘도 구매한 사람이 있을 수 있다. 그래서 날짜축으로
> 더하면 같은 사람을 두 번 센다 — 날짜축 비가산이다.
>
> 2단계로 돌아가 고객 하나가 한 행인 fact로 옮기려 했지만 그런 테이블이 없다.
> 주문도 세션도 고객을 한 행으로 담지 않는다. **옮길 곳이 없을 때가 P10-2다.**
>
> 값 대신 병합 가능한 sketch를 저장하면 날짜축으로도 합칠 수 있다.
> `HLL_COUNT.INIT({user_id})`가 그래서 선택되었고, 가산성은 전 축 `"sketch"`가 되었다.

### 4단계 — 선언을 쓴다

```js
// includes/metrics.js
cancelled_units: {
  entity:      "order_item",
  expr:        "COUNTIF({order_item_status} = 'cancelled')",
  dims:        ["category", "brand", "department", "country"],
  additive:    { time: true, category: true, brand: true, department: true, country: true },
  description: "취소된 주문 수량",
},
```

`dims`의 모든 항목이 `additive`에 있어야 한다. 없으면 컴파일이 실패한다 (P19).

**여기서 사람의 작업은 끝난다.** 아래는 전부 생성된다.

### 5단계 — `daily_cancelled_units` (생성)

`entity.source`를 base로, `joins` 선언만큼 `LEFT JOIN`, `date_col` + dimension으로 `GROUP BY`.

```sql
SELECT
  base.ordered_date AS record_date,
  product.category, product.brand, product.department, user.country,
  COUNTIF(base.order_item_status = 'cancelled') AS cancelled_units
FROM semantic_mart.sem_fct_order_items AS base
LEFT JOIN semantic_mart.sem_dim_products AS product ON base.product_id = product.product_id
LEFT JOIN semantic_mart.sem_dim_users    AS user    ON base.user_id    = user.user_id
GROUP BY 1, 2, 3, 4, 5
```

| record_date | category | country | cancelled_units |
|---|---|---|---|
| 2026-03-01 | Jeans | China | 0 |
| 2026-03-02 | Jeans | China | 0 |
| 2026-03-03 | Jeans | China | 1 |

### 6단계 — `period_` · `metric_cancelled_units` (생성)

`additive` 가 전 축 `true` 이므로 dimension rollup 은 `SUM`, PTD 는 창 함수가
선택된다. 누계 3종이 컬럼으로 생기고, 비교 기준값 8개가 날짜 조인으로 붙는다 (P14).

월 단위로 보려면 `is_month_end` 를 건다 — `monthly` 라는 기간을 따로 만들지 않는다 (P13).

| record_date | is_month_end | cancelled_units_mtd | mtd_mom_base |
|---|---|---|---|
| 2026-01-31 | TRUE | 18 | 16 |
| 2026-02-28 | TRUE | 7 | 18 |
| 2026-03-31 | TRUE | 15 | 7 |

증감률(+0.1250 / −0.6111 / +1.1429)은 컬럼이 아니라 소비 시점에
`SAFE_DIVIDE(v - base, base)`로 계산한다 (P12).

### 7단계 — `metric_registry` 행 (생성)

| metric_name | metric_type | entity | expression | additive_by_axis | is_generated |
|---|---|---|---|---|---|
| `cancelled_units` | base | order_item | `COUNTIF(...)` | `{"time":true,...}` | true |

### 비용 요약

| | 사람 | 생성 |
|---|---|---|
| 파일 | `metrics.js` 6줄 | — |
| 테이블 | — | `daily_` 1 + `period_` 1 + `metric_` 1 |
| 기간 | — | 값 컬럼 4개 자동 |
| 비교 | — | 기준값 컬럼 8개 자동 |
| dimension rollup | — | 각 축의 `'(all)'` 행 자동 |
| 카탈로그 | — | registry 1행 |

**지표 추가 비용이 선언 한 항목으로 고정된다.** 이것이 이 구조의 이득 전부이고,
새 fact가 필요한 지표만 `entities.js`에 항목이 하나 더 붙는다.
