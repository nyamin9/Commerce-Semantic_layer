# 아키텍처

이 레포가 왜 이 모양인지. 용어는 [glossary.md](glossary.md) 를 따른다.

## 1. 무엇이 비어 있었나

DW 는 dbt-airflow 가 만든다. `fct_order_items` · `fct_orders` · `fct_sessions` ·
`fct_user_events` 와 그에 붙는 dimension 이 이미 있다. 그런데 **지표의 정의가
어디에도 없다.**

`net_revenue` 가 무엇인지 알려면 `rpt_daily_revenue` 의 SQL 을 읽어야 하고, 같은
질문을 부서별로 보려면 그 SQL 을 복사해 `GROUP BY` 를 고쳐야 한다. 고친 쪽과 원본이
어긋나도 에러가 나지 않는다 — 숫자만 달라진다.

이 레포가 채우는 것은 그 자리다.

| | |
|---|---|
| 지표 정의 | `includes/metrics.js` 한 곳. 15개 지표가 여기서만 정의된다 |
| 집계 테이블 | 선언에서 생성된다. 사람이 쓰는 집계 SQL 은 0개다 |
| 틀린 집계 | `additive` · join graph · assertion 이 막는다 |

**하지 못하는 것도 분명하다.** Dataform 은 컴파일 타임 도구라 런타임에 요청을 받아
SQL 을 조립하지 않는다. 선언한 지표 × 선언한 dimension 안에서만 움직인다.

## 2. 테이블 3단계

지표 하나가 테이블 3개가 된다. 15개 지표 × 3 = 45개다.

```
sem_fct_*  +  sem_dim_*
      │
      │  조인 실행 (여기 한 번뿐)
      ▼
daily_<metric>     record_date × dims 전체            200,206행
      │
      │  serving_dims 로 좁히고 · grid 채우고 · PTD 계산하고 · rollup
      ▼
period_<metric>    record_date × serving_dims       4,804,604행
      │
      │  record_date 를 시프트한 self-join 5번
      ▼
metric_<metric>    + 비교 기준값 8컬럼              4,804,604행
```

각 단계가 무엇을 사고 무엇을 포기하는지가 설계의 전부다.

| | 산다 | 포기한다 |
|---|---|---|
| `daily_` | dimension 을 전부 갖는다. 조인이 한 번만 돈다 | 여기엔 PTD 도 비교도 없다 |
| `period_` | PTD 와 rollup 행이 생긴다 | `serving_dims` 밖의 dimension |
| `metric_` | 비교 기준값이 붙는다. 소비자는 이것만 읽으면 된다 | 없음 — `period_` 의 모든 컬럼을 그대로 갖는다 |

**단계가 개념을 나눠 갖지 않고 쌓인다.** `period_` 는 PTD 만 갖는 것이 아니라 `daily`
값도 들고 있고, `metric_` 은 앞의 것을 전부 포함한 뒤 비교만 얹는다. 그래서 소비자는
`metric_` 하나만 본다.

### 왜 셋으로 나누나

세 단계를 한 쿼리에 넣으면 같은 집계가 여러 번 돈다. CTE 는 결과를 저장하지 않기
때문이다.

> 2026-09-13 실측. `metric_` 이 기간 확장 CTE 를 다섯 번 참조해(본 쿼리 1 + 비교 조인 4)
> 같은 집계가 다섯 번 돌았다. dimension 7개 지표에서 CPU 3,600초를 써 BigQuery
> on-demand 의 CPU/바이트 비율 제한에 걸렸다. 스캔은 14 MB 라 비용이 아니라 낭비가
> 문제였다. 조인 술어를 바꿔도 변하지 않았고, 테이블로 저장하니 통과했다.

`daily_` 를 따로 두는 이유는 다르다. **조인을 한 번만 실행하기 위해서**다. `period_`
이후는 `daily_` 만 읽으므로 atomic fact 와 dimension 을 다시 읽지 않는다.

## 3. 핵심 결정 여섯 가지

### 3-1. 기간은 행이 아니라 컬럼이다

한 행이 그 `record_date` 의 모든 것이다.

```
record_date  country  is_month_end   net_revenue  _wtd    _mtd     _ytd
2026-08-31   China    TRUE              14,815   14,815  260,673  918,314
```

**`weekly` · `monthly` · `yearly` 를 만들지 않는다.** 완결된 기간의 집계는 같은
dimension 에서 PTD 와 값이 같기 때문이다.

> 실측. 완결된 주의 `weekly` 값과 그 주 마지막 날의 `wtd` 값을 맞대면 10,080 조합
> 전부 일치했다 (2026-09-16).

```
monthly  =  mtd  where is_month_end
```

행으로 두면 값이 중복되면서 **진행 중인 기간이 미래 날짜를 달게 된다.** 직전 구조에서
데이터가 9/17까지인데 진행 중인 주의 `weekly` 행이 아직 오지 않은 9/20을 달고 있었고,
그 행의 비교 기준값이 4일치를 지난주 7일 전체와 맞댔다. PTD 에는 그 문제가 없다 —
`record_date` 는 항상 실제로 지난 날이다.

### 3-2. dimension 을 두 단계로 나눠 갖는다

```
daily_    dims 전체        order_item 기준 7개
period_   serving_dims     4개 + 각 dimension 의 '(all)' rollup 행
```

`period_` 가 `dims` 전부를 쓰지 못하는 이유는 3-3 의 `grid` 때문이다. 행 수가
(조합 수 × 날짜 수)로만 정해지므로 조합이 늘면 그대로 곱해진다.

```
dims 7개 전부      조합 27,749 × 2,811일 = 7,800만 행
serving_dims 4개   조합    720 × 2,811일 =  202만 행   → rollup 행까지 480만
```

`'(all)'` rollup 행을 미리 만들어 두는 것이 이 결정의 짝이다. 소비자가 직접 rollup 할
필요가 없어지고, 특히 sketch 지표에서 `SUM` 이 아니라 `HLL_COUNT.MERGE` 를 써야 한다는
지식이 필요 없어진다.

### 3-3. `grid` 로 빈 날을 채운다

PTD 를 활동이 있는 날에만 만들면 rollup 했을 때 대부분이 사라진다.

> 실측. 빈 날을 채우지 않은 `mtd` 로 "2026-08-14 기준 country 별 MTD" 를 내면 전사
> 합계가 25,618 인데 실제는 192,871 이다 — **13%만 나온다.** 8/14에 안 팔린 조합의
> 8/1~8/13 매출이 통째로 빠지기 때문이다.

그래서 `base` 의 dimension 조합과 `sem_dim_date` 의 날짜를 모두 교차시켜 행을 만들고,
값이 없으면 0(가산) 또는 `NULL`(sketch)로 채운 뒤 그 위에 누적한다.

날짜는 `sem_dim_date` 에서 가져온다. `daily_` 의 날짜를 쓰면 전사적으로 거래가 0인 날이
통째로 빠져 PTD 가 끊긴다 — 실측으로 2,811일 중 44일이 그랬다.

범위는 `daily_` 가 가진 구간으로 자른다. 그러지 않으면 2018~2031 날짜 전체가 조합 수만큼
곱해지고, 데이터가 없는 미래 날짜에 행이 생긴다.

### 3-4. rollup 보다 PTD 를 먼저 계산한다

순서를 바꿔도 값은 같다. `SUM` 은 결합법칙이 성립하고, HLL 병합은 합집합이라 조합별
`wtd` sketch 를 합친 것이 전체 `wtd` sketch 와 같다.

**비용은 전혀 다르다.** rollup 을 먼저 하면 `'(all)'` 행의 sketch 가 조밀해지는데, sketch
PTD 는 1년 구간을 self-join 해서 병합하므로 그 조밀한 sketch 를 하루당 180여 번씩 읽는다.

```
rollup 먼저   CPU 1,748,227초   한도 5,100 초과
PTD 먼저      통과
```

### 3-5. 비교는 기준값만 저장한다

`yoy` 같은 증감률을 컬럼으로 저장하지 않는다. 비율은 rollup 하면 깨지기 때문이다.
`AVG` 도 `SUM` 도 틀린 값을 낸다. 대신 시프트한 시점의 **값**을 복사해 둔다.

```
net_revenue_mtd   768,676      mtd_yoy_base   94,971
→ 증감률은 소비 시점에 SAFE_DIVIDE(v - base, base)
```

비교 컬럼은 8개인데 서로 다른 시프트 간격은 5개뿐이라(`1 DAY`·`1 WEEK`·`1 MONTH`·
`1 YEAR`·`364 DAY`) self-join 도 5번이다.

**주간 비교만 364일이다.** `1 YEAR` 로 시프트하면 요일이 어긋난다 — 2026-03-02(월)의
1년 전은 일요일이다.

### 3-6. 증분은 `MERGE` 가 아니라 구간을 지우고 다시 넣는다

`MERGE` 는 지우지 않는다. dimension 값이 바뀌면 `(record_date, dimension)` 키가 달라져
옛 행이 매칭되지 않고 그대로 남는다. `uniqueKey` assertion 도 못 잡는다. 키는 여전히
유일하기 때문이다.

> 2026-09-13 실측. 마트를 12일치 최신화하고 증분을 돌렸더니 남은 옛 행 3,933개가
> `net_revenue` 를 188,992.92 부풀렸다.

## 4. sketch 지표는 구조가 같고 함수만 다르다

`buyer_count` · `visitor_count` · `active_user` 는 distinct count 라 합산할 수 없다.
HLL sketch 로 저장해서 병합 가능한 상태를 유지한다.

**컬럼 구성은 가산 지표와 완전히 같다.** 타입만 `NUMERIC` 대신 `BYTES` 다.

| | 가산 지표 | sketch 지표 |
|---|---|---|
| rollup | `SUM` | `HLL_COUNT.MERGE_PARTIAL` |
| PTD | 창 함수 | 구간 self-join 후 병합 |
| 조회 | 그대로 | `HLL_COUNT.EXTRACT` 를 한 번 더 |

PTD 에 창 함수를 못 쓰는 이유가 하나 있다. **`HLL_COUNT.MERGE_PARTIAL` 은 analytic
function 을 지원하지 않는다.** dry run 은 통과하고 실행에서 떨어진다 — 컴파일로도
dry run 으로도 못 잡는다.

정확도는 실측으로 확인했다.

```
2026-08 전사 MTD 구매자   sketch 10,264 / atomic fact 직접 계산 10,267   오차 0.029%
'(all)' 행                sketch 10,264 / country 별 행을 MERGE 10,264   일치
```

## 5. 실측 수치 모음

구조를 바꿀 때 근거가 된 숫자들이다.

| 항목 | 값 | 무엇의 근거인가 |
|---|---|---|
| `daily_` 행 수 ÷ atomic fact 행 수 | 98.68% (200,206 / 202,877) | 사전 집계는 성능 이득이 거의 없다. 이득은 정의 표준화 쪽이다 |
| 빈 날 안 채운 `mtd` rollup | 실제의 13% | `grid` (3-3) |
| 완결 주 `weekly` vs `wtd` | 10,080 조합 일치 | `weekly` 를 안 만든다 (3-1) |
| `brand`(2,753값)를 dimension 에 넣었을 때 | 연 단위 집계가 5%만 줄어듦 | 고유값이 많은 컬럼은 dimension 이 될 수 없다 |
| CTE 다섯 번 참조 | CPU 3,600초 / 한도 4,300 | 3단계 분리 (2절) |
| rollup 먼저 + sketch | CPU 1,748,227초 | PTD 를 먼저 (3-4) |
| `GROUPING SETS` 16집합 | CPU 357,307초 | `axis_mask` CROSS JOIN 으로 교체 |
| `IS NOT DISTINCT FROM` 조인 | CPU 88,022초 | `'(unknown)'` bucket + `=` 조인 |
| 증분에 `MERGE` | 남은 옛 행 3,933개 | insert_overwrite (3-6) |
| 전체 파이프라인 | 4분 · 액션 159건 | 현재 상태 |

## 6. 검증 결과

2026-09-16 전체 재생성 후 실측이다.

| 검증 | 대상 | 불일치 |
|---|---|---|
| `daily` 컬럼이 `daily_` 를 `serving_dims` 로 집계한 값과 같은가 | 1,635 | **0** |
| `'(all)'` 행이 각 dimension 값의 합과 같은가 | 260 | **0** |
| 월말 `mtd` 가 `daily_` 의 그 달 합과 같은가 | 92 | **0** |
| 비교 기준값이 시프트한 날짜의 값을 가리키는가 | 81,984 | **0** |
| `record_date` 가 `daily_` 의 최대값을 넘지 않는가 | 4,801,188 | **0** |

---

**다음으로 읽을 것**

| | |
|---|---|
| 파일별 역할 | [code-map.md](code-map.md) |
| 판단 기준 P1~P22 | [principles.md](principles.md) |
| 지표 정의 | [metrics.md](metrics.md) |
| 다른 프로젝트로 옮기기 | [porting.md](porting.md) |
