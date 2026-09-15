# 기간 누계(PTD) 설계

작업 중인 변경의 설계 노트다. 구현이 끝나면 `principles.md`·`metrics.md`로 접고 이 파일은 지운다.

## 왜 하는가

프로젝트 목적 중 하나가 이것이었다.

> 모든 지표가 **daily → 누적(WTD/MTD/YTD) → 비교(YoY 등)**로 이어지는
> 동일한 테이블 구조를 갖도록 일관된 스키마 확립

가운데가 비어 있다. `period_`의 `monthly`는 **8월 전체**이고 누계는 **8월 1~14일**이다.
다른 값이다.

## 무엇을 하는가 — 누계를 `period_type`으로 편입한다

컬럼도 테이블도 파일도 늘지 않는다. `periods.js`에 3종을 추가하면 기존 파이프라인이
누계도 비교도 만든다.

```
daily    passthrough
wtd      cumulative  WEEK(MONDAY)
mtd      cumulative  MONTH
ytd      cumulative  YEAR
weekly   rollup      WEEK(MONDAY)
monthly  rollup      MONTH
yearly   rollup      YEAR
```

`period_start`(시작)와 `as_of_date`(끝)가 이미 구간을 표현하기 때문이다 (P13).
누계는 `as_of_date`가 달력 끝이 아니라 cutoff 인 기간일 뿐이다.

| | `period_start` | `as_of_date` |
|---|---|---|
| `monthly` | 8/01 | **8/31** — 월 전체 |
| `mtd` | 8/01 | **8/14** — 그날까지 |

## 격자를 채운다

누계를 활동한 날에만 만들면 **걷는 순간 대부분이 사라진다.**

> 실측. 희소하게 만든 `mtd` 로 "2026-08-14 기준 국가별 MTD" 를 내면 전사 합계가
> 25,618 인데 실제는 192,871 이다 — **13%만 나온다.** 8/14에 안 팔린 조합의
> 8/1~8/13 매출이 통째로 빠지기 때문이다.

누계는 거의 항상 걷어서 본다. "전사 MTD", "국가별 MTD" 가 대표 용도이고
7차원 조합 하나의 MTD 를 보는 사람은 없다. 그래서 격자를 채운다.

```
1) 날짜 × 차원조합 을 전부 만든다              CROSS JOIN
2) daily_ 를 LEFT JOIN 해 값을 붙인다           없으면 0
3) 그 위에 누적한다
```

2번의 `0` 이 핵심이다. 그날 활동이 없어도 행이 생기고, 누적값이 앞 구간을 그대로
들고 가므로 걷어도 빠지지 않는다.

## 누계는 차원을 좁힌다

격자 크기는 **조합 수 × 날짜**로만 정해진다. 원본 행 수와 무관하다.

| | 조합 | 날짜 | PTD 3종 격자 |
|---|---|---|---|
| 7차원 그대로 | 27,749 | 2,767 | **2,900만** |
| **conformed 4차원** | **720** | 2,767 | **598만** |

`category`(26) 하나만 넣어도 격자가 26배가 된다. `brand` 를 차원에서 뺀 것과 같은
판단이다 (P4).

```
누계에 남기는 축   country(15) · age_group(6) · gender(2) · acquisition_channel(5)
빼는 축            category · department · order_item_status
```

빠진 축은 **`'(all)'`** 로 채운다. `NULL` 로 두면 "값이 없는 버킷"(P6-1)과 뜻이 겹친다.
`brand` 에 `'(unknown)'` 을 붙인 것과 같은 방식이다.

## 테이블 구조

```
period_type  category  department  country  age_group  gender  acq     order_item_status  net_revenue
daily        Jeans     Men         China    50s        m       search  shipped                  39.50
weekly       Jeans     Men         China    50s        m       search  shipped                 282.49
monthly      Jeans     Men         China    50s        m       search  shipped                 950.88
wtd          (all)     (all)       China    50s        m       search  (all)                 1,204.00
mtd          (all)     (all)       China    50s        m       search  (all)                 4,120.00
ytd          (all)     (all)       China    50s        m       search  (all)                31,500.00
```

`metric_` 은 여기에 `dod_base` · `wow_base` · `mom_base` · `yoy_base` 가 붙는다.
`mtd` 의 `mom_base` 는 **지난달 1~14일 누계**, `yoy_base` 는 **작년 8월 1~14일 누계**다.
`rpt_daily_revenue` 에도 없는 값이다 — 거기 `yoy_base` 는 daily 기준이다.

## 조인 기준은 `as_of_date`

```sql
b.as_of_date = DATE_SUB(c.as_of_date, INTERVAL x)
```

`period_start` 로 조인하면 `mtd` 8/01 행이 지난달의 모든 cutoff(7/01~7/31)에 매칭되어
틀린다. `(period_type, as_of_date)` 가 차원 조합마다 유일하므로 그쪽이 맞는 기준이다.

완결 기간은 결과가 같다. `DATE_SUB` 이 월말을 보정한다.

```
2026-03-31 - 1 MONTH = 2026-02-28   ← 2월 monthly 행의 as_of_date 와 일치
```

`uniqueKey` 도 `as_of_date` 여야 한다. 누계는 같은 `period_start` 에 cutoff 가 여러 개다.

## 누적 계산은 두 갈래

| `additive.time` | 방법 |
|---|---|
| `true` | 창 함수 — `SUM(v) OVER (PARTITION BY 조합, 기간 ORDER BY dt)` |
| `"sketch"` | **구간 병합** — `HLL_COUNT.MERGE` 를 `[기간시작, 그날]` 범위 자기조인으로 |

`HLL_COUNT.MERGE_PARTIAL` 은 **analytic function 을 지원하지 않는다.** dry run 은 통과하고
실행에서 `Analytic function MERGE_PARTIAL is not supported` 로 떨어진다 —
컴파일로도 dry run 으로도 못 잡는다.

구간 자기조인으로는 정확하다.

> 실측 (2026-08). China MTD 8/10 스케치 751 / 정확값 751, 8/31 스케치 4,515 /
> 정확값 4,511 (0.09%).

`daily_` 는 스케치만 쌓고 일자별·기간별·누적 계산은 전부 하류에서 한다. 그 구조라
누계도 하류에서 병합하면 된다.

## 비교 라벨

| period_type | 붙는 비교 |
|---|---|
| `daily` | `dod` · `wow` · `yoy` |
| `wtd` · `weekly` | `wow` · `yoy` |
| `mtd` · `monthly` | `mom` · `yoy` |
| `ytd` · `yearly` | `yoy` |

누계에 `dod` 는 넣지 않는다. "어제까지 월 누계 대비 오늘까지"는 결국 오늘 하루치라
`daily` 와 같은 값이 된다.

## 바뀌는 것 / 안 바뀌는 것

| | |
|---|---|
| 컬럼 · 테이블 수 · `gen_*.js` | 안 바뀜 |
| `periods.js` | +3종 |
| `entities.js` | `cumulative_dims` 선언 추가 |
| `build.js` | 누계 갈래 (가산/스케치 둘) · 격자 · 조인 기준 · `uniqueKey` |
| 행 수 | `period_`·`metric_` 629K → **약 660만** |

`partitionBy` 를 `period_start` 에서 `as_of_date` 로 바꾸므로 **기존 테이블을 지우고
다시 만들어야 한다.** BigQuery 가 파티션 컬럼이 다른 덮어쓰기를 거부한다.

## 검증 계획

- `rpt_daily_revenue` 의 `net_revenue_wtd/mtd/ytd` 와 대조 (6단계에서 5,451개 일치시킨 쿼리)
- 월 마지막 날 `mtd` 가 `monthly` 와 같은가
- 국가별로 걷은 MTD 가 `daily_` 구간 합과 같은가 ← 격자가 제대로 찼는지
- `yoy_base` 가 작년 같은 cutoff 를 가리키는가
- 스케치 누계가 정확값과 오차 범위 안인가
