# 서빙 테이블 구조

작업 중인 변경의 설계 노트다. 구현이 끝나면 `principles.md`·`metrics.md`로 접고 이 파일은 지운다.

## 왜 바꾸는가

프로젝트 목적 중 하나가 이것이었다.

> 모든 지표가 **daily → 누적(WTD/MTD/YTD) → 비교(YoY 등)**로 이어지는
> 동일한 테이블 구조를 갖도록 일관된 스키마 확립

직전 구조는 기간 7종을 `period_type` 으로 **세로로** 쌓았다. `daily`·`wtd`·`mtd`·`ytd`·
`weekly`·`monthly`·`yearly` 가 한 테이블에 행으로 섞여 있었다. 두 가지가 틀렸다.

**1. `weekly`·`monthly`·`yearly` 는 누계와 같은 값이다.** 실측으로 확인했다. 완결 주의
`weekly` 를 conformed 축으로 걷은 값과, `wtd` 중 주말 시점 행을 맞대면 10,080 조합
**전부 일치, 불일치 0** 이었다.

```
weekly (완결)  = wtd  where record_date = LAST_DAY(record_date, WEEK(MONDAY))
monthly        = mtd  where record_date = LAST_DAY(record_date, MONTH)
yearly         = ytd  where record_date = LAST_DAY(record_date, YEAR)
```

**2. 미완결 기간의 rollup 행은 미래를 가리켰다.** 데이터가 9/17까지인데 진행 중인 주의
`weekly` 행이 `as_of_date` 2026-09-20 을 달고 있었다. 값은 9/14~9/17 4일치뿐이다.
비교 기준값이 그래서 틀렸다 — 4일치를 지난주 7일 전체와 맞댔다.

```
weekly  9/14~9/20   v 88,453.22   wow_base    46,174.03   ← 4일 vs 지난주 7일
wtd     9/14~9/17   v 88,453.22   wow_base   186,830.79   ← 4일 vs 지난주 같은 요일까지
```

`wtd` 의 186,830.79 는 지난주 `wtd` 9/10 행의 값과 정확히 일치한다. 누계 쪽이 맞다.

## 무엇으로 바꾸는가 — 기간을 가로로 편다

`period_type` 행을 없애고 기간을 **컬럼**으로 만든다. 한 행이 "그 날짜의 모든 것" 이 된다.

```
record_date  country  age_group  gender  acq     is_week_end is_month_end is_year_end
2026-08-31   China    50s        m       search  FALSE       TRUE         FALSE

  net_revenue            그날 하루
  net_revenue_wtd        주 시작 ~ record_date
  net_revenue_mtd
  net_revenue_ytd
```

`period_start` 가 사라진다. `record_date` 하나로 전부 결정되기 때문이다 —
`wtd` 의 시작은 `DATE_TRUNC(record_date, WEEK(MONDAY))` 다.

`as_of_date` 도 `record_date` 로 바꾼다. 한 행이 누계의 cutoff 이면서 daily 의 날짜라
"기준일" 이라는 이름이 애매해졌다. `daily_` 의 `dt` 도 같은 이름으로 통일한다.

완결 기간은 플래그로 고른다. `record_date` 에서 결정론적으로 나온다.

```sql
record_date = LAST_DAY(record_date, WEEK(MONDAY))  AS is_week_end
record_date = LAST_DAY(record_date, MONTH)         AS is_month_end
record_date = LAST_DAY(record_date, YEAR)          AS is_year_end
```

미래 날짜의 행은 **아예 생기지 않는다.** 격자가 `daily_` 가 가진 구간까지만 뻗기 때문이다.

## 차원은 4축 CUBE 로 통일한다

직전에는 `daily`·`weekly`·`monthly`·`yearly` 가 7차원이고 누계만 conformed 4차원이었다.
한 테이블 안에 grain 이 둘이었던 셈이다. 4차원으로 통일한다.

```
serving_dims   country(15) · age_group(6) · gender(2) · acquisition_channel(5)
빠지는 축      category · department · order_item_status
```

빠진 축은 컬럼 자체가 없어진다. 직전처럼 `'(all)'` 리터럴로 채우지 않는다 — 값이
하나뿐인 컬럼이라 자리만 차지한다. 그 축이 필요하면 `daily_`(전체 차원)에서 걷는다.

### `'(all)'` 을 미리 만들어 둔다

`GROUP BY CUBE` 로 각 축의 롤업 행까지 물화한다. 소비자가 차원을 걷을 필요가 없다.

```
조합         720  →  1,708   (2.37배)
× 날짜     2,811
= 행       4,801,188
```

직전 `period_` 가 6,702,058 행이었다. `'(all)'` 을 전부 넣고도 **28% 줄어든다.**
세로로 쌓던 7종이 가로 컬럼이 되기 때문이다.

다른 entity 는 더 작다.

| entity | serving_dims | 조합 | CUBE |
|---|---|---|---|
| `order_item` · `order` | country · age_group · gender · acquisition_channel | 720 | 1,708 |
| `session` | country · acquisition_channel | 68 | 89 |
| `user_event` | country | 15 | 16 |

### `CUBE` 는 `GROUPING()` 으로 갈라야 한다

`CUBE` 는 롤업한 행의 차원 컬럼을 `NULL` 로 채운다. `IFNULL(country,'(all)')` 로
치환하면 원본의 진짜 `NULL` 까지 `'(all)'` 이 된다.

```
naive    GROUPING()      v
(all)         0          5   ← 상류가 흘린 진짜 NULL
KR            0         10
US            0         20
(all)         1         35   ← 전체 롤업
```

`naive` 로 두면 5가 35에 이미 포함돼 있는데 둘 다 `'(all)'` 이라 **이중 계산**된다.

```sql
IF(GROUPING(country) = 1, '(all)', country) AS country
```

진짜 `NULL` 은 `NULL` 로 남긴다. "값이 없는 버킷"(P6-1)이라는 뜻을 유지하기 위해서다.
그래서 하류 조인은 `IS NOT DISTINCT FROM` 을 쓴다.

지금 conformed 4축에 `NULL` 은 0건이라 당장은 차이가 없다. 상류가 하나 흘리는 순간
조용히 틀리기 때문에 처음부터 이렇게 쓴다.

## daily → period → metric

세 단계의 역할이 바뀌지 않는다. 바뀐 것은 2단계의 출력 모양이다.

```
daily_<metric>    record_date × 전체 차원        원자 집계. 조인이 실행되는 유일한 곳 (P5)
period_<metric>   record_date × 4축 CUBE         daily·wtd·mtd·ytd 가로. 비교 없음
metric_<metric>   = period_ + 비교 기준값 8컬럼   서빙 표면
```

`period_` 를 남기는 이유는 `metric_` 이 자기조인을 5번 하기 때문이다. CTE 로 두면 같은
집계가 다섯 번 돈다 — 실측으로 CPU 3,600초를 써 on-demand 의 CPU/바이트 비율 제한에
걸렸다. 물화하면 한 번만 계산한다.

### 2단계는 세 겹이다

```
1) cube    daily_ 를 CUBE(serving_dims) 로 접는다.        활동한 날짜만
2) grid    sem_dim_date × 조합 을 전부 만들고 값을 붙인다.  없으면 0 / NULL
3) cum     그 위에 누적한다.                              daily 는 그대로 통과
```

**2번이 핵심이다.** 활동한 날에만 누계를 만들면 걷는 순간 대부분이 사라진다 — 실측으로
국가별 MTD 가 실제의 **13%** 였다. 그날 안 팔린 조합의 앞 구간 매출이 통째로 빠지기
때문이다. 행을 만들어 두면 누적값이 앞 구간을 그대로 들고 간다.

날짜 뼈대는 `sem_dim_date` 다. `daily_` 의 날짜를 쓰면 전사적으로 거래가 0인 날이 통째로
빠져 누계의 연속성이 끊긴다 — 실측으로 2,811일 중 **44일**이 그랬다. 빈 날짜를 행으로
만드는 것이 이 차원 테이블의 존재 이유다 (P15-1).

범위는 `daily_` 가 가진 구간으로 자른다. 그러지 않으면 2018~2031 스파인 전체가 조합
수만큼 곱해지고, 미래 날짜 행이 생긴다.

### 3번은 가산 지표와 비가산 지표가 갈린다

**출력 컬럼은 양쪽이 똑같다.** 갈리는 것은 그 컬럼을 만드는 방법뿐이다.

| | `additive.time` | 방법 |
|---|---|---|
| 가산 | `true` | 창 함수 |
| 비가산 | `"sketch"` | 구간 자기조인 후 병합 |

#### 가산 — 창 함수

```sql
SELECT record_date, <dims>,
       v                                                                   AS net_revenue,
       SUM(v) OVER (PARTITION BY <dims>, DATE_TRUNC(record_date, WEEK(MONDAY)) ORDER BY record_date) AS net_revenue_wtd,
       SUM(v) OVER (PARTITION BY <dims>, DATE_TRUNC(record_date, MONTH)       ORDER BY record_date) AS net_revenue_mtd,
       SUM(v) OVER (PARTITION BY <dims>, DATE_TRUNC(record_date, YEAR)        ORDER BY record_date) AS net_revenue_ytd
FROM grid
```

격자를 한 번만 읽고 3종을 동시에 만든다. 기간별로 블록을 나누면 격자가 그만큼
재계산된다.

#### 비가산 — 구간 자기조인

`HLL_COUNT.MERGE_PARTIAL` 은 **analytic function 을 지원하지 않는다.** dry run 은 통과하고
실행에서 `Analytic function MERGE_PARTIAL is not supported` 로 떨어진다. 컴파일로도
dry run 으로도 못 잡는다. 그래서 창 함수를 못 쓰고 구간을 조인해 병합한다.

```sql
SELECT g.record_date, <g.dims>,
       ANY_VALUE(g.v)                                                                          AS buyer_count,
       HLL_COUNT.MERGE_PARTIAL(IF(b.record_date >= DATE_TRUNC(g.record_date, WEEK(MONDAY)), b.v, NULL)) AS buyer_count_wtd,
       HLL_COUNT.MERGE_PARTIAL(IF(b.record_date >= DATE_TRUNC(g.record_date, MONTH),        b.v, NULL)) AS buyer_count_mtd,
       HLL_COUNT.MERGE_PARTIAL(b.v)                                                            AS buyer_count_ytd
FROM grid g
LEFT JOIN cube b
  ON <dims 일치> AND b.record_date BETWEEN DATE_TRUNC(g.record_date, YEAR) AND g.record_date
GROUP BY g.record_date, <g.dims>
```

가장 넓은 구간(`ytd`)으로 **한 번만** 조인하고 좁은 기간은 `IF` 로 걸러낸다. 집계 함수가
`NULL` 을 무시하는 성질을 쓴다. 기간마다 블록을 따로 만들면 격자가 기간 수만큼
재계산되어 CPU 한도에 걸린다 — 실측 11,924초 / 한도 4,300.

그래서 `periods.js` 는 누계를 **좁은 것부터** 선언해야 한다. 마지막 것이 조인 범위가 된다.

스케치는 스케치로 남긴다. `MERGE` 로 정수를 만들면 더 병합할 수 없다 (P11).

정확도는 실측으로 확인했다.

> 2026-08 China MTD. 8/10 스케치 751 / 정확값 751, 8/31 스케치 4,515 / 정확값 4,511 (0.09%).

#### `'(all)'` 도 같은 규칙을 따른다

1번 단계의 `CUBE` 가 롤업 행을 만들 때 쓰는 함수도 가산성이 정한다.

```
가산    SUM(v)
비가산  HLL_COUNT.MERGE_PARTIAL(v)      ← SUM 이 아니다
```

실측으로 2026-08 `buyer_count` 의 전사 값이 국가별 합 10,268 / 병합 10,264 였다. 이 4
차이는 겹침이 아니라 HLL 오차다 — conformed 축이 전부 user 속성이라 사용자를 분할하기
때문이다. 겹치는 축이 들어오는 순간 `SUM` 은 깨진다.

## 3단계 — 비교 기준값

`period_` 를 시프트해 자기 자신과 조인한다. 물리 테이블이라 재계산이 없다.

| 컬럼 | 기준 | 시프트 | 가져오는 값 |
|---|---|---|---|
| `dod_base` | daily | `-1 DAY` | `<m>` |
| `wow_base` | daily | `-1 WEEK` | `<m>` |
| `yoy_base` | daily | `-1 YEAR` | `<m>` |
| `wtd_wow_base` | wtd | `-1 WEEK` | `<m>_wtd` |
| `wtd_yoy_base` | wtd | `-364 DAY` | `<m>_wtd` |
| `mtd_mom_base` | mtd | `-1 MONTH` | `<m>_mtd` |
| `mtd_yoy_base` | mtd | `-1 YEAR` | `<m>_mtd` |
| `ytd_yoy_base` | ytd | `-1 YEAR` | `<m>_ytd` |

서로 다른 시프트가 5개(`1 DAY`·`1 WEEK`·`1 MONTH`·`1 YEAR`·`364 DAY`)이므로 자기조인도
5번이다. 8컬럼을 5번으로 채운다.

**주간 비교는 364일이다.** `wtd` 의 YoY 가 `1 YEAR` 이면 요일이 어긋난다 —
2026-03-02(월)의 1년 전은 일요일이다. 52주 시프트가 같은 요일에 떨어진다.

**`DATE_SUB` 이 월말을 보정한다.** `2026-03-31 - 1 MONTH = 2026-02-28` 이라 월말 `mtd`
끼리 맞물린다. 대신 3/30 과 3/31 이 둘 다 2/28 로 간다 — 월말 며칠의 MoM 은 이 성질을
알고 봐야 한다.

누계에 `dod` 는 붙이지 않는다. "어제까지 월 누계 대비 오늘까지"는 결국 오늘 하루치라
`dod_base` 와 같은 값이 된다.

## 컬럼 이름 규칙

**기간 접두어가 없으면 daily 다.**

```
net_revenue              daily 값
net_revenue_wtd          누계 값
dod_base · wow_base · yoy_base     daily 기준 비교
wtd_wow_base · mtd_mom_base · ...  누계 기준 비교
```

가로가 되면서 `wow_base` 하나로는 daily 의 WoW 인지 `wtd` 의 WoW 인지 구분이 안 된다.
둘 다 존재하고 값이 다르다. 그래서 누계 쪽에만 접두어를 붙인다 — 기존 daily 소비자의
쿼리가 그대로 동작한다.

## 조회

```sql
-- 전사 이번 달 현재까지 + 작년 같은 날까지
SELECT net_revenue_mtd, mtd_yoy_base
FROM semantic.metric_net_revenue
WHERE record_date = CURRENT_DATE()
  AND country='(all)' AND age_group='(all)' AND gender='(all)' AND acquisition_channel='(all)'

-- 국가별 월별 추이 12개월  (직전 구조의 monthly 를 대신한다)
SELECT record_date, country, net_revenue_mtd
FROM semantic.metric_net_revenue
WHERE is_month_end
  AND age_group='(all)' AND gender='(all)' AND acquisition_channel='(all)'
ORDER BY record_date DESC LIMIT 12

-- 비가산 지표는 EXTRACT 해서 본다 (P11)
SELECT HLL_COUNT.EXTRACT(buyer_count_mtd) AS buyers_mtd
FROM semantic.metric_buyer_count
WHERE record_date = CURRENT_DATE() AND country='KR'
  AND age_group='(all)' AND gender='(all)' AND acquisition_channel='(all)'
```

## 갱신

`daily_` 는 entity 가 정한 방식(`incremental` / `table`)을 따른다.
`period_`·`metric_` 은 전부 `table` 이다 (P22).

하루가 늘면 그날의 `wtd`·`mtd`·`ytd` 가 생기고, 364일·1년 뒤 행의 비교 기준값까지
바뀐다. 무효화 범위가 흩어져 있어 증분이 이득이 없다. 실측 소요는 `period_` 78초 /
`metric_` 179초다.

## 검증 계획

- `daily_` 를 4축으로 걷은 값이 `period_` 의 daily 컬럼과 같은가
- `'(all)'` 행이 각 축의 합과 같은가 (가산) · `MERGE` 와 같은가 (비가산)
- 월말 `mtd` 가 `daily_` 의 그 달 합과 같은가
- `is_month_end` 로 고른 `mtd` 가 직전 구조의 `monthly` 와 같은가
- 비교 기준값이 시프트한 날짜의 값을 정확히 가리키는가
- `record_date` 의 최대값이 `daily_` 의 최대값을 넘지 않는가 (미래 행 없음)
