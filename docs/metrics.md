# 지표 정의서

`docs/principles.md`의 P8~P12를 이 프로젝트의 실제 지표에 적용한 것.
`includes/metrics.js`는 이 문서의 기계 판독 가능한 형태이고, **이 문서가 정본이다.**

- **기본 지표 14개** — 직접 집계된다. `daily_<metric>` + `metric_<metric>` 두 테이블을 갖는다
- **비율 지표 7개** — 기본 지표의 나눗셈이다. registry에만 등록하고 테이블을 만들지 않는다 (P12)

---

## 1. entity와 차원

**지표를 산출하는 fact 테이블이 entity가 된다.** entity가 정해지면 grain과
사용 가능한 차원이 따라서 정해진다.

| entity | 소스 | grain | 날짜 컬럼 |
|---|---|---|---|
| `order_item` | `sem_fct_order_items` | 주문 라인 1건 | `ordered_date` |
| `order` | `sem_fct_orders` | 주문 1건 | `ordered_date` |
| `session` | `sem_fct_sessions` | 세션 1건 | `session_date` |
| `user_event` | `sem_fct_user_events` | 이벤트 1건 | `event_date` |

### 차원 도달 경로 (join graph)

entity마다 **어떤 키로 어떤 dim에 닿아 어떤 차원을 얻는지**를 선언한 것이 join graph다.
표에 `●`가 없으면 그 entity에서 그 차원을 쓸 수 없다 (P6).

| 차원 | 출처 | 조인 키 | `order_item` | `order` | `session` | `user_event` |
|---|---|---|:---:|:---:|:---:|:---:|
| `category` | `sem_dim_products` | `product_id` | ● | | | |
| `brand` | `sem_dim_products` | `product_id` | ● | | | |
| `department` | `sem_dim_products` | `product_id` | ● | | | |
| `country` | `sem_dim_users` | `user_id` | ● | ● | ● | ● |
| `age_group` | `sem_dim_users` | `user_id` | ● | ● | | |
| `gender` | `sem_dim_users` | `user_id` | ● | ● | | |
| `acquisition_channel` | `sem_dim_users` | `user_id` | ● | ● | ● | |
| `order_status` | fact 자체 | 조인 없음 | ● | ● | | |
| `entry_traffic_source` | fact 자체 | 조인 없음 | | | ● | |
| `browser` | fact 자체 | 조인 없음 | | | ● | |
| `event_type` | fact 자체 | 조인 없음 | | | | ● |
| `traffic_source` | fact 자체 | 조인 없음 | | | | ● |

**`country`와 `acquisition_channel`만 네 entity를 가로지른다.** 이 둘이 conformed
dimension이고, 서로 다른 fact의 지표를 나란히 놓을 수 있는 축은 이것뿐이다 (P7).

**`order`에 상품 차원이 비어 있는 것은 누락이 아니다.** 한 주문이 여러 상품을
포함하므로 주문 grain에서 카테고리는 정의되지 않는다. 이 공백이 P10의 근거다.

---

## 2. 집계 경로 — 선언에서 결과까지

지표 하나가 선언에서 최종 숫자까지 가는 전 과정. `net_revenue`를 예로 든다.
차원은 설명을 위해 `category` · `country` 둘만 쓴다.

### 단계 0 — 선언

사람이 쓰는 것은 이 두 조각뿐이다. SQL은 쓰지 않는다.

```js
// includes/entities.js — 차원에 닿는 경로
order_item: {
  source: "sem_fct_order_items", pk: "order_item_key", date_col: "ordered_date",
  dims: {
    category: { from: "sem_dim_products", key: "product_id", col: "category" },
    country:  { from: "sem_dim_users",    key: "user_id",    col: "country"  },
  },
}

// includes/metrics.js — 무엇을 어떻게 집계하는가
net_revenue: {
  entity:   "order_item",
  expr:     "SUM(net_revenue)",
  dims:     ["category", "country"],
  additive: { time: true, category: true, country: true },
}
```

### 단계 1 — `daily_net_revenue`

생성기가 `entity.source`를 base로 놓고, `dims`에 선언된 경로만큼 `LEFT JOIN`을 붙이고,
`date_col` + 차원으로 `GROUP BY` 한다. **조인이 실행되는 곳은 여기 한 번뿐이다** (P5).

```sql
SELECT
  base.ordered_date     AS dt,
  p.category            AS category,
  u.country             AS country,
  SUM(base.net_revenue) AS net_revenue        -- ← metrics.js 의 expr
FROM semantic_mart.sem_fct_order_items AS base
LEFT JOIN semantic_mart.sem_dim_products AS p ON base.product_id = p.product_id
LEFT JOIN semantic_mart.sem_dim_users    AS u ON base.user_id    = u.user_id
GROUP BY 1, 2, 3
```

결과 — 차원이 평범한 컬럼으로 물화된다. **이 시점부터 조인은 더 필요 없다.**

| dt | category | country | net_revenue |
|---|---|---|---|
| 2026-03-02 | Jeans | China | 49.00 |
| 2026-03-03 | Jeans | China | 97.99 |
| 2026-03-04 | Jeans | China | 0.00 |

> **테이블은 지표당 하나다. 차원 조합마다 생기지 않는다.**
> 선언한 차원 전부가 한 테이블의 컬럼으로 들어가고, 행은 `날짜 × 실제로 존재하는 차원 조합`이다.
> 차원을 덜 쓰고 싶으면 그 컬럼을 `SUM`으로 걷어낸다 — **단 가산 축만** 걷을 수 있고,
> 그래서 `additive`가 축별로 필요하다 (P9).

### 단계 2 — `metric_net_revenue`

`daily_`를 읽어 period_type별로 롤업하고 비교 기준값을 붙인다. 롤업 방법은 `additive`가 정한다.

```sql
-- period_type = 'monthly'  (rollup + additive:true → SUM)
SELECT
  'monthly'                  AS period_type,
  DATE_TRUNC(dt, MONTH)      AS period_start,
  LAST_DAY(dt, MONTH)        AS as_of_date,
  category, country,
  SUM(net_revenue)           AS net_revenue
FROM semantic.daily_net_revenue
GROUP BY 1, 2, 3, 4, 5
```

비교는 같은 테이블을 날짜로 self-join 해서 **기준값만** 붙인다. 증감률은 저장하지 않는다 (P12·P14).

```sql
LEFT JOIN rolled AS b
  ON b.period_type  = c.period_type                                -- 같은 기간 종류끼리
 AND b.period_start = DATE_SUB(c.period_start, INTERVAL 1 YEAR)
 AND <차원 NULL-safe 비교>
→ b.net_revenue AS yoy_base
```

> **시프트 간격은 기간마다 다르다.** `weekly`의 YoY를 `1 YEAR`로 하면
> 2026-03-02(월)의 1년 전이 일요일이라 주 시작일에 떨어지지 않고 매칭이 전부 실패한다.
> 주간 비교는 **52주(364일)** 시프트여야 같은 요일에 떨어진다.
> 생성기가 `periods.js`의 선언을 읽어 `CASE period_type`으로 처리한다.

결과 — 실제 데이터로 확인한 값이다. `yoy`는 컬럼이 아니라 소비 시점의 계산이다.

| period_start | category | country | net_revenue | yoy_base | *(소비 시점)* yoy |
|---|---|---|---|---|---|
| 2026-01-01 | Jeans | China | 10,503.28 | 5,353.59 | +0.9619 |
| 2026-02-01 | Jeans | China | 9,044.44 | 4,530.27 | +0.9964 |
| 2026-03-01 | Jeans | China | 9,477.63 | 5,712.17 | +0.6592 |
| 2026-04-01 | Jeans | China | 8,641.67 | 5,058.07 | +0.7085 |

> **증감률을 저장하면 안 되는 이유.** `category`를 걷어내고 국가별로만 볼 때,
> 저장된 `yoy`는 `AVG`로 0.9969, `SUM`으로 24.9235가 나온다. 둘 다 틀렸다.
> `SAFE_DIVIDE(SUM(v) - SUM(yoy_base), SUM(yoy_base))` = **0.9140**이 정답이다.
> `yoy_base`는 가산이라 차원을 걷어도 살아남는다.

### 롤업 방법 — `additive`가 함수를 고른다

**롤업**은 daily 여러 행을 기간 한 행으로 만드는 집계다.

```
daily_net_revenue                                monthly
  2026-03-01  Jeans  China     49.00  ┐
  2026-03-02  Jeans  China     97.99  ├─ 롤업 →  2026-03-01  Jeans  China  9,477.63
  ...                                 │
  2026-03-31  Jeans  China    210.50  ┘
```

어떤 함수로 롤업할지는 `period_type`과 `additive`의 조합이 결정한다. 사람은 고르지 않는다.

| period_type | additive | 패턴 |
|---|---|---|
| `daily` | 무관 | 통과. 저장 형식 그대로 |
| `weekly` `monthly` `yearly` | `true` | `SUM` + `GROUP BY DATE_TRUNC` |
| `weekly` `monthly` `yearly` | `"sketch"` | `HLL_COUNT.MERGE_PARTIAL` + `GROUP BY DATE_TRUNC` |
| `weekly` `monthly` `yearly` | `"last"` | `ANY_VALUE(... HAVING MAX dt)` |
| 모든 기간 | `false` | **생성 거부** (P18) |

스케치는 롤업에서도 스케치로 남는다. `MERGE`로 정수를 만들면 더 롤업할 수 없다 (P11).

**기간 누계(WTD·MTD·YTD)는 여기 없다.** 저장하지 않고 소비 시점에 `daily_` 구간
합으로 낸다 (P15). 비율과 같은 이유다 — 파생 가능하고 롤업에서 깨진다.

### `additive`는 어디서 읽히는가

축마다 소비처가 다르다. **시간 축만 생성기가 자동으로 쓴다.**

```
선언 (metrics.js)
  additive: { time: true, category: true, country: true }
        │
        ├── time ──────→ 【생성기가 읽는다 · 컴파일 타임】
        │                 period.type × additive.time  →  위 표에서 SQL 템플릿 선택
        │                 false면 그 기간 테이블을 아예 만들지 않는다 (P18)
        │
        └── 차원 축 ────→ 【생성기는 쓰지 않는다】
                          차원 축 롤업은 소비 시점에 Dataform 밖에서 일어난다
                          ① metric_registry 컬럼으로 나가 소비 측이 읽는다
                          ② 설계 시점의 신호 — false면 entity가 틀린 것이다 (P10)
```

차원 축에 `false`를 쓰게 되면 기록하고 넘어갈 사실이 아니라 **고쳐야 할 신호**다.
현재 기본 지표 14개에는 `false`가 하나도 없다. `order_count`를 `order` entity로
옮기면서 마지막 하나가 사라졌다.

`metrics.js`의 `dims`에 있는 차원이 `additive`에 없으면 `dataform compile`이 실패한다 (P19).

```js
dims:     ["category", "brand", "country"]
additive: { time: true, category: true, country: true }
                                  ↑ brand 누락 → 컴파일 실패
```

이 검증이 없으면 `brand` 축으로 걷어내도 되는지 아무도 모르는 채로 테이블이 만들어진다.
선언 누락이 조용히 틀린 숫자로 나타나는 것을 막는 마지막 장치다.

### 잘못 선언하면 무슨 일이 생기는가

`active_user`를 `additive.time: true`로 선언했다고 가정하고 같은 데이터를 세 가지로 계산한 것.

| as_of_date | 일별 값 | `true`로 잘못 → `SUM` | `"sketch"` → `MERGE` | 원자 fact 정답 |
|---|---:|---:|---:|---:|
| 2026-03-01 | 158 | 158 | 158 | 158 |
| 2026-03-02 | 152 | 310 | **290** | **290** |
| 2026-03-03 | 144 | 454 | **413** | **413** |
| 2026-03-04 | 155 | 609 | **528** | **528** |
| 2026-03-05 | 188 | 797 | **679** | **679** |

스케치 경로는 원자 fact를 직접 센 값과 일치하고, `SUM`은 5일 만에 **17.4% 부푼다.**
여러 날 활동한 사용자를 중복으로 세기 때문이다.

**에러가 나지 않는다는 점이 중요하다.** 쿼리는 성공하고 숫자만 틀린다.
`additive` 선언은 이 차이를 컴파일 타임에 결정한다.

### 요약

```
선언 (JS)              생성 (Dataform)                  결과 (BigQuery)
─────────────────────  ──────────────────────────────  ───────────────────────
entities.js  ─┐
              ├──→  조인 + 날짜×차원 GROUP BY  ──→  daily_<metric>    중간 상태
metrics.js   ─┘                                          │
                                                         ▼
periods.js   ────→  기간 롤업 + 비교 기준값 조인  ──→  metric_<metric>  서빙 표면
```

이 구조가 주는 것은 순서대로 이렇다.

1. **정의가 하나다.** `net_revenue`가 무엇인지가 `metrics.js` 한 줄에만 있다.
   이것이 semantic layer의 존재 이유이고 나머지는 부수 효과다
2. **daily 이후 조인이 없다.** 소비 경로가 단순해지고 빨라진다
3. **대가 — 선언한 차원으로만 자를 수 있다.** 새 차원은 선언 추가와 재생성이 필요하다

속도만 목적이라면 집계 캐시로 충분하다. 이 구조는 1번을 위한 것이다.

> 예시 쿼리는 `semantic_mart`가 아직 없어 DW 테이블에 직접 실행한 결과다.
> 마트를 만든 뒤에는 컬럼명이 규칙에 맞게 바뀐다 — `category_name` → `category`.

---

## 3. 기본 지표

직접 집계되는 지표. 각각 `daily_<metric>`과 `metric_<metric>` 두 테이블을 갖는다.
차원은 별도 표기가 없으면 **그 entity에서 쓸 수 있는 차원 전체**를 쓴다 (1장 표).

가산성 — `●` 가산 / `○` 스케치

| 지표 | entity | 집계식 | 필터 | 가산성 |
|---|---|---|---|:---:|
| `gross_revenue` | `order_item` | `SUM(sale_price)` | — | ● |
| `net_revenue` | `order_item` | `SUM(net_revenue)` | — | ● |
| `cogs` | `order_item` | `SUM(IF(is_revenue_recognized, unit_cost, 0))` | — | ● |
| `gross_profit` | `order_item` | `SUM(net_gross_profit)` | — | ● |
| `units_sold` | `order_item` | `COUNTIF(is_revenue_recognized)` | — | ● |
| `units_returned` | `order_item` | `COUNTIF(order_item_status = 'returned')` | — | ● |
| `buyer_count` | `order_item` | `HLL_COUNT.INIT(user_id)` | `is_revenue_recognized` | ○ |
| `order_count` | `order` | `COUNT(*)` | — | ● |
| `returned_order_count` | `order` | `COUNTIF(order_status = 'returned')` | — | ● |
| `session_count` | `session` | `COUNT(*)` | — | ● |
| `bounce_count` | `session` | `COUNTIF(is_bounce)` | — | ● |
| `visitor_count` | `session` | `HLL_COUNT.INIT(user_id)` | — | ○ |
| `event_count` | `user_event` | `COUNT(*)` | — | ● |
| `active_user` | `user_event` | `HLL_COUNT.INIT(user_id)` | — | ○ |

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

### HLL 지표

`buyer_count` · `visitor_count` · `active_user` 셋은 스케치로 저장한다.
precision은 **15 고정**이며 나중에 바꾸면 과거 스케치와 병합할 수 없다.
기대 오차 약 1.6%이므로 정산·과금 용도로 쓰지 않는다.

---

## 4. 비율 지표 — registry 전용

테이블을 만들지 않는다. 분자와 분모가 각각 기본 지표이고, 나눗셈은 소비 시점에 한다 (P12).

| 지표 | 분자 | 분모 | 유효 차원 |
|---|---|---|---|
| `gross_margin_rate` | `gross_profit` | `net_revenue` | order_item 전 축 |
| `return_rate` | `units_returned` | `units_sold` | order_item 전 축 |
| `bounce_rate` | `bounce_count` | `session_count` | session 전 축 |
| `order_return_rate` | `returned_order_count` | `order_count` | order 전 축 |
| `aov` | `net_revenue` | `order_count` | **교집합만** |
| `units_per_order` | `units_sold` | `order_count` | **교집합만** |
| `revenue_per_buyer` | `net_revenue` | `buyer_count` | 교집합 + 근사 |

### 교집합 규칙

비율은 **분자와 분모가 공유하는 차원에서만 유효하다.**

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
| 중앙값·분위수 계열 | 스케치로도 병합 불가. daily만 만들고 롤업 거부 대상 (P10-3) |
| 주문 시점 상품 속성 | 상류 결함 5. SCD 이력 커버리지 4.46% |

앞의 넷은 **daily의 상위 집계가 아니라 atomic fact에 대한 다른 질문**이다.
생성기 밖에서 별도 모델로 만들되 registry에는 `custom: true`로 등록한다.

---

## 6. 산출물

```
semantic_mart      sem_dim_* 3개  +  sem_fct_* 4개                    7
semantic           daily_<metric> 14  +  metric_<metric> 14          28
semantic_metadata  metric_registry                                    1
                                                                  ─────
                                                                     36
```

### `daily_<metric>` — 중간 상태

`sem_fct_*`에 `sem_dim_*`을 조인해 `날짜 × 차원`으로 집계한 결과.
distinct 계열은 HLL 스케치(BYTES)로 남는다. 소비용이 아니라 `metric_`의 재료다.

### `metric_<metric>` — 서빙 표면

`daily_`를 4개 기간(`daily` `weekly` `monthly` `yearly`)으로 롤업하고
비교 기준값 4종(`dod_base` `wow_base` `mom_base` `yoy_base`)을 붙인 것.
`period_type` 판별 컬럼으로 한 테이블에 담는다.

**`daily_`와 같은 저장 원칙을 따른다** (P11) — 스케치는 BYTES로 남고 증감률은 저장하지 않는다.
확정은 소비 시점에 한다.

| 컬럼 | 내용 |
|---|---|
| `period_type` | `daily` `weekly` `monthly` `yearly` |
| `period_start` · `as_of_date` | 기간의 시작일과 종료일 (P13) |
| *(차원들)* | `daily_`와 동일 |
| *(지표값)* | 가산 지표는 값, distinct 계열은 스케치(BYTES) |
| `*_base` | 시프트한 기간의 지표값. 가산이므로 차원 롤업 가능 |

소비 시점에 하는 일은 둘뿐이다.

```sql
-- 차원 걷기 + 증감률 계산
SELECT country,
       SUM(net_revenue) AS net_revenue,
       SAFE_DIVIDE(SUM(net_revenue) - SUM(yoy_base), SUM(yoy_base)) AS yoy
FROM semantic.metric_net_revenue
WHERE period_type = 'monthly' AND period_start = '2026-03-01'
GROUP BY country

-- 스케치 지표는 MERGE 를 한 번 더 부른다
SELECT country, HLL_COUNT.MERGE(active_user) AS active_user
FROM semantic.metric_active_user
WHERE period_type = 'monthly' GROUP BY country
```

### 기간 누계 — 소비 시점 패턴

WTD·MTD·YTD는 테이블에 없다 (P15). `daily_`에서 구간을 잘라 합한다.
`dt` 파티션 프루닝이 걸려 전체 스캔의 1% 미만만 읽는다.

```sql
-- MTD, 그리고 작년 같은 날 MTD 를 한 번에
WITH ptd AS (
  SELECT
    IF(dt >= DATE_TRUNC(@as_of, MONTH), 'current', 'prior') AS period,
    country,
    SUM(net_revenue) AS net_revenue
  FROM semantic.daily_net_revenue
  WHERE dt BETWEEN DATE_TRUNC(@as_of, MONTH) AND @as_of
     OR dt BETWEEN DATE_TRUNC(DATE_SUB(@as_of, INTERVAL 1 YEAR), MONTH)
                AND DATE_SUB(@as_of, INTERVAL 1 YEAR)
  GROUP BY 1, 2
)
SELECT country,
       MAX(IF(period='current', net_revenue, NULL)) AS mtd,
       MAX(IF(period='prior',   net_revenue, NULL)) AS mtd_yoy_base
FROM ptd GROUP BY country
```

주 누계는 `WEEK(MONDAY)`, 연 누계는 `YEAR`로 `DATE_TRUNC`만 바꾼다.
스케치 지표는 `SUM` 대신 `HLL_COUNT.MERGE`를 쓴다.

### `metric_registry` — 지표 카탈로그

**`includes/metrics.js`의 선언을 BigQuery 테이블로 물화한 것.** 행 하나가 지표 하나다.

선언이 JS 파일에만 있으면 어떤 쿼리로도 읽을 수 없다.
registry가 있으면 "`net_revenue`가 무엇인가"를 SQL로 답할 수 있다.

| 컬럼 | 내용 |
|---|---|
| `metric_name` | 지표 이름 |
| `metric_type` | `base` / `ratio` |
| `description` | 설명문 |
| `entity` · `entity_grain` | 산출 fact와 그 grain |
| `expression` · `filter` | 집계식과 필터 |
| `dimensions` | 사용 차원 배열 |
| `additive_by_axis` | 축별 가산성 JSON |
| `numerator` · `denominator` | 비율 지표 전용 |
| `is_generated` | 테이블이 생성되었는가 (P17) |

예시 행:

| metric_name | metric_type | entity | expression | additive_by_axis | is_generated |
|---|---|---|---|---|---|
| `net_revenue` | base | order_item | `SUM(net_revenue)` | `{"time":true,...}` | true |
| `active_user` | base | user_event | `HLL_COUNT.INIT(user_id)` | `{"time":"sketch",...}` | true |
| `aov` | ratio | — | — | — | false |
| `cohort_retention` | base | order_item | — | — | false |

**비율 지표 7개는 테이블이 없으므로 registry가 유일한 거처다.**
5장의 제외 지표도 `is_generated: false`로 여기 남는다 — "생성되지 않았다"와
"존재하지 않는다"는 다르다 (P17).

쓰이는 곳은 셋이다.

1. **지표 카탈로그** — BI에 그대로 붙이면 지표 목록 화면이 된다
2. **소비 측 판단 근거** — `additive_by_axis`를 읽고 그 축으로 걷어내도 되는지 결정한다
3. **서빙 레이어의 경로 선택** — 나중에 서빙을 만들면 `additive`를 보고
   daily 롤업을 쓸지 원자 fact로 내려갈지 고른다 (aggregate awareness)

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

entity가 정해지면 쓸 수 있는 차원이 [1장의 차원 도달 경로 표](#차원-도달-경로-join-graph)로
결정된다. 고를 여지가 없다. `order_item`의 경우 이렇다.

| 쓸 수 있는 차원 | 가져오는 곳 | 조인 키 |
|---|---|---|
| `category` · `brand` · `department` | `semantic_mart.sem_dim_products` | `product_id` |
| `country` · `age_group` · `gender` · `acquisition_channel` | `semantic_mart.sem_dim_users` | `user_id` |
| `order_status` | `sem_fct_order_items` 자체 컬럼 | 조인 없음 |

이 중 필요한 것만 `dims`에 적으면, 생성기가 그 차원에 닿는 조인만 골라서 붙인다.

### 3단계 — 축별 가산성을 판단한다 (P9)

각 축마다 한 문장으로 자문한다.

> **"세는 대상 하나가 이 축의 두 버킷에 동시에 속할 수 있는가?"**

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
> 값 대신 병합 가능한 스케치를 저장하면 날짜축으로도 합칠 수 있다.
> `HLL_COUNT.INIT(user_id)`가 그래서 선택되었고, 가산성은 전 축 `"sketch"`가 되었다.

### 4단계 — 선언을 쓴다

```js
// includes/metrics.js
cancelled_units: {
  entity:      "order_item",
  expr:        "COUNTIF(order_item_status = 'cancelled')",
  dims:        ["category", "brand", "department", "country"],
  additive:    { time: true, category: true, brand: true, department: true, country: true },
  description: "취소된 주문 수량",
},
```

`dims`의 모든 항목이 `additive`에 있어야 한다. 없으면 컴파일이 실패한다 (P19).

**여기서 사람의 작업은 끝난다.** 아래는 전부 생성된다.

### 5단계 — `daily_cancelled_units` (생성)

`entity.source`를 base로, `dims` 경로만큼 `LEFT JOIN`, `date_col` + 차원으로 `GROUP BY`.

```sql
SELECT
  base.ordered_date AS dt,
  p.category, p.brand, p.department, u.country,
c  COUNTIF(base.order_item_status = 'cancelled') AS cancelled_units
FROM semantic_mart.sem_fct_order_items AS base
LEFT JOIN semantic_mart.sem_dim_products AS p ON base.product_id = p.product_id
LEFT JOIN semantic_mart.sem_dim_users    AS u ON base.user_id    = u.user_id
GROUP BY 1, 2, 3, 4, 5
```

| dt | category | country | cancelled_units |
|---|---|---|---|
| 2026-03-01 | Jeans | China | 0 |
| 2026-03-02 | Jeans | China | 0 |
| 2026-03-03 | Jeans | China | 1 |

### 6단계 — `metric_cancelled_units` (생성)

`additive.time = true`이므로 롤업은 `SUM`이 선택된다.
4개 기간이 모두 생성되고, 비교 기준값이 날짜 조인으로 붙는다 (P14).

| period_type | period_start | as_of_date | cancelled_units | mom_base |
|---|---|---|---|---|
| monthly | 2026-01-01 | 2026-01-31 | 18 | 16 |
| monthly | 2026-02-01 | 2026-02-28 | 7 | 18 |
| monthly | 2026-03-01 | 2026-03-31 | 15 | 7 |

증감률(+0.1250 / −0.6111 / +1.1429)은 컬럼이 아니라 소비 시점에
`SAFE_DIVIDE(SUM(v) - SUM(mom_base), SUM(mom_base))`로 계산한다 (P12).

### 7단계 — `metric_registry` 행 (생성)

| metric_name | metric_type | entity | expression | additive_by_axis | is_generated |
|---|---|---|---|---|---|
| `cancelled_units` | base | order_item | `COUNTIF(...)` | `{"time":true,...}` | true |

### 비용 요약

| | 사람 | 생성 |
|---|---|---|
| 파일 | `metrics.js` 6줄 | — |
| 테이블 | — | `daily_` 1 + `metric_` 1 |
| 기간 | — | 4종 자동 |
| 비교 | — | 4종 자동 |
| 카탈로그 | — | registry 1행 |

**지표 추가 비용이 선언 한 항목으로 고정된다.** 이것이 이 구조의 이득 전부이고,
새 fact가 필요한 지표만 `entities.js`에 항목이 하나 더 붙는다.
