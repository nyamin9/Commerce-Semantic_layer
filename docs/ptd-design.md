# 기간 누계(PTD) 설계

작업 중인 변경의 설계 노트다. 구현이 끝나면 `principles.md`·`metrics.md`로 접고 이 파일은 지운다.

## 왜 하는가

프로젝트 목적 중 하나가 이것이었다.

> 모든 지표가 **daily → 누적(WTD/MTD/YTD) → 비교(YoY 등)**로 이어지는
> 동일한 테이블 구조를 갖도록 일관된 스키마 확립

지금은 가운데가 비어 있다.

```
목적:  daily → 누적(WTD/MTD/YTD) → 비교
현재:  daily → 기간확장(weekly/monthly/yearly) → 비교
              ↑ 완결 기간이지 누계가 아니다
```

`period_`는 **8월 전체**이고 누계는 **8월 1~14일**이다. 다른 값이다.

P15가 "누계는 저장하지 않고 소비 시점에 파생한다"고 정했지만 **파생하는 코드가 없다.**
`periods.js`의 주석 한 줄이 전부다. 소비자가 매번 창 함수를 직접 써야 한다.

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

**`period_start`(시작)와 `as_of_date`(끝)가 이미 구간을 표현하기 때문이다** (P13).
누계는 `as_of_date`가 달력 끝이 아니라 cutoff 인 기간일 뿐이다.

| | `period_start` | `as_of_date` | 뜻 |
|---|---|---|---|
| `monthly` | 8/01 | **8/31** | 월 전체 |
| `mtd` | 8/01 | **8/14** | 그날까지 |

## 테이블 구조

`Jeans · Men · China · 50s · m · search · shipped` 조합의 **2026-08-14** 기준.

### `daily_net_revenue` — 변화 없음

```
dt          <차원 7>   net_revenue
2026-08-01  ...              55.38
2026-08-06  ...              25.00
2026-08-10  ...             242.99
2026-08-14  ...              39.50
```

조인이 실행되는 유일한 곳. 활동한 날만 행이 있다 (8/2~8/5 없음).

### `period_net_revenue` — 4종 → **7종**

```
period_type  period_start  as_of_date   net_revenue
daily        2026-08-14    2026-08-14         39.50
wtd          2026-08-10    2026-08-14        282.49   ← 추가
mtd          2026-08-01    2026-08-14        362.87   ← 추가
ytd          2026-01-01    2026-08-14      2,884.00   ← 추가
weekly       2026-08-10    2026-08-16        282.49
monthly      2026-08-01    2026-08-31        950.88
yearly       2026-01-01    2026-12-31      4,102.00
```

### `metric_net_revenue` — 구조 동일 + 비교

```
period_type  period_start  as_of_date   net_revenue  dod_base  wow_base  mom_base  yoy_base
daily        2026-08-14    2026-08-14         39.50     25.00    242.99      NULL     31.00
wtd          2026-08-10    2026-08-14        282.49      NULL    198.00      NULL    240.00
mtd          2026-08-01    2026-08-14        362.87      NULL      NULL    410.00    330.00
ytd          2026-01-01    2026-08-14      2,884.00      NULL      NULL      NULL  2,650.00
monthly      2026-08-01    2026-08-31        950.88      NULL      NULL  1,020.00    880.00
```

`mtd`의 `mom_base`는 **지난달 1~14일 누계**, `yoy_base`는 **작년 8월 1~14일 누계**다.
`rpt_daily_revenue` 에도 없는 값이다 — 거기 `yoy_base` 는 daily 기준이다.

## 조인 기준을 `as_of_date` 로 바꾼다

```sql
-- 지금
b.period_start = DATE_SUB(c.period_start, INTERVAL x)
-- 이후
b.as_of_date   = DATE_SUB(c.as_of_date,   INTERVAL x)
```

`period_start` 로 조인하면 `mtd` 8/1 행이 **지난달의 모든 cutoff 행(7/1~7/31)에 다 매칭**되어
틀린다. `(period_type, as_of_date)` 가 차원 조합마다 유일하므로 `as_of_date` 가 맞는 기준이다.

기존 4종은 결과가 같다. BigQuery 의 `DATE_SUB` 가 월말을 보정한다.

```
2026-03-31 - 1 MONTH = 2026-02-28   ← 2월 monthly 행의 as_of_date 와 일치
2026-12-31 - 1 YEAR  = 2025-12-31
```

## 비교 라벨

| period_type | 붙는 비교 |
|---|---|
| `daily` | `dod` · `wow` · `yoy` |
| `wtd` | `wow` · `yoy` |
| `mtd` | `mom` · `yoy` |
| `ytd` | `yoy` |
| `weekly` | `wow` · `yoy` |
| `monthly` | `mom` · `yoy` |
| `yearly` | `yoy` |

누계에 `dod` 는 넣지 않는다. "어제까지 월 누계 대비 오늘까지"는 결국 오늘 하루치라
`daily` 와 같은 값이 된다.

## 비용

| | 행 수 (`net_revenue`) |
|---|---|
| 현재 `period_` | 626,877 |
| **PTD 3종 추가 (희소)** | **1,217,535** (2배) |
| 격자를 채우면 (conformed 4차원) | 5,976,720 (10배) |

**희소를 택한다.** 격자를 채우면 PTD 만 차원이 4개가 되어 "모든 지표가 동일한 테이블
구조"라는 목적과 정면으로 어긋난다.

## 제약 — P14-1 과 같다

누계도 **차원을 걷으며 `SUM` 하면 과소 집계된다.** 그날 활동이 없던 조합은 행이 없고
`SUM` 이 그것을 빼기 때문이다.

> 2026년 실측. 차원 조합 27,749개, 조합당 활동일 **평균 2.66일**, 절반 이상(55.2%)이
> 1년에 하루만 나타난다. "8/15 기준 국가별 YTD" 를 걷으면 그날 쉰 조합이 전부 빠진다.

`_base` 에 이미 같은 제약이 있다 (P14-1). 새로운 종류의 타협이 아니라 같은 원칙의 확장이다.

## 바뀌는 것 / 안 바뀌는 것

| | |
|---|---|
| 컬럼 | 안 바뀜 |
| 테이블 수 | 안 바뀜 (지표당 3개) |
| `gen_*.js` | 안 바뀜 |
| `periods.js` | **+3종** |
| `build.js` | 누계용 롤업 한 갈래 + 조인 기준 변경 |
| 행 수 | `period_`·`metric_` 이 2배 |

## 검증 계획

6단계에서 `rpt_daily_revenue` 의 `net_revenue_wtd/mtd/ytd` 를 창 함수로 재현해
**5,451개 키 전부 일치**시킨 적이 있다. 같은 대조를 `period_` 기준으로 다시 한다.

- `period_type IN ('wtd','mtd','ytd')` 의 값이 `rpt_` 와 일치하는가
- `monthly` 의 마지막 날 `mtd` 가 `monthly` 값과 같은가
- `yoy_base` 가 작년 같은 cutoff 를 가리키는가
