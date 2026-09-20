# 아키텍처

- 이 레포가 왜 이 모양인지
- 용어는 [glossary.md](glossary.md) 를 따름

## 1. 무엇이 비어 있었나

- DW 는 dbt-airflow 가 만듦
- `fct_order_items` · `fct_orders` · `fct_sessions` · `fct_user_events` 와 그에 붙는
  dimension 이 이미 있음
- 그런데 **지표의 정의가 어디에도 없음.**

- `net_revenue` 가 무엇인지 알려면 `rpt_daily_revenue` 의 SQL 을 읽어야 하고, 같은 질문을 부서별로 보려면
  그 SQL 을 복사해 `GROUP BY` 를 고쳐야 함
- 고친 쪽과 원본이 어긋나도 에러가 나지 않음 — 숫자만 달라짐

- 이 레포가 채우는 것은 그 자리임

| | |
|---|---|
| 지표 정의 | `includes/metrics.js` 한 곳. 지표 17개가 여기서만 정의됨 |
| 집계 테이블 | 선언에서 생성됨. 사람이 쓰는 집계 SQL 은 0개임 |
| 틀린 집계 | `additive` · join graph · assertion 이 막음 |

- **하지 못하는 것도 분명함.** Dataform 은 컴파일 타임 도구라 런타임에 요청을 받아 SQL 을 조립하지 않음
- 선언한 지표 × 선언한 dimension 안에서만 움직임

## 2. 기성 semantic layer 와 무엇이 다른가

- Looker · Cube · dbt MetricFlow 와 비교하면 **다른 지점은 하나뿐임.**

### 2-1. 같은 것

| | |
|---|---|
| 선언한 dimension 만 쓸 수 있음 | 기성 도구도 같음. view · cube · semantic model 에 없으면 못 씀 |
| 표준화된 지표를 서빙함 | semantic layer 의 정의 그 자체 |
| 사전 집계를 만듦 | Cube `pre-aggregations` · Looker aggregate awareness 전부 함 |
| rollup 과 직접 `GROUP BY` | 가산 지표면 결과가 같음. 덧셈의 결합법칙 |
| entity · dimension · metric 분리 선언 | 같음 |
| grain 선언 · 가산성 분류 · conformed dimension | Kimball, 1996 |

### 2-2. 다른 것 — fallback 경로가 없음

```
기성 도구   선언 → 런타임이 판단 → 사전 집계로 답할 수 있으면 거기서
                               → 없으면 atomic fact 로 fallback
이 레포     선언 → 컴파일 타임에 테이블 생성 → 그 테이블이 답할 수 있는 것만
```

**fallback 이 넓히는 것은 "무엇을 물어볼 수 있나" 가 아니라 "어느 테이블에서 답이 나오나" 임.**

```
선언된 dimension   category · brand · country · retail_price
사전 집계          record_date × category × country 로만

"brand 별 매출"          → 사전 집계에 brand 없음 → atomic fact 로 fallback → 답함
"retail_price > 100"     → retail_price 는 선언됨  → atomic fact 로 fallback → 답함
"product_name 에 blue"   → 선언 안 됨              → 기성 도구도 거부
```

- 핵심은 **선언된 dimension 을 조건으로 쓸 수 있느냐**임

- **기성 도구** — 선언된 dimension 이면 `GROUP BY` 에 없어도 필터로 쓸 수 있음.
  atomic fact 로 fallback 하면 되기 때문
- **이 레포** — `GROUP BY` 에 넣은 dimension 으로만 거를 수 있음
- 그래서 고유값이 많은 컬럼(`retail_price` 4,212개 · `product_name` 27,309개)은
  dimension 이 될 수 없고 `price_tier` 같은 **bucket 으로 만들어야** 함

- Dataform 이 컴파일 타임 도구라 런타임 조립이 구조적으로 불가능하기 때문임
- 기능이 모자라서가 아니라 도구가 맡는 범위가 달라서이고, dbt Core 도 같은 이유로 못 함

### 2-3. 서빙 레이어가 생기면

- `semantic_mart` 와 선언은 그대로 두고 그 위에 Cube 를 올리는 것이 표준 경로임
- `entities.js` 와 `metrics.js` 가 Cube 의 `cubes`·`dimensions`·`measures` 와 거의
  1:1 로 대응함

- 그때 `daily_*` · `metric_*` 은 **없어지는 것이 아니라 캐시가 됨.** 코드는 고치지 않음

## 3. 이 구조가 얻는 것

- 효율은 **쿼리 속도가 아니라 변경 비용**에서 옴

| | 값 |
|---|---|
| `daily_` 행 수 ÷ atomic fact 행 수 | 98.63% (204,238 / 207,078) — 거의 줄지 않음 |
| atomic fact 전 기간 + dimension 조인 + 임의 필터 | 8.5 MB |

- 이 규모에서 사전 집계는 성능 이득이 거의 없음
- 이득은 아래에 있음

```
지표 17 × 기간 컬럼 4 × 비교 컬럼 8

손으로 만들면    지표당 모델 5개 × 17 = 85개 SQL 파일 + 비교 로직 반복
선언으로 만들면  metrics.js 17항목 + 고정 파일 5개
```

- 기간 하나 추가 → `periods.js` 한 항목 → 17개 지표에 전부 적용
- 지표 하나 추가 → `metrics.js` 한 항목 → 기간 컬럼 4 · 비교 컬럼 8 · `'(all)'` 행 자동

- 실제 사례가 `wtd` 의 전년 비교를 364일로 고친 것임

- 한 줄로 전 지표의 주 단위 비교가 전부 맞아졌음
- 손으로 만들었다면 지표 수만큼 고쳐야 했고, 하나는 빠뜨렸을 것임

## 4. 어디까지 답하는가

- 어떤 구조로도 임의 요청을 전부 처리할 수는 없음
- 서빙 레이어가 있어도 마찬가지임
- **어디까지 책임지고 어디부터 놓을지**를 정하는 문제가 됨

| 층 | 답할 수 있는 것 | 지표 정의 보장 |
|---|---|---|
| `metric_` 조회 | 선언한 dimension 조합 | 보장 |
| 서빙 레이어 (없음) | 선언한 dimension 의 임의 조합 · 필터 | 보장 |
| **`semantic_mart` 직접 SQL** | **임의 필터 · 조인 · 표현식** | 보장 안 됨 |
| DW · raw 직접 | 무엇이든 | 보장 안 됨 |

- 세 번째 줄이 선언으로 표현할 수 없는 질문을 처리하는 길임
- `semantic_mart` 를 따로 만들어 둔 이유가 여기서 드러남 — 자유롭게 SQL 을 써도 다음 둘이 보장됨

- 자연키가 없어 **잘못된 조인이 불가능함**
- dimension PK 유일성이 assertion 으로 보장되어 **fan-out 이 생기지 않음**

- **지표를 틀린 수식으로 계산하는 것은 막지 못하지만, 조인 때문에 숫자가 부푸는 것은 구조적으로 막힘.**

| 상황 | 처리 |
|---|---|
| 한 번뿐인 질문 | 마트에 직접 SQL. 지표로 만들지 않음 |
| 같은 필터가 반복 | dimension 으로 만듦 |
| 같은 지표가 반복 | `metrics.js` 에 선언 추가 |
| 선언으로 표현 불가 | 별도 모델 + registry 에 등록 |

- 첫 줄이 핵심임
- **같은 것을 세 번 물어보면 그때 지표이거나 dimension 임.**

## 5. 테이블 3단계

- 지표 하나가 테이블 3개가 됨
- 17개 지표 × 3 = 51개임

```
sem_fct_*  +  sem_dim_*
      │
      │  조인 실행 (여기 한 번뿐)
      ▼
daily_<metric>     record_date × dims 전체              204,238행
      │
      │  serving_dims 로 좁히고 · grid 채우고 · PTD 계산하고 · rollup
      ▼
period_<metric>    record_date × serving_dims       14,260,224행
      │
      │  record_date 를 shift 한 self-join 5번
      ▼
metric_<metric>    + 비교 기준값 8컬럼              14,260,224행
```

- 각 단계가 무엇을 얻고 무엇을 포기하는지가 설계의 전부임

| | 얻는 것 | 포기하는 것 |
|---|---|---|
| `daily_` | dimension 을 전부 가짐. 조인이 한 번만 돎 | 여기엔 PTD 도 비교도 없음 |
| `period_` | PTD 와 rollup 행이 생김 | `serving_dims` 밖의 dimension |
| `metric_` | 비교 기준값이 붙음. 소비자는 이것만 읽으면 됨 | 없음 — `period_` 의 모든 컬럼을 그대로 가짐 |

- **단계가 개념을 나눠 갖지 않고 쌓임.** `period_` 는 PTD 만 갖는 것이 아니라 `daily` 값도 들고 있고,
  `metric_` 은 앞의 것을 전부 포함한 뒤 비교만 얹음
- 그래서 소비자는 `metric_` 하나만 봄

### 5-1. 왜 셋으로 나누나

- 세 단계를 한 쿼리에 넣으면 같은 집계가 여러 번 돎
- CTE 는 결과를 저장하지 않기 때문임

- CTE 는 참조 횟수만큼 다시 계산됨
- 기간 확장을 `metric_` 안의 CTE 로 두면 본 쿼리와 비교 조인이 각각 그것을 돌려서 CPU/바이트 비율 제한에 걸림
  ([findings.md](findings.md) 3)

- `daily_` 를 따로 두는 이유는 다름
- **조인을 한 번만 실행하기 위해서**임
- `period_` 이후는 `daily_` 만 읽으므로 atomic fact 와 dimension 을 다시 읽지 않음

## 6. 핵심 결정 여섯 가지

### 6-1. 기간은 행이 아니라 컬럼임

- 한 행이 그 `record_date` 의 모든 것임

```
record_date  country  is_month_end   net_revenue  _wtd    _mtd     _ytd
2026-08-31   China    TRUE              14,815   14,815  260,673  918,314
```

- **`weekly` · `monthly` · `yearly` 를 만들지 않음.** 완결된 기간의 집계는 같은 dimension 에서 PTD
  와 값이 같기 때문임

- 완결된 주의 `weekly` 값과 그 주 마지막 날의 `wtd` 값이 10,080 조합 전부 일치함
  ([findings.md](findings.md) 13)

```
monthly  =  mtd  where is_month_end
```

- 행으로 두면 값이 중복될 뿐 아니라 **진행 중인 기간의 날짜가 미래가 됨.** 완결 기간의 집계는 날짜가 기간의
  마지막 날이어야 하는데, 그 날이 아직 오지 않았기 때문임
- 데이터가 9/17까지일 때 그 주의 행은 날짜가 9/20 이면서 4일치만 담음
- 비교 기준값도 그 4일치를 지난주 7일 전체와 비교함

- PTD 에는 그 문제가 없음
- `record_date` 는 항상 실제로 지난 날임

### 6-2. dimension 을 두 단계로 나눠 가짐

```
daily_    dims 전체        order_item 기준 8개
period_   serving_dims     5개 + 각 dimension 의 '(all)' rollup 행
```

- `period_` 가 `dims` 전부를 쓰지 못하는 이유는 6-3 의 `grid` 때문임
- 행 수가 (조합 수 × 날짜 수)로만 정해지므로 조합이 늘면 그대로 곱해짐

```
dims 8개 전부      조합 58,439 × 2,816일 = 1억 6,456만 행
serving_dims 5개   조합  1,409 × 2,816일 =     397만 행
                   rollup 행까지 포함하면 조합 5,064 →  1,426만 행
```

- `'(all)'` rollup 행을 미리 만들어 두는 것이 이 결정에 딸린 선택임
- 소비자가 직접 rollup 할 필요가 없어지고, 특히 sketch 지표에서 `SUM` 이 아니라 `HLL_COUNT.MERGE` 를 써야
  한다는 지식이 필요 없어짐

### 6-3. `grid` 로 빈 날을 채움

- PTD 를 활동이 있는 날에만 만들면 rollup 했을 때 대부분이 사라짐

- 빈 날을 채우지 않으면 country 별 MTD 를 합한 값이 **실제의 13%** 가 나옴
- 그날 팔리지 않은 조합의 앞 구간 매출이 통째로 빠지기 때문임 ([findings.md](findings.md) 4)

- 그래서 `base` 의 dimension 조합과 `sem_dim_date` 의 날짜를 모두 교차시켜 행을 만들고, 값이 없으면 0(가산)
  또는 `NULL`(sketch)로 채운 뒤 그 위에 누적함

- 날짜는 `sem_dim_date` 에서 가져옴
- `daily_` 의 날짜를 쓰면 전사적으로 거래가 0인 날이 통째로 빠져 PTD 가 끊김 ([findings.md](findings.md)
  5)

- 범위는 `daily_` 가 가진 구간으로 자름
- 그러지 않으면 2018~2031 날짜 전체가 조합 수만큼 곱해지고, 데이터가 없는 미래 날짜에 행이 생김

### 6-4. rollup 보다 PTD 를 먼저 계산함

- **값은 순서와 무관함** — `SUM` 은 결합법칙이 성립하고, HLL 병합은 합집합이라
  조합별 `wtd` sketch 를 합친 것이 전체 `wtd` sketch 와 같음
- **비용은 전혀 다름** — rollup 을 먼저 하면 `'(all)'` 행의 sketch 가 조밀해짐.
  sketch PTD 는 1년 구간을 self-join 해서 병합하므로 그 조밀한 sketch 를
  하루당 180여 번씩 읽음
- rollup 을 먼저 하면 CPU 한도에 걸려 **생성 자체가 실패함**
  ([findings.md](findings.md) 6)

### 6-5. 비교는 기준값만 저장함

- `yoy` 같은 증감률을 컬럼으로 저장하지 않음
- 비율은 rollup 하면 깨지기 때문임
- `AVG` 도 `SUM` 도 틀린 값을 냄
- 대신 shift 한 시점의 **값**을 복사해 둠

```
net_revenue_mtd   768,676      mtd_yoy_base   94,971
→ 증감률은 소비 시점에 SAFE_DIVIDE(v - base, base)
```

- 비교 컬럼은 8개인데 서로 다른 shift 간격은 5개뿐이라(`1 DAY`·`1 WEEK`·`1 MONTH`· `1 YEAR`·`364
  DAY`) self-join 도 5번임

- **주간 비교만 364일임.** `1 YEAR` 로 shift 하면 요일이 어긋남 — 2026-03-02(월)의 1년 전은 일요일임

### 6-6. 증분은 `MERGE` 가 아니라 구간을 지우고 다시 넣음

- `MERGE` 는 **지우지 않음** — dimension 값이 바뀌면 `(record_date, dimension)` 키가
  달라져 옛 행이 매칭되지 않고 그대로 남음
- `uniqueKey` assertion 도 **못 잡음** — 키는 여전히 유일하기 때문
- 상류를 여러 날치 최신화하고 증분을 돌리면 남은 옛 행이 합계를 부풀림
  ([findings.md](findings.md) 9)

## 7. sketch 지표는 구조가 같고 함수만 다름

- `buyer_count` · `visitor_count` · `active_user` 는 distinct count 라 합산할 수 없음
- HLL sketch 로 저장해서 병합 가능한 상태를 유지함

- **컬럼 구성은 가산 지표와 완전히 같음.** 타입만 `NUMERIC` 대신 `BYTES` 임

| | 가산 지표 | sketch 지표 |
|---|---|---|
| rollup | `SUM` | `HLL_COUNT.MERGE_PARTIAL` |
| PTD | window function | 구간 self-join 후 병합 |
| 조회 | 그대로 | `HLL_COUNT.EXTRACT` 를 한 번 더 |

- PTD 에 window function 을 못 쓰는 이유가 하나 있음
- **`HLL_COUNT.MERGE_PARTIAL` 은 analytic function 을 지원하지 않음.** dry run 은 통과하고
  실행에서 떨어짐 — 컴파일로도 dry run 으로도 못 잡음

- 정확도는 오차 0.029% 임 ([findings.md](findings.md) 16)

## 8. 더 읽을 것

- 이 문서의 각 결정에는 숫자가 붙어 있음
- 그 숫자와 실패 기록은 [findings.md](findings.md) 에 모았음 — 규칙이 왜 그런지 확인할 때 봄

---

**다음으로 읽을 것**

| | |
|---|---|
| 테이블 구조 | [tables.md](tables.md) |
| 실측과 실패 기록 | [findings.md](findings.md) |
| 파일별 역할 | [code-map.md](code-map.md) |
| 판단 기준 P1~P22 | [principles.md](principles.md) |
| 지표 정의 | [metrics.md](metrics.md) |
| 다른 프로젝트로 옮기기 | [porting.md](porting.md) |
