# Commerce-Semantic_layer

- BigQuery + Dataform 위에 커머스 semantic layer 를 만드는 프로젝트

- **변환(transformation)** — `dbt-airflow` 가 담당. 이 레포 밖
- **semantic layer** — 이 레포가 담당
- DW 테이블은 만들지 않음. `declaration` 으로 읽기만 함

## 1. 무엇을 만드나

1. **지표 정의가 한 곳에 있음.** `net_revenue` 가 무엇인지가 `includes/metrics.js`
   한 곳에만 있음
2. **집계 테이블이 선언에서 생성됨.** 사람이 쓰는 집계 SQL 은 0개임.
   지표 하나를 추가하는 비용이 선언 한 항목으로 고정됨
3. **틀린 집계가 막힘.** `additive` · join graph · assertion 이 막는 것은 전부
   *에러가 나지 않고 숫자만 틀리는* 종류의 사고임
4. **일자 · 누계 · 비교가 한 행에 있음.** `record_date` 하나로 그날 값과
   WTD·MTD·YTD, 그리고 각각의 비교 기준값을 전부 읽음

## 2. 구조

- 지표 하나가 테이블 3개가 됨
- 지표 17개 × 3 = 51개임

```
dbt_dev_marts_core           DW. 소유하지 않는다. declaration 으로 읽기만
        │
        ▼
semantic_mart                이름 정규화 · 자연키 제거 · grain 보증
        │
        │  조인 실행 (여기 한 번뿐)
        ▼
semantic.daily_<metric>      record_date × dimension 전체
        │
        │  serving_dims 로 좁히고 · 빈 날 채우고 · PTD 계산하고 · rollup
        ▼
semantic.period_<metric>     record_date × serving_dims + PTD 컬럼
        │
        │  record_date 를 shift 한 self-join 5번
        ▼
semantic.metric_<metric>     + 비교 기준값 8컬럼          ← 소비자는 이것만 읽는다
semantic_metadata.metric_registry                        지표 카탈로그
```

- `metric_net_revenue` 한 행이 이렇게 생겼음

```
record_date  country  purchase_type  is_month_end  net_revenue  _mtd      mtd_yoy_base
2026-08-31   China    first          TRUE                8,210   152,400        41,300
2026-08-31   China    repeat         TRUE                6,605   108,273        20,720
2026-08-31   China    (all)          TRUE               14,815   260,673        62,020
```

- `weekly` · `monthly` · `yearly` 는 만들지 않음

- 완결된 기간의 집계는 PTD 와 값이 같음
- 그래서 `is_month_end` 같은 플래그로 골라 씀

## 3. 문서

| | |
|---|---|
| [glossary.md](docs/glossary.md) | **용어집. 먼저 읽음.** 여기 없는 단어는 문서에 쓰지 않음 |
| [architecture.md](docs/architecture.md) | 왜 이 구조인가. 3단계의 근거와 핵심 결정 여섯 가지 |
| [code-map.md](docs/code-map.md) | 파일별 역할. 무엇을 고치면 무엇이 바뀌나 |
| [tables.md](docs/tables.md) | 테이블 구조. 실제 컬럼 · 행 수 · 파티션 |
| [porting.md](docs/porting.md) | 다른 프로젝트로 옮기기. 설계 / 선언 / 엔진 제약 |
| [principles.md](docs/principles.md) | 판단 기준 P1~P22 |
| [metrics.md](docs/metrics.md) | 지표 정의서와 지표 추가 절차 |
| [operations.md](docs/operations.md) | 스케줄 · 실행 계정 · 상류 결함 · 현재 상태 |
| [js-patterns.md](docs/js-patterns.md) | 코드를 읽기 전에 JS 가 낯설다면 |

- **처음 읽는다면** — `glossary.md` → `architecture.md` → `tables.md` → `code-map.md`
- **지표를 추가하려면** — `metrics.md` 7장만 보면 됨

## 4. 디렉터리

```
includes/                           선언 계층 — 사람이 쓰는 곳
  naming.js                         이름 규칙
  periods.js                        기간 선언
  entities.js                       entity 와 join graph
  metrics.js                        지표 선언
  build.js                          SQL builder. 선언을 검사하고 SQL 로 바꾼다

definitions/                        Dataform action
  sources/declarations.js           DW 읽기 전용 참조
  mart/*.sqlx                       semantic_mart 7개
  assertions/upstream_contract.js   상류 감시
  semantic/gen_daily.js             daily_<metric>
  semantic/gen_period.js            period_<metric>
  semantic/gen_metric.js            metric_<metric>
  metadata/gen_registry.js          metric_registry

infra/                              실행 계획 — GCP resource 선언
  workflows.json                    스케줄 · 태그 · 실행 계정
  apply.js                          선언을 Dataform 에 적용

workflow_settings.yaml              프로젝트 · 리전 · 데이터셋
```

- 문서에 나오는 두 말은 이렇게 나뉨

| | 파일 | 하는 일 |
|---|---|---|
| **builder** | `includes/build.js` | 선언을 읽어 SQL 문자열을 만듦 |
| **generator** | `definitions/**/gen_*.js` | builder 를 불러 Dataform action 을 만듦 |

## 5. 실행

```bash
# 컴파일 검증 (로컬. BigQuery 접근 불필요)
npx @dataform/cli@3.0.65 compile

# 전체 실행
npx @dataform/cli@3.0.65 run --tags mart --tags semantic
```

- 운영 스케줄과 실행 계정은 [operations.md](docs/operations.md) 에 있음

## 6. 조회 예시

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

-- distinct 지표는 EXTRACT 를 한 번 더 부른다
SELECT HLL_COUNT.EXTRACT(buyer_count_mtd) AS buyers_mtd
FROM semantic.metric_buyer_count
WHERE record_date = CURRENT_DATE() AND country='KR'
  AND age_group='(all)' AND gender='(all)' AND acquisition_channel='(all)'
```

- `'(all)'` — 그 dimension 을 rollup 한 행
- `'(unknown)'` — 값이 없는 bucket
- `serving_dims` 밖의 dimension(`category` 등)별 집계는 `daily_` 에서 냄.
  이유는 [architecture.md](docs/architecture.md) 6-2 에 있음
