# 운영

- 스케줄 · 실행 계정 · 상류 결함 · 현재 상태
- 시간이 지나면 낡는 내용을 여기 모음
- 용어는 [glossary.md](glossary.md) 를 따름

## 1. 진행 상태

| 단계 | 산출물 | 상태 |
|---|---|---|
| 1 | `includes/` 선언 계층 + builder | 완료 |
| 2 | `semantic_mart` 7개 + 상류 감시 assertion | 완료 |
| 3 | `sem_dim_date` | 완료 (2단계에 포함) |
| 4 | `gen_daily.js` · `gen_period.js` · `gen_metric.js` | 완료. 17개씩 생성 |
| 5 | `gen_registry.js` | 완료. `metric_registry` 29행 |
| 6 | `rpt_*` 대조 후 SSOT 전환 | 완료. 퍼널·코호트는 후속 |
| 7 | 스케줄 · 실행 계정 | 완료 |

## 2. 실행 계획

- `dataform compile` 이 정하는 것은 **무엇을 만들지**임
- 언제 어떤 계정으로 돌릴지는 Dataform 의 release configuration 과 workflow configuration 이
  정하는데, 그건 GCP 리소스라 git 에 없음 — 레포만 보고는 무엇이 언제 도는지 알 수 없음

- 그래서 `infra/workflows.json` 을 원천으로 두고 `apply.js` 가 맞춤

```bash
node infra/apply.js --dry-run   # 선언과 GCP 의 차이
node infra/apply.js             # 적용
```

| | cron (UTC) | 태그 | 성격 |
|---|---|---|---|
| `production` (release) | `0 4 * * *` | — | `main` 컴파일 |
| `semantic-daily` | `30 4 * * *` | `mart` `semantic` | 본 파이프라인. 게이트 assertion 포함 |
| `upstream-monitoring` | `0 5 * * *` | `monitoring` | 상류 감시. 실패해도 본 파이프라인은 돎 |

- 상류 `thelook_dw_daily` 가 `0 3 * * *` UTC 에 시작함
- 1시간 30분 여유를 뒀고 `semantic-daily` 는 실측 **3분 53초** 걸림
  (테이블 59 · assertion 118 을 돌렸을 때. 지금 그래프는 assertion 124)

- `order_item`·`order` 는 매일 전 기간을 다시 만듦
- `daily_` 가 20만 행이라 전체 재생성이 증분보다 쌈 — 증분은 구간을 계산하고 `DELETE` 한 뒤 `INSERT` 하는 단계가
  더 붙음 ([findings.md](findings.md) 17)

### 2-1. 실행 계정

```
dataform-semantic@analytics-engineering-practice.iam.gserviceaccount.com
  roles/bigquery.jobUser                     프로젝트 — 쿼리 실행
  dataEditor  semantic_mart · semantic · semantic_metadata · semantic_assertions
  dataViewer  dbt_dev_marts_core             읽기만
```

- **소유 경계가 IAM 으로 강제됨** (P1)
- DW 에 쓸 수 없는 것이 코드 규율이 아니라 권한임

- Dataform 서비스 에이전트에는 이 계정으로 실행할 권한이 둘 다 필요함

```
roles/iam.serviceAccountTokenCreator
roles/iam.serviceAccountUser            ← 스케줄 실행에 이것도 있어야 한다
```

- `serviceAccountUser` 가 없으면 **수동 실행은 되는데 스케줄 실행만 code 7 로 실패함.** 수동 실행은 사람의
  권한으로 돌기 때문에 이 차이가 드러나지 않음

## 3. 현재 BigQuery 상태

| 데이터셋 | 내용 |
|---|---|
| `semantic_mart` | 7개 테이블. 게이트 assertion 15개 |
| `semantic` | `daily_*` · `period_*` · `metric_*` 17개씩 **51개.** 크기는 [tables.md](tables.md) 6장 |
| `semantic_metadata` | `metric_registry` 29행 (base 17 · ratio 7 · excluded 5) |
| `semantic_assertions` | assertion 결과 |

- 지표별 테이블 크기는 `serving_dims` 개수에 따라 다름

- entity 별 크기와 스키마는 [tables.md](tables.md) 에 있음

## 4. `rpt_*` 대조 결과

- `dbt_dev_marts_reporting.rpt_daily_revenue` 와 `record_date × department`
  grain 으로 전 구간을 대조했음
- 키 5,451개 · 2019-01-07 ~ 2026-09-16

| `rpt_` 컬럼 | 우리 쪽 | 다른 키 | 판정 |
|---|---|---|:---:|
| `net_revenue` | `metric_net_revenue` | 0 | 동일 |
| `net_gross_profit` | `metric_gross_profit` | 0 | 동일 |
| `order_item_count` | `metric_order_item_count` | 0 | 동일 |
| `returned_item_count` | `metric_units_returned` | 0 | 동일 |
| `buyer_count` | `metric_buyer_count` | 12 | HLL 근사 오차 (0.2%) |
| `net_revenue_wtd/mtd/ytd` | `net_revenue_wtd/mtd/ytd` | 0 | 동일 |
| `net_revenue_yoy_rate` | 저장하지 않음 | — | `yoy_base` 로 재현 가능 |
| `order_count` | `metric_order_count` | — | **`rpt_` 가 33% 이중 계산** (결함 9) |

- **두 파이프라인이 독립적으로 만든 8년치 매출이 소수점까지 같음.** 상세는 [findings.md](findings.md) 19 에
  있음

### 4-1. 존치하는 것

- `rpt_daily_funnel` · `rpt_user_cohort_retention` 은 폐기 대상이 아님
- 우리가 **의도적으로 만들지 않은 영역**이고 registry 에 `is_generated: false` 로 남아 있음
- 퍼널은 아래 결함 7, 코호트는 사용자 생애주기라서 후속 작업임

## 5. 알려진 상류 결함

- 우회하지 않고 assertion 으로 감시함
- 원인은 dbt-airflow 쪽에 있음

| # | 현상 | 규모 | 영향 |
|---|---|---|---|
| 1 | 자연키 재사용 | `order_id` 4,038행 / `order_item_id` 5,161행 중복 | surrogate key 로 대응 (P2) |
| 2 | `fct_order_items.order_key` NULL | 1,673행 (2026-08-19~26). backfill 로 해소 | 재발하면 `COUNT(DISTINCT order_key)` 가 최근 구간 과소집계 |
| 3 | line item 없는 주문 | 477건 (2026-08-17~24) | 두 fact 정합 불일치 |
| 4 | `fct_orders` 적재 지연 | `order_items` 는 08-26, `orders` 는 08-24까지 | 주문 grain 지표가 최근 이틀 결측 |
| 5 | SCD 이력 부족 | `valid_from` 최솟값 2026-08-15, fact 는 2019-01-13부터 | point-in-time 매칭률 4.46% |
| 6 | `dim_date` 부재 | — | semantic layer 가 생성 |
| 7 | `fct_sessions` 퍼널 플래그 모순 | `purchased` 인데 `viewed_product` 가 아닌 세션 72,045건. 세션 구매율 77.1% | **퍼널 전환 지표를 이 플래그로 만들 수 없음** |
| 8 | `dim_products.brand_name` 결측 | 상품 29,120개 중 24개. 주문 라인 154행 | 마트에서 `'(unknown)'` 로 채움 |
| 9 | `rpt_daily_revenue.order_count` 이중 계산 | department 별 합산 183,826 vs 실제 138,061 (33% 과임) | `COUNT(DISTINCT order_key)` 를 department 별로 센 것. department 를 rollup 하면 틀림.<br>우리 쪽은 `order` entity 라 department 축이 없음 |

- 2~4번은 모두 최근 구간에 몰려 있어 늦게 도착한 데이터 문제로 보임

- 7번은 성격이 다름
- 전자상거래 세션 구매율은 통상 1~3%인데 77.1%가 나옴
- `purchased` 가 이름대로 동작하지 않는다는 뜻이므로 **원인이 밝혀지기 전까지 세션 퍼널 지표를 정의하지 않음.**

### 5-1. 상시 실패하는 감시 assertion

- `upstream-monitoring` 워크플로가 매일 3건 실패함
- **그것이 정상임.**

```
upstream_natural_key_reuse       결함 1
upstream_orders_load_lag         결함 4
upstream_session_funnel_flags    결함 7
```

- 전부 DW 테이블만 읽으므로 본 파이프라인에 영향이 없음

## 6. 개발

```bash
# 컴파일 검증 (로컬. BigQuery 접근 불필요)
npx @dataform/cli@3.0.65 compile

# 의존 그래프 확인
npx @dataform/cli@3.0.65 compile --json > graph.json

# 전체 실행
npx @dataform/cli@3.0.65 run --tags mart --tags semantic
```

- `dataform run` 은 `.df-credentials.json` 또는 ADC 가 필요함
- 실제 운영은 Dataform 콘솔의 서비스 계정으로 돌아가므로 로컬 실행은 편의 목적임

- `main` 이 Dataform 이 추적하는 브랜치임
- 콘솔 workspace 는 자동 동기화되지 않으므로 푸시 후 `Pull from default branch` 를 눌러야 반영됨

### 6-1. 스키마를 바꿀 때

- 파티션 컬럼을 바꾸면 `CREATE OR REPLACE` 가 거부됨
- 테이블을 지우고 다시 만들어야 함
- 컬럼 추가·삭제만이면 `--full-refresh` 로 충분함

```bash
npx @dataform/cli@3.0.65 run --full-refresh --tags period --tags metric
```

## 7. 남은 작업

| | |
|---|---|
| 고객 grain entity | 재구매율 · LTV · 코호트를 열려면 사용자 1명 = 1행인 fact 가 필요함 |
| 큐브 쪼개기 | 분석가에게 먼저 열고 `INFORMATION_SCHEMA.JOBS` 로 실제 조합을 센 뒤 판단함 ([porting.md](porting.md) 4장) |
| 퍼널 · 코호트 지표 | 상류 결함 7 이 해소되어야 함 |
| SCD point-in-time | 이력 커버리지 4.46%. 이력이 쌓이면 재검토 |
