# Semantic Layer 원칙

이 문서는 이 레포에서 semantic layer를 만들 때의 판단 기준이다.
구현 방법이 아니라 **논쟁이 생겼을 때 되돌아올 근거**를 적는다.

## 이 layer가 만드는 것

**하나 — 지표 정의가 단일 원천이 된다.**
`net_revenue`가 무엇인지가 `includes/metrics.js` 한 곳에만 있다.
정의를 바꾸면 그것을 쓰는 모든 산출물이 함께 바뀐다. 찾아다닐 곳이 없다.

**둘 — 사람이 손으로 만들던 집계 테이블이 선언에서 생성된다.**
지표 하나를 추가하는 비용이 선언 한 항목으로 고정된다.
기간 7종과 비교 4종은 따라온다. SQL 파일은 늘지 않는다.

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
| `additive` 축별 선언 | 비가산 축을 `SUM`으로 걷는 것 (활성 사용자 5일 누적에서 17.4% 부풀었다) |
| join graph (`dims`) | 선언되지 않은 차원 조합 — chasm trap |
| surrogate key 강제 | 자연키 조인의 조용한 fan-out |
| `uniqueKey` assertion | dimension PK가 깨져 합계가 부푸는 것 |
| 비율 컬럼 미저장 | 차원을 걷은 뒤 비율을 다시 더하거나 평균 내는 것 |
| 컴파일 타임 검증 | 선언 누락이 런타임 오답으로 나타나는 것 |

### 하지 못하는 것

**런타임에 요청을 받아 SQL을 조립하지 않는다.** 선언한 지표 × 선언한 차원 ×
7개 기간 안에서만 움직인다. 그 밖의 임의 조합은 서빙 계층의 몫이며,
서빙 계층은 여기서 만든 선언을 입력으로 받으므로 순서를 건너뛸 수 없다.

선언하지 않은 차원은 나중에 걷어낼 수 없다. `daily_`가 이미 집계된 결과라
없는 차원은 복원되지 않는다. 차원은 넉넉히 선언한다.

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
| `dbt_dev_marts_reporting` | dbt-airflow | 대조 후 폐기 대상 |

```
dbt_dev_marts_core          DW. 소유하지 않음
    │
    │  ◄── 계약 경계. 여기부터 이 레포의 책임
    ▼
semantic_mart               grain 선언 + 차원 정의 + 키 정규화
    │                       sem_dim_products / sem_dim_users / sem_dim_date
    │                       sem_fct_order_items / sem_fct_orders
    │                       sem_fct_sessions / sem_fct_user_events
    ▼
semantic.daily_<metric>     충분통계량. 스케치는 스케치로 보관
    │
    ▼
semantic.metric_<metric>    서빙 표면. 기간 확장 + 비교 기준값
semantic_metadata.metric_registry
```

---

## 2. 중간 마트 (`semantic_mart`)

DW와 구조가 동일하더라도 **반드시 정의하고 물리 테이블로 만든다.**

### 왜 두는가

1. **차원 로직의 자리** — 파생 차원을 집계 SQL의 `CASE WHEN`으로 만들면
   그 정의가 지표 수만큼 복제된다. semantic layer가 없애려던 문제를 그대로 재현한다.
2. **assertion의 자리** — declaration에는 `config{}`가 없어 `uniqueKey`를 걸 수 없다.
   물리 테이블이어야 fan trap 방어 장치가 제자리에 온다.
3. **키 정규화** — 자연키를 아예 제거해서 잘못된 조인을 구조적으로 불가능하게 만든다.
4. **상류 변경 흡수** — DW 컬럼명이 바뀌어도 충격을 한 곳에서 받는다.

### 허용

- 컬럼 이름 변경 (`category_name` → `category`)
- 컬럼 제거 (자연키, 미사용 컬럼)
- **차원 속성 파생** (버킷, 등급, 플래그)
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

### 차원

**P4. 차원 로직은 차원 안에 산다.**
집계 SQL 안에서 버킷을 만들지 않는다. 파생 차원은 `semantic_mart`의 `sem_dim_*`에서 만든다.

**P5. 차원은 fact에 붙이지 않는다. 조인은 `daily_` 생성 시 딱 한 번 실행한다.**

`semantic_mart`는 star schema를 유지한다 — dim과 fact를 분리한다.
조인 관계는 `entities.js`의 `dims`에 선언하고, 생성기가 그 선언을 읽어
`daily_<metric>`을 만들 때 조인을 실행한다.

```
sem_fct_order_items  ─┐
sem_dim_products     ─┼─→  daily_<metric>  ─→  metric_<metric>
sem_dim_users        ─┘    (차원이 컬럼으로      (조인 없음)
                            물화된 상태)
```

**`daily_`는 이미 비정규화된 결과물이다.** 차원이 평범한 컬럼으로 들어가 있어서
그 위의 모든 집계는 조인이 필요 없다. 조인 비용은 지표당 하루 한 번이지
조회할 때마다가 아니다.

fact에 차원을 미리 붙이지 않는 이유는 셋이다.

1. **차원 추가가 fact 재생성을 부른다.** 선언 한 줄이어야 할 일이 대형 테이블 재빌드가 된다
2. **역할 차원을 표현할 수 없다.** 같은 dim을 두 키로 참조하는 경우(주문일/배송일) 평탄화가 깨진다
3. **차원 변경 시점이 fact에 고정된다.** point-in-time을 나중에 도입할 여지가 사라진다

**P6. join graph에 선언하지 않은 차원은 쓸 수 없다.**
가능한 조합을 이어주는 것보다 **불가능한 조합을 막는 쪽**이 중요하다. chasm trap 예방.

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
1. **entity를 옮긴다** — `order_count`는 `sem_fct_orders`(주문 1건 = 1행)로 옮기면
   `COUNT(*)`가 되고 카테고리축 자체가 사라진다
2. **못 옮기면 스케치로** — `buyer_count` by category
3. **스케치도 안 되면**(중앙값, 분위수) daily만 만들고 롤업을 거부한다

**P11. `daily_`와 `metric_`은 둘 다 재집계 가능한 형태로 저장한다.**

확정(스케치 → 정수, 분자 ÷ 분모)은 저장 시점이 아니라 **소비 시점**에 한다.
확정된 값은 더 이상 접을 수 없으므로, 물리 테이블에 확정값을 넣으면
차원을 걷는 순간 쓸 수 없게 된다.

| measure 유형 | 두 테이블 모두 저장하는 것 | 소비 시점 |
|---|---|---|
| 합계·건수 | 값 | 그대로 |
| distinct 수 | **HLL 스케치(BYTES)** | `HLL_COUNT.EXTRACT` |
| 평균·비율 | **저장하지 않는다** | 분자 ÷ 분모 (P12) |

두 테이블을 나누는 이유는 확정 시점이 아니라 역할이다.

| | 역할 |
|---|---|
| `daily_<metric>` | **조인이 실행되는 유일한 곳.** 날짜 × 차원 집계. 모든 기간의 재료 |
| `metric_<metric>` | `daily_`를 7개 기간으로 확장하고 비교 기준값을 붙인다 |

분리해 두면 `metric_`을 다시 만들 때 원자 fact와 dimension을 다시 읽지 않는다.

**P12. 비율은 어느 테이블에도 저장하지 않는다. 증감률도 비율이다.**
일별 비율의 평균은 기간 비율이 아니다. 분자와 분모를 **각각 독립된 지표로 선언**하고,
비율은 registry에 `type: "ratio"` + 분자·분모 지표명으로만 등록한다. 나눗셈은 소비 시점에 한다.

같은 이유로 `yoy` · `mom` 같은 **증감률 컬럼을 저장하지 않는다.** 차원을 하나라도
걷어내는 순간 저장된 증감률은 더하지도 평균 내지도 못한다.

```
category 를 걷어내고 국가별로만 볼 때 (2026-01 · China)
  저장된 yoy 를 AVG   0.9969   ✕
  저장된 yoy 를 SUM  24.9235   ✕
  yoy_base 로 재계산   0.9140   ✓
```

> **비율은 분자·분모의 차원 교집합에서만 유효하다.**
> `aov = net_revenue / order_count`인데 `net_revenue`는 `order_item` entity라 `category`가 있고
> `order_count`는 `order` entity라 없다. 따라서 **카테고리별 AOV는 정의가 성립하지 않는다.**
> 카테고리별 주문 수가 비가산이기 때문이며(P9), 이것은 도구의 한계가 아니라 사실이다.

### 시간

**P13. 기간 테이블은 `period_start`와 `as_of_date`를 함께 갖는다.**
rollup과 cumulative에서 "기간"의 뜻이 다르기 때문이다.

| period_type | period_start | as_of_date |
|---|---|---|
| `daily` | 그날 | 그날 |
| `weekly` | 주 시작일 | 주 종료일 |
| `mtd` | 월 시작일 | 기준일 |

이 두 컬럼이 비교 조인을 하나의 규칙으로 통일한다 —
rollup은 `period_start`, cumulative는 `as_of_date`를 shift 한다.

**P14. 비교는 기준값(`_base`)만 저장한다. 날짜 조인으로 만들고 `LAG`를 쓰지 않는다.**

`_base`는 집계가 아니라 조회다 — 같은 테이블에서 시프트한 행의 값을 복사한다.
원래 값이 가산이면 `_base`도 가산이므로 차원을 걷어도 살아남는다.

```sql
LEFT JOIN metric_x AS b
  ON  b.period_type  = c.period_type            -- 같은 기간 종류끼리
  AND b.period_start = DATE_SUB(c.period_start, INTERVAL 1 YEAR)   -- rollup
  AND <모든 차원 NULL-safe 비교>
→ b.value AS yoy_base
```

- rollup은 `period_start`, cumulative는 `as_of_date`를 시프트한다 (P13)
- `LEFT JOIN`이어야 한다. `INNER`면 기준 기간이 없을 때 현재 행까지 사라진다
- `LAG`는 거래 없는 기간의 행이 비어 있으면 다른 시점을 가리킨다

**P15. cumulative는 모든 날짜를 물화한다.**
"작년 같은 날 MTD"가 필요하므로 특정 기준일만 만들면 YoY가 불가능해진다.

**P16. 나눗셈은 전부 `SAFE_DIVIDE`.**

### 생성

**P17. 기계적인 것은 생성한다.**
사람이 쓰는 SQL은 생성기가 표현할 수 없는 것에 한한다.
그런 지표도 registry에는 등록한다 — "생성되지 않았다"와 "존재하지 않는다"는 다르다.

**P18. 생성기는 틀린 결과를 내느니 거부한다.**
`additive: false` 조합은 빈 테이블을 만들지 않고 건너뛴다.
빈 테이블이 남으면 소비자가 "값이 0"으로 오해한다.

**P19. 이름 규칙은 한 파일에만 둔다.**
어긋나면 `dataform compile`이 실패해야 한다. 런타임이 아니라 컴파일 타임에 잡는다.

### 상류 계약

**P20. DW 소스에 건 assertion은 게이트가 아니라 감시다.**
깨져도 우리가 고칠 수 없다. dbt에 보고하고, 여기서 덮지 않는다.

**P21. 알려진 상류 결함은 우회하지 말고 기록한다.**
조용한 우회는 문제를 숨긴다. 5장에 적고 assertion으로 감시한다.

---

## 4. 확정된 결정

| 항목 | 결정 |
|---|---|
| SSOT | semantic layer. `rpt_*`는 대조 후 폐기 |
| `dim_date` | semantic layer가 소유. 변환이 아니라 축이다 |
| 파생 차원 | `semantic_mart`의 `dim_*`에서 생성 |
| 비율 지표 | registry에 선언만. 테이블 생성 안 함 |
| HLL precision | **15 고정.** 나중에 바꾸면 과거 스케치와 병합 불가 |
| 지표당 테이블 | **2개** — `daily_<metric>` + `metric_<metric>`. 둘 다 물리 테이블 |
| 기간 | `daily` `weekly` `monthly` `yearly` `wtd` `mtd` `ytd` |
| 비교 | `dod_base` `wow_base` `mom_base` `yoy_base` — 증감률은 저장하지 않음 |
| SCD | 당분간 현재 상태만 사용. 이력 커버리지 4.46% |

`metric_<metric>`은 `period_type` 판별 컬럼으로 모든 기간을 담고 `daily`도 포함한다.
두 테이블 모두 재집계 가능한 형태로 저장하며(P11), 차이는 저장 형식이 아니라
역할이다 — `daily_`는 조인이 실행되는 곳, `metric_`은 기간 확장과 비교.

---

## 5. 알려진 상류 결함

우회하지 않고 assertion으로 감시한다. 원인은 dbt-airflow 쪽에 있다.

| # | 현상 | 규모 | 영향 |
|---|---|---|---|
| 1 | 자연키 재사용 | `order_id` 4,038행 / `order_item_id` 5,161행 중복 | P2로 대응 |
| 2 | `fct_order_items.order_key` NULL | 1,673행 (2026-08-19~26) | `COUNT(DISTINCT order_key)`가 최근 구간 과소집계 |
| 3 | line item 없는 주문 | 477건 (2026-08-17~24) | 두 fact 정합 불일치 |
| 4 | `fct_orders` 적재 지연 | order_items는 08-26, orders는 08-24까지 | 주문 grain 지표가 최근 이틀 결측 |
| 5 | SCD 이력 부족 | `valid_from` 최솟값 2026-08-15, fact는 2019-01-13부터 | point-in-time 매칭률 4.46% |
| 6 | `dim_date` 부재 | — | semantic layer가 생성 |
| 7 | `fct_sessions` 퍼널 플래그 모순 | `purchased`인데 `viewed_product`가 아닌 세션 72,045건. 세션 구매율 77.1% | **퍼널 전환 지표를 이 플래그로 만들 수 없다** |

2~4번은 모두 최근 구간에 몰려 있어 late-arriving 문제로 보인다.

7번은 성격이 다르다. 전자상거래 세션 구매율은 통상 1~3%인데 77.1%가 나온다.
`purchased`가 이름대로 동작하지 않는다는 뜻이므로 **원인이 밝혀지기 전까지
세션 퍼널 지표를 정의하지 않는다.**
