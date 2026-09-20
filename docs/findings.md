# 실측 기록

- 규칙의 근거가 된 숫자와 실패
- 다른 문서는 규칙만 적고 여기를 가리킴

- **이 문서만 과거를 담음.** 나머지는 지금 코드를 설명함

- 측정 환경은 BigQuery on-demand, `analytics-engineering-practice` 프로젝트임
- CPU 한도는 쿼리마다 다르게 보고되었음 — 4,300초와 5,100초를 봤음

---

## 1. 사전 집계가 성능을 벌지 못함

| | |
|---|---|
| `daily_` 행 수 ÷ atomic fact 행 수 | 98.7% (203,168 / 205,943) |
| atomic fact 전 기간 + dimension 조인 + 임의 필터 | 8.5 MB |

- 행이 거의 줄지 않음
- **이 구조의 이득은 쿼리 속도가 아니라 정의 표준화와 변경 비용**임

- → [architecture.md](architecture.md) 3절

## 2. 고유값이 많은 컬럼은 dimension 이 될 수 없음

- `brand` 는 고유값이 2,753개임

| | `brand` 포함 | `brand` 제외 |
|---|---|---|
| `daily` 행 | 187,477 | 184,598 |
| 월 단위로 집계 | 186,292 | 150,837 |
| 연 단위로 집계 | **178,916** | **83,320** |

- 연 단위로 집계해도 행이 5%밖에 줄지 않음
- 게다가 그 크기로 비교 self-join 을 돌리면 CPU 한도에 걸려 **지표 6개가 생성되지 못했음** (2026-09-13)

- 값이 2개인 `purchase_type` 은 조합을 1,708 → 5,064 로 2.96배 만듦
- 같은 자리에 `category`(26값)를 넣으면 26배임

- → [principles.md](principles.md) P4 · P4-1

## 3. CTE 는 참조 횟수만큼 다시 계산됨

- 기간 확장을 `metric_` 안의 CTE 로 두면 본 쿼리 1회 + 비교 조인만큼 참조되어 같은 집계가 그만큼 돎

```
dimension 7개 지표    CPU 3,600초 / 한도 4,300    스캔은 14 MB
```

- 비용이 아니라 낭비가 문제임
- **조인 술어를 바꿔도 변하지 않음** — `=` · `COALESCE` · `IS NOT DISTINCT FROM` 이 전부
  3,600초대였음
- 중간 단계를 테이블로 저장하는 것만 효과가 있음 (2026-09-13)

- → [architecture.md](architecture.md) 5절 · [principles.md](principles.md) P11

## 4. PTD 를 빈 날 없이 만들면 rollup 이 무너짐

- 빈 날을 채우지 않은 `mtd` 로 "2026-08-14 기준 country 별 MTD" 를 내면

```
country 별 합계    25,618
실제               192,871      → 13% 만 나온다
```

- 8/14에 팔리지 않은 조합의 8/1~8/13 매출이 통째로 빠지기 때문임

- → [principles.md](principles.md) P15

## 5. 날짜는 `sem_dim_date` 에서 가져와야 함

- 집계 결과의 날짜를 쓰면 전사적으로 거래가 0인 날이 빠져 PTD 가 끊김

```
2,811일 중 44일이 그랬다
```

- → [principles.md](principles.md) P15-1

## 6. rollup 을 PTD 보다 먼저 하면 sketch 가 CPU 한도를 넘김

- rollup 을 먼저 하면 `'(all)'` 행의 HLL sketch 가 조밀해짐
- sketch PTD 는 1년 구간을 self-join 해서 병합하므로 그 조밀한 sketch 를 날마다 수백 번 읽음

```
rollup 먼저   CPU 1,748,227초   한도 초과로 실패
PTD 먼저      통과
```

- 값은 둘 다 같음
- `SUM` 은 결합법칙이 성립하고 HLL 병합은 합집합임

- → [architecture.md](architecture.md) 6-4

## 7. `GROUPING SETS` 는 집합마다 입력을 다시 읽음

- dimension 4개면 16개 집합이고, 입력에 구간 self-join 이 있으면 그것이 16번 돎

```
GROUPING SETS   CPU 357,307초   한도 초과로 실패
axis_mask CROSS JOIN   통과
```

- `CUBE` 는 애초에 쓸 수 없음
- `GROUP BY record_date, CUBE(...)` 가 *"only supports CUBE when there are no
  other grouping elements"* 로 거부됨

- → [architecture.md](architecture.md) 6-2 · [porting.md](porting.md) 3-1

## 8. `IS NOT DISTINCT FROM` 은 해시 조인 키가 못 됨

- 등가 조인이면 양쪽을 해시로 나눠 붙이는데, 일반 술어라 중첩 루프가 됨
- 평범한 조인에서는 차이가 드러나지 않다가 구간 self-join 에서 CPU 한도를 넘김

```
period_buyer_count 의 누계 단계 — grid 2,023,920 행 × 1년 구간

IS NOT DISTINCT FROM   CPU 88,022초   한도 초과로 실패
=                      통과
```

- 그래서 서빙 dimension 의 `NULL` 을 `'(unknown)'` bucket 으로 만듦 (2026-09-16)

- → [principles.md](principles.md) P6-3

## 9. 증분에 `MERGE` 를 쓰면 옛 행이 남음

- `MERGE` 는 지우지 않음
- dimension 값이 바뀌면 키가 달라져 옛 행이 매칭되지 않고 그대로 남음
- 키는 여전히 유일하므로 `uniqueKey` assertion 도 통과함

```
마트를 12일치 최신화하고 증분 실행
→ 남은 옛 행 3,933개가 net_revenue 를 188,992.92 부풀림
```

- (2026-09-13)

- → [principles.md](principles.md) P22

## 10. 증분 구간을 서브쿼리로 잡으면 partition pruning 이 안 걸림

- `(SELECT MAX(record_date) FROM self)` 는 실행 시점에야 값이 정해져서 BigQuery 가 파티션을 미리
  걸러내지 못함

```
리터럴 날짜    15,896 B
서브쿼리       3,000,288 B      → 189배
```

- `CURRENT_DATE` 기준으로 바꾸면 pruning 은 되지만 fact 날짜가 오늘보다 뒤처져 있어 증분이 0행을 처리함
- **정확성을 택하고 한계를 기록함.**

- 같은 189배가 마트의 `partitionBy` 와 `entities.js` 의 `date_col` 이 어긋날 때도 남
- 그쪽은 assertion 으로 감시함

- → [principles.md](principles.md) P22 · P20-1

## 11. 비가산 축을 `SUM` 으로 합산하면 부풂

- `active_user` 를 `additive.time: true` 로 잘못 선언하고 같은 데이터를 세 가지로 계산한 것

| record_date | 일별 값 | `true` 로 잘못 → `SUM` | `"sketch"` → `MERGE` | atomic fact 정답 |
|---|---:|---:|---:|---:|
| 2026-03-01 | 158 | 158 | 158 | 158 |
| 2026-03-02 | 152 | 310 | **290** | **290** |
| 2026-03-03 | 144 | 454 | **413** | **413** |
| 2026-03-04 | 155 | 609 | **528** | **528** |
| 2026-03-05 | 188 | 797 | **679** | **679** |

- sketch 경로는 atomic fact 를 직접 센 값과 일치하고, `SUM` 은 **5일 만에 17.4% 부풂.**

- → [principles.md](principles.md) P9 · P10

## 12. `_base` 를 rollup 하며 `SUM` 하면 과소 집계됨

- shift 한 시점에 같은 dimension 조합이 없으면 `_base` 는 `NULL` 이고, `SUM` 은 `NULL` 을 빼고 더함

```
metric_net_revenue 의 daily 행 194,406개 중 전년 동일 조합이 있는 행   1,754개 (0.9%)
yoy_base 를 department 별로 합산                                      85,912
department grain 에서 직접 계산한 전년 매출                        4,845,125    → 56배
```

- (2026-09-13)

- `'(all)'` rollup 행을 만들어 두는 이유 중 하나임

- → [principles.md](principles.md) P14-1

## 13. 완결 기간의 집계는 PTD 와 값이 같음

- 완결된 주의 `weekly` 값과 그 주 마지막 날의 `wtd` 값을 맞댔음

```
10,080 조합 전부 일치, 불일치 0      (2026-09-16)
```

- 그래서 `weekly` · `monthly` · `yearly` 를 만들지 않고 `is_*_end` 로 고름

- → [principles.md](principles.md) P13

## 14. 태그 오타는 0개 실행으로 성공함

```
$ dataform run --tags semantik
Compiled successfully.
No actions to run.
```

- 매칭되는 액션이 없으면 아무것도 만들지 않고 `SUCCEEDED` 로 끝남
- 스케줄이 매일 돌면서 0개를 실행하고 알림도 없음

- → [principles.md](principles.md) P20-1

## 15. 구매자는 뺄셈이 안 됨

- 한 사람이 완료 주문과 취소 주문을 둘 다 가질 수 있음

```
전체 구매자                         81,797
  ├ 매출만 낸 사람                  51,469
  ├ 매출도 내고 취소도 겪은 사람     17,576
  └ 취소만 한 사람                  12,752

buyer_count − void_buyer_count = 51,469   ≠   paying_buyer_count 69,045
```

- HLL 근사 때문이 아니라 distinct count 의 성질임
- 정확히 세도 마찬가지임

- → [metrics.md](metrics.md) 3장

## 16. sketch 의 정확도

```
2026-08 전사 MTD 구매자    sketch 10,264 / atomic fact 직접 계산 10,267    오차 0.029%
'(all)' 행                 sketch 10,264 / country 별 행을 MERGE 10,264    일치
```

- HLL precision 은 15 고정임
- 바꾸면 과거 sketch 와 병합할 수 없음

## 17. 전체 재생성이 증분보다 빠름

- `order_item`·`order` 를 `incremental` 에서 `table` 로 바꾼 뒤

```
테이블 45개 → 51개, 행 1억 60만 → 3억 4,394만
파이프라인   4분 0초 → 3분 48초
```

- `daily_` 가 20만 행이라 전체 재생성이 더 저렴함
- 증분은 구간을 계산하고 `DELETE` 한 뒤 `INSERT` 하는 단계가 더 붙음

- → [operations.md](operations.md) 2절

## 18. STRUCT 필드 이름도 예약어를 피해야 함

- `metric_registry` 에 조합 목록을 `ARRAY<STRUCT<rollup STRING, ...>>` 로 넣었더니 실패함

```
bigquery error: Syntax error: Unexpected keyword ROLLUP at [13:37]
```

- `ROLLUP` 은 GoogleSQL 예약어임 — `GROUP BY ROLLUP(...)` 의 그 키워드임
- 조인 alias 만 예약어를 피하면 된다고 보고 있었는데, **STRUCT 필드 이름도 같음**
- `rollup_name` 으로 바꿔 해결함 (2026-09-21)

- → [code-map.md](code-map.md) 4-6
