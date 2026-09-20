# 테이블 구조

- BigQuery 에 실제로 만들어지는 테이블 전부
- 용어는 [glossary.md](glossary.md) 를 따름
- 왜 이 모양인지는 [architecture.md](architecture.md) 에 있음

## 1. 전체 목록

| 데이터셋 | 테이블 | 개수 |
|---|---|---|
| `semantic_mart` | `sem_dim_*` 3 + `sem_fct_*` 4 | 7 |
| `semantic` | `daily_<metric>` · `period_<metric>` · `metric_<metric>` | 55 |
| `semantic_metadata` | `metric_registry` | 1 |
| `semantic_assertions` | assertion 결과. Dataform 이 만듦 | — |

- `semantic` 의 55개는 **지표 17개 × 3단계 + 조합 2개 × 2단계**임
- `daily_` 는 지표당 하나이고, `period_`·`metric_` 은 dimension 조합마다 한 쌍임
- 지표마다 컬럼 구성이 같고 dimension 개수만 조합에 따라 다름

---

## 2. `semantic_mart` — DW 를 정규화한 중간 테이블

- 사람이 SQL 을 쓰는 유일한 곳임
- 이름 정규화 · 자연키 제거 · grain 보증을 함

### 2-1. dimension 3개

| 테이블 | PK | 컬럼 |
|---|---|---|
| `sem_dim_users` | `user_id` | `email_domain` · `age` · **`age_group`** · `gender` · `city` · `state` · **`country`** · `postal_code` · **`acquisition_channel`** · `signed_up_at` · `signed_up_date` · `signup_cohort_month` |
| `sem_dim_products` | `product_id` | `product_name` · **`brand`** · **`category`** · **`department`** · `sku` · `unit_cost` · `retail_price` · `list_margin_rate` · `distribution_center_id` · `distribution_center_name` |
| `sem_dim_date` | `date_day` | `year` · `quarter` · `month` · `day_of_month` · `day_of_week` · `day_name` · `year_month` · `week_start_date` · `week_end_date` · `month_start_date` · `month_end_date` · `quarter_start_date` · `year_start_date` · `year_end_date` · `is_weekend` |

- **굵은 것이 `entities.js` 에서 dimension 으로 선언된 컬럼**임
- 나머지는 마트에만 있음

- `sem_dim_date` 는 2018~2031 날짜를 담음
- `period_` 의 `grid` 가 이 테이블에서 날짜를 가져옴
- `daily_` 는 조인하지 않음

### 2-2. fact 4개

| 테이블 | PK | 날짜 컬럼 | grain |
|---|---|---|---|
| `sem_fct_order_items` | `order_item_key` | `ordered_date` | 주문 라인 1건 |
| `sem_fct_orders` | `order_key` | `ordered_date` | 주문 1건 |
| `sem_fct_sessions` | `session_id` | `session_date` | 세션 1건 |
| `sem_fct_user_events` | `event_key` | `event_date` | 이벤트 1건 |

- `sem_fct_order_items` 의 컬럼임
- 지표 수식이 쓰는 것을 굵게 표시했음

```
order_item_key · order_key · user_id · product_id · distribution_center_id
order_item_status · order_status · is_revenue_recognized
sale_price · unit_cost · gross_profit · net_revenue · net_gross_profit · discount_rate
ordered_at · ordered_date · shipped_at · delivered_at · returned_at
days_to_ship · days_to_deliver
```

- **PK 는 전부 surrogate key 임.** 원본의 `order_id` · `order_item_id` 는 ID 를 재사용해서
  유일하지 않음
- 마트에서 아예 제거해 잘못된 조인을 구조적으로 막음

- **`measure` 를 다시 정의하지 않음.** `net_revenue` 는 DW 가 `is_revenue_recognized` 로 이미
  정의했음
- 마트는 그대로 들고 옴

---

## 3. `daily_<metric>` — 1단계

- `record_date × dimension 전체` 집계
- 조인이 실행되는 유일한 곳임

```
record_date  DATE      파티션
<dimension>  STRING    entity 의 dims 전부
<metric>     NUMERIC   가산 지표
             BYTES     sketch 지표 (HLL)
```

- `daily_net_revenue` 의 실제 컬럼임

```
record_date · category · department · country · age_group · gender ·
acquisition_channel · order_item_status · purchase_type · net_revenue
```

| 항목 | 값 |
|---|---|
| 파티션 | `record_date` |
| clustering | 없음. BigQuery 권장 기준 64 MB 인데 최대가 16.7 MB 임 |
| assertion | `uniqueKey(record_date, ...dims)` · `nonNull(record_date)` |
| 갱신 | entity 의 `refresh` 를 따름 |

- **`NULL` 이 그대로 남음.** 조인이 `LEFT JOIN` 이라 fact 키가 dimension 에 없으면 dimension 이
  `NULL` 이 되는데, 그것도 하나의 bucket 임 (P6-1)
- `'(unknown)'` 으로 바꾸는 것은 2단계임

---

## 4. `period_<metric>` — 2단계

- `record_date × serving_dims` 에 rollup 행과 PTD 컬럼을 붙인 것

```
record_date      DATE      파티션
<serving_dims>   STRING    '(all)' rollup 행과 '(unknown)' bucket 을 포함한다
is_week_end      BOOL
is_month_end     BOOL
is_year_end      BOOL
<metric>         NUMERIC   그날 하루
<metric>_wtd     / BYTES   주 시작 ~ record_date
<metric>_mtd
<metric>_ytd
```

- `period_net_revenue` 의 실제 컬럼임 (13개)

```
record_date · country · age_group · gender · acquisition_channel · purchase_type ·
is_week_end · is_month_end · is_year_end ·
net_revenue · net_revenue_wtd · net_revenue_mtd · net_revenue_ytd
```

| 항목 | 값 |
|---|---|
| 파티션 | `record_date` |
| assertion | `uniqueKey(record_date, ...serving_dims)` · `nonNull(record_date, serving_dims, is_*_end)` |
| 갱신 | `table`. 매번 전부 다시 만듦 |

- **`category` · `department` · `order_item_status` 가 여기 없음.** `serving_dims`
  밖이라 컬럼 자체가 생기지 않음
- 그 dimension 별 집계는 `daily_` 에서 직접 냄

---

## 5. `metric_<metric>` — 3단계 · 서빙 테이블

- `period_` 의 모든 컬럼 + 비교 기준값 8개
- **소비자는 이 테이블만 읽음.**

```
                        (period_ 의 컬럼 전부)
dod_base                daily 의 1일 전
wow_base                daily 의 1주 전
yoy_base                daily 의 1년 전
wtd_wow_base            wtd  의 1주 전
wtd_yoy_base            wtd  의 364일 전
mtd_mom_base            mtd  의 1개월 전
mtd_yoy_base            mtd  의 1년 전
ytd_yoy_base            ytd  의 1년 전
```

- `metric_net_revenue` 의 실제 컬럼임 (21개)

```
record_date · country · age_group · gender · acquisition_channel · purchase_type ·
is_week_end · is_month_end · is_year_end ·
net_revenue · net_revenue_wtd · net_revenue_mtd · net_revenue_ytd ·
dod_base · wow_base · yoy_base ·
wtd_wow_base · wtd_yoy_base · mtd_mom_base · mtd_yoy_base · ytd_yoy_base
```

**컬럼 이름 규칙 — 기간 접두어가 없으면 `daily` 임.**

- **`_base` 는 증감률이 아니라 기준 시점의 값임.** 나눗셈은 조회할 때 함

```sql
SAFE_DIVIDE(net_revenue_mtd - mtd_yoy_base, mtd_yoy_base)
```

- `NULL` 은 0 이 아니라 **그 시점에 같은 dimension 조합이 없었다**는 뜻임

---

## 6. 조합 테이블 — `period_<metric>__<조합>`

- 지표가 `rollups` 를 선언하면 조합마다 `period_`·`metric_` 한 쌍이 더 생김
- 기본 조합(접미어 없는 테이블)은 그대로 남음

| 테이블 | dimension | 행 | 크기 |
|---|---|---|---|
| `period_net_revenue__category` | `purchase_type` · `category` | 228,096 | 20.6 MB |
| `metric_net_revenue__category` | 위와 같음 + 비교 기준값 8컬럼 | 228,096 | 46.6 MB |
| `period_gross_revenue__category` | `purchase_type` · `category` | 228,096 | 20.6 MB |
| `metric_gross_revenue__category` | 위와 같음 + 비교 기준값 8컬럼 | 228,096 | 46.6 MB |

- 조합 수는 `(2+1) × (26+1) = 81` 이고, 날짜 2,816일을 곱해 228,096행임
- `+1` 은 각 축의 `'(all)'` rollup 행임
- 기본 조합이 1,426만 행 · 1,497 MB 이니 **1.6%** 임

- `daily_` 는 조합과 무관하게 지표당 하나임
- `metric_<metric>__<조합>` 은 짝이 맞는 `period_<metric>__<조합>` 만 읽음

## 7. 지표별 크기

- dimension 개수가 entity 마다 달라서 행 수가 크게 차이 남

| entity | 지표 | `dims` | `serving_dims` | `daily_` 행 | `period_`·`metric_` 행 |
|---|---|---|---|---|---|
| `order_item` | `gross_revenue` `net_revenue` `cogs` `gross_profit` `order_item_count` `units_sold` `units_returned` `buyer_count` `paying_buyer_count` `void_buyer_count` | 8 | 5 | 204,238 | 14,260,224 |
| `order` | `order_count` `returned_order_count` | 6 | 5 | 130,754 | 14,245,032 |
| `session` | `session_count` `bounce_count` `visitor_count` | 4 | 2 | 158,878 | 249,823 |
| `user_event` | `event_count` `active_user` | 3 | 1 | 269,542 | 44,912 |

- `period_`·`metric_` 의 행 수는 **rollup 포함 조합 수 × 날짜 수**로 정해짐
- 날짜 수는 그 entity 의 `daily_` 가 가진 구간이라 entity 마다 다름

| entity | 조합 | rollup 포함 | 날짜 | 행 |
|---|---|---|---|---|
| `order_item` | 1,409 | 5,064 | 2,816 | 14,260,224 |
| `order` | 1,409 | 5,064 | 2,813 | 14,245,032 |
| `session` | 68 | 89 | 2,807 | 249,823 |
| `user_event` | 15 | 16 | 2,807 | 44,912 |

- `order_item` 과 `order` 는 `serving_dims` 가 같아 조합이 5,064 로 같고, 날짜 범위만 다름 —
  `fct_orders` 의 적재가 늦음 (상류 결함 4)

- `purchase_type`(값 2개)을 넣으면서 조합이 1,708 → 5,064 로 2.96배가 됐음
- 값이 2개인 dimension 이 3배를 만드는 것은 rollup 행 때문임 — `first` · `repeat` · `'(all)'`

### 7-1. 저장 크기

- sketch 지표가 가산 지표보다 큼
- 값 컬럼 12개가 전부 `BYTES` 이기 때문임

| 테이블 | 행 | 크기 |
|---|---|---|
| `daily_net_revenue` | 204,238 | 16.8 MB |
| `period_net_revenue` | 14,260,224 | 1,497.1 MB |
| `metric_net_revenue` | 14,260,224 | 3,121.6 MB |
| `daily_buyer_count` | 204,238 | 18.4 MB |
| `period_buyer_count` | 14,260,224 | 2,328.1 MB |
| `metric_buyer_count` | 14,260,224 | 3,924.2 MB |
| `period_event_count` | 44,912 | 2.3 MB |

- `semantic` 전체는 55개 테이블 · 3억 4,571만 행 · 47.7 GB 임
- 행 수는 날마다 조금씩 늚

---

## 8. `metric_registry` — 지표 카탈로그

- 선언을 테이블로 만든 것
- 29행임 (base 17 · ratio 7 · excluded 5)

| 컬럼 | 타입 | 내용 |
|---|---|---|
| `metric_name` | STRING | PK |
| `metric_type` | STRING | `base` · `ratio` · `excluded` |
| `description` | STRING | 설명문 |
| `entity` | STRING | 산출 fact. `ratio`·`excluded` 는 `NULL` |
| `entity_grain` | STRING | 그 fact 의 grain |
| `expression` | STRING | 집계식. 선언 원문이라 `{}` 표기가 남아 있음 |
| `filter` | STRING | 집계 전 행 필터 |
| `dimensions` | ARRAY\<STRING\> | `daily_` 가 가진 dimension 전부 |
| `additive_by_axis` | STRING | 축별 가산성 JSON |
| `serving_dims` | ARRAY\<STRING\> | `metric_` 의 dimension |
| `value_columns` | ARRAY\<STRING\> | `metric_` 의 값 컬럼 4개 |
| `compare_columns` | ARRAY\<STRING\> | 비교 기준값 컬럼 8개 |
| `numerator` · `denominator` | STRING | `ratio` 전용 |
| `is_approximate` | BOOL | HLL sketch 를 쓰는가 |
| `is_generated` | BOOL | 테이블이 생성되었는가 |
| `serving_table` | STRING | 조회할 테이블 |
| `exclusion_reason` | STRING | `excluded` 전용 |

- **"생성되지 않았다" 와 "존재하지 않는다" 는 다름.** 비율 7개와 제외 5개는 registry 가 유일한 거처임

```sql
-- net_revenue 가 무엇인지 SQL 로 묻는다
SELECT entity, entity_grain, expression, dimensions, serving_dims, value_columns
FROM semantic_metadata.metric_registry
WHERE metric_name = 'net_revenue'
```

---

## 9. 테이블 간 의존

- `dataform compile` 이 `ctx.ref()` 호출로 만드는 그래프임

```
dim_products     → sem_dim_products  ─┐
dim_users        → sem_dim_users     ─┤
fct_order_items  → sem_fct_order_items┼→ daily_<metric> → period_<metric> → metric_<metric>
fct_orders       → sem_fct_orders    ─┤
fct_sessions     → sem_fct_sessions  ─┤
fct_user_events  → sem_fct_user_events┘
(없음)           → sem_dim_date ────────────────────→ period_<metric>

(없음)           → metric_registry      선언만 읽는다. ref() 가 없다
```

- **마트 테이블끼리는 서로 참조하지 않음.** 전부 DW declaration 만 읽음 — fact 간 조인이 금지되어 있기 때문임

---

## 10. 조회 예시

```sql
-- 전사 이번 달 누계와 작년 같은 날까지
SELECT net_revenue_mtd, mtd_yoy_base
FROM semantic.metric_net_revenue
WHERE record_date = CURRENT_DATE()
  AND country='(all)' AND age_group='(all)'
  AND gender='(all)' AND acquisition_channel='(all)'

-- country 별 월별 추이 12개월
SELECT record_date, country, net_revenue_mtd
FROM semantic.metric_net_revenue
WHERE is_month_end
  AND age_group='(all)' AND gender='(all)' AND acquisition_channel='(all)'
ORDER BY record_date DESC LIMIT 12

-- sketch 지표는 EXTRACT 를 한 번 더 부른다
SELECT HLL_COUNT.EXTRACT(buyer_count_mtd) AS buyers_mtd
FROM semantic.metric_buyer_count
WHERE record_date = CURRENT_DATE() AND country='KR'
  AND age_group='(all)' AND gender='(all)' AND acquisition_channel='(all)'

-- serving_dims 밖의 dimension 은 daily_ 에서 낸다
SELECT category, SUM(net_revenue) AS mtd
FROM semantic.daily_net_revenue
WHERE record_date BETWEEN DATE_TRUNC(@d, MONTH) AND @d
GROUP BY category
```

**`'(all)'` 조건을 빠뜨리면 rollup 행과 원본 행이 같이 나와 이중 계산됨.**
- `metric_` 을 조회할 때는 모든 dimension 에 조건을 걺
