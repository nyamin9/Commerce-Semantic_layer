# 용어집

이 레포의 문서와 코드 주석이 쓰는 말 전부. **여기 없는 단어는 쓰지 않는다.**

## 이 문서를 두는 이유

같은 것을 여러 이름으로 부르면 읽는 사람이 매번 "이게 아까 그건가"를 확인해야 한다.
새로 지어낸 말은 더 나쁘다 — 검색해도 나오지 않고 물어볼 곳도 없다.

규칙 네 가지를 지킨다.

| | |
|---|---|
| 한 개념에 한 단어 | dimension 을 "차원"·"축"으로 바꿔 부르거나, rollup 을 "접다"·"걷다"로 쓰지 않는다 |
| 코드에 이름이 있으면 그 이름 | `base`·`grid`·`cum` 을 "기저 조합"·"격자"로 바꿔 부르지 않는다 |
| 표준 용어는 원어 그대로 | 음차(스파인)도 직역(물화)도 하지 않는다 |
| 비유를 쓰지 않는다 | 동작을 그대로 쓴다 |

처음 등장하는 용어는 한 줄로 정의한다. 정의할 자신이 없으면 그 단어를 쓰지 않는다.

---

## 1. 레이어와 데이터셋

| 용어 | 뜻 |
|---|---|
| **semantic layer** | 지표의 정의를 한곳에 두고 표준화된 집계 테이블을 만드는 계층. 이 레포가 담당한다 |
| **DW** | data warehouse. dbt-airflow 가 만드는 변환 결과. 이 레포는 읽기만 한다. "창고"로 번역하지 않는다 |
| **`dbt_dev_marts_core`** | DW 의 mart 데이터셋. 우리가 읽는 원본 |
| **`semantic_mart`** | 우리가 소유하는 중간 데이터셋. DW 를 이름 정규화하고 grain 을 보증한 것 |
| **`semantic`** | 지표 테이블 데이터셋. `daily_` · `period_` · `metric_` |
| **`semantic_metadata`** | `metric_registry` 한 개가 들어 있는 데이터셋 |
| **`semantic_assertions`** | assertion 결과가 쌓이는 데이터셋. Dataform 이 만든다 |
| **declaration** | Dataform 에서 "이 테이블은 우리가 만들지 않고 읽기만 한다"는 선언 |

## 2. 모델링 (Kimball 표준 용어)

| 용어 | 뜻 |
|---|---|
| **fact** | 사건을 행으로 담은 테이블. 주문 라인 1건, 세션 1건 |
| **dimension** | fact 를 설명하는 속성 테이블. 상품, 사용자 |
| **measure** | fact 에 담긴 숫자. `sale_price`, `net_revenue` |
| **grain** | 그 테이블의 한 행이 무엇 하나를 뜻하는지. "주문 라인 1건" |
| **surrogate key** | 원본 ID 대신 우리가 만든 유일 키. 원본은 ID 를 재사용해서 유일하지 않다 |
| **natural key** | 원본이 준 ID. `order_id`, `order_item_id` |
| **conformed dimension** | 여러 fact 를 가로지르며 뜻이 같은 dimension. 네 entity 전부에 있는 것은 `country` 하나이고, `acquisition_channel` 이 셋(`order_item`·`order`·`session`)에 있다 |
| **fan-out** | 조인 때문에 행이 불어나 measure 가 중복 합산되는 것 |
| **atomic fact** | 집계하지 않은 원본 fact. `sem_fct_*` 를 가리킨다. "원자 fact" 로 쓰지 않는다 |
| **rollup** | dimension 컬럼 하나를 `GROUP BY` 에서 빼고 그 값들을 합치는 것. **dimension 방향만 가리킨다** — 시간 방향은 PTD 라고 부른다 |
| **축** | 합산 방향. **시간 축**(`time`)과 **dimension 축**이 있다. dimension 의 동의어로 쓰지 않는다 |
| **additive** | 그 축으로 합산해도 값이 맞는가. 축마다 `true` · `"sketch"` · `"last"` · `false` 중 하나로 선언한다 |
| **bucket** | dimension 값 하나가 만드는 그룹. `country = 'KR'` 인 행들이 한 bucket 이다 |

### rollup 이 정확히 무엇인가

dimension 컬럼 하나를 빼고 그 값들을 합친다. 행이 줄고 각 행이 더 넓은 범위를 뜻하게 된다.

```
country  gender        net_revenue      2026-08-31 실측
China    f                8,850.46   ┐
China    m                5,964.70   ┘→ gender 를 rollup
China    (all)           14,815.16

China    (all)           14,815.16   ┐
Brasil   (all)            4,970.90   ├→ country 를 rollup (나머지 13개국 포함)
(all)    (all)           43,682.09   ┘
```

**`SUM` 과 같은 말이 아니다.** `SUM` 은 합치는 방법이고 rollup 은 무엇을 합칠지다.
합치는 방법은 지표의 `additive` 가 정한다.

| `additive` | 합치는 함수 | 예 |
|---|---|---|
| `true` | `SUM` | `net_revenue` |
| `"sketch"` | `HLL_COUNT.MERGE_PARTIAL` | `buyer_count` |

`buyer_count` 를 `SUM` 으로 rollup 하면 틀린다. 같은 사람이 여러 category 에서 사면
두 번 세어지기 때문이다.

**시간 방향은 rollup 이라고 부르지 않는다.** 일자별을 월 단위로 합치는 것은 PTD 이고,
코드에서도 단계가 나뉘어 있다 — rollup 단계는 dimension 만, `cum` 단계가 시간을 다룬다.

### serving_dims 를 어떻게 고르나

`dims` 전부를 쓰지 않는 이유는 `grid` 때문이다. `grid` 는 활동이 없는 날도 행으로
만들므로 행 수가 **(dimension 조합 수 × 날짜 수)** 로만 정해진다. 원본이 몇 행이든
상관없다.

```
dims 7개 전부      조합 27,749 × 2,811일 = 7,800만 행
serving_dims 4개   조합    720 × 2,811일 =  202만 행   → rollup 행까지 480만
```

`category` 하나(값 26개)만 넣어도 26배가 된다.

그래서 entity 를 가로지르는 conformed dimension 을 남긴다. 서로 다른 fact 의 지표를
나란히 놓을 수 있는 dimension 이기 때문이다.

| entity | `serving_dims` | 조합 | rollup 포함 |
|---|---|---|---|
| `order_item` · `order` | `country` · `age_group` · `gender` · `acquisition_channel` | 720 | 1,708 |
| `session` | `country` · `acquisition_channel` | 68 | 89 |
| `user_event` | `country` | 15 | 16 |

여기 없는 dimension 별 집계는 `daily_` 에서 직접 계산한다.

```sql
SELECT category, SUM(net_revenue) AS mtd
FROM semantic.daily_net_revenue
WHERE record_date BETWEEN DATE_TRUNC(@d, MONTH) AND @d
GROUP BY category
```

## 3. 지표 테이블 3단계

| 용어 | 뜻 |
|---|---|
| **`daily_<metric>`** | 1단계. `record_date × dims 전체` 집계. 조인이 실행되는 유일한 곳 |
| **`period_<metric>`** | 2단계. dimension 을 `serving_dims` 로 좁히고 rollup 행과 PTD 컬럼을 붙인 것 |
| **`metric_<metric>`** | 3단계. `period_` 에 비교 기준값을 붙인 것. 소비자가 읽는 테이블 |
| **`metric_registry`** | 지표 카탈로그. 선언을 테이블로 만든 것 |

## 4. 컬럼

| 용어 | 뜻 |
|---|---|
| **`record_date`** | 세 단계가 공유하는 날짜 컬럼. `daily` 값에서는 그날, 누계에서는 기간의 마지막 날 |
| **`serving_dims`** | `period_`·`metric_` 이 갖는 dimension 목록. `dims` 의 부분집합이고 `entities.js` 에 entity 별로 선언한다. 여기 없는 dimension 은 컬럼 자체가 생기지 않는다 |
| **`'(all)'`** | 그 dimension 을 rollup 한 행임을 나타내는 특수값 |
| **`'(unknown)'`** | 그 dimension 의 값이 없는 bucket. `daily_` 의 `NULL` 이 여기로 온다 |
| **PTD** | period-to-date. 기간 시작부터 `record_date` 까지의 누계. 본문에서 약어로 쓴다 |
| **`wtd` · `mtd` · `ytd`** | 주·월·연 PTD. 값 컬럼은 `<metric>_wtd` 처럼 접미어가 붙는다 |
| **`is_week_end` · `is_month_end` · `is_year_end`** | 이 날이 그 기간의 마지막 날인가. 완결된 기간만 보고 싶을 때 건다 |
| **`dod` · `wow` · `mom` · `yoy`** | day/week/month/year over year. 비교 라벨 |
| **`_base` 컬럼** | 비교 기준 시점의 **값**. 증감률이 아니다. `yoy_base`, `mtd_yoy_base` |
| **HLL sketch** | `HLL_COUNT.INIT` 이 만든 중간 상태(`BYTES`). 병합할 수 있어서 distinct 를 다시 집계할 수 있다 |
| **precision** | HLL 의 정밀도. 15 로 고정한다. 바꾸면 과거 sketch 와 병합할 수 없다 |

**컬럼 이름 규칙 — 기간 접두어가 없으면 `daily` 다.**

```
net_revenue        net_revenue_wtd
wow_base           wtd_wow_base
```

## 5. 코드 안의 이름

문서에서 이 단계들을 부를 때는 **코드에 있는 이름을 그대로 쓴다.**

| 이름 | 무엇 |
|---|---|
| **`daily`** | `periodSQL` 의 첫 CTE. `daily_<metric>` 을 그대로 읽는다 |
| **`base`** | `daily` 를 `serving_dims` 로 집계한 CTE. rollup 행은 아직 없다 |
| **`grid`** | `sem_dim_date` 와 `base` 의 dimension 조합을 모두 교차시켜, 활동이 없는 날도 행으로 만든 CTE |
| **`cum`** | `grid` 위에서 PTD 를 계산한 CTE |
| **rollup 단계** | `cum` 뒤의 마지막 `SELECT`. `axis_mask` 로 `'(all)'` 행을 만든다 |
| **`axis_mask`** | rollup 단계가 붙이는 정수. 비트가 0인 dimension 이 `'(all)'` 이 된다 |
| **builder** | `includes/build.js`. 선언을 읽어 SQL 문자열을 만든다 |
| **generator** | `definitions/**/gen_*.js`. builder 를 불러 Dataform action 을 만든다 |
| **join graph** | `entities.js` 의 `joins` + `dims`. 어느 dimension 에 어떤 경로로 닿는지의 선언 |
| **`reprocess_from`** | 증분 갱신이 다시 만들 구간의 시작일. `preOps` 의 `DECLARE` 로 고정한다 |
| **`LOOKBACK_DAYS`** | 증분 갱신이 거슬러 올라가는 일수. 현재 3 |

## 6. 실행과 운영

| 용어 | 뜻 |
|---|---|
| **action** | Dataform 이 실행하는 단위 하나. 테이블 생성, assertion, operation |
| **assertion** | 조건을 어긴 행을 뽑는 쿼리. 한 행이라도 나오면 실패다 |
| **게이트 assertion** | 깨지면 파이프라인을 멈추는 것. 우리가 보증하는 내용 |
| **감시 assertion** | 깨져도 멈추지 않는 것. 상류(DW)가 어긴 내용이라 우리가 고칠 수 없다 |
| **incremental** | 최근 구간만 다시 만드는 갱신 방식 |
| **insert_overwrite** | 구간을 `DELETE` 하고 다시 `INSERT` 하는 증분 방식. `MERGE` 는 옛 행을 남겨서 쓰지 않는다 |
| **full refresh** | 테이블을 전부 다시 만드는 것. `--full-refresh` |
| **release configuration** | Dataform 이 어느 커밋을 언제 컴파일할지의 설정 |
| **workflow configuration** | 컴파일 결과를 어느 태그로 언제 어떤 계정으로 실행할지의 설정 |
| **partition** | BigQuery 가 테이블을 날짜로 나눠 저장하는 것. 조회 시 읽는 양이 준다 |
| **CTE** | `WITH` 로 이름 붙인 서브쿼리. 결과를 저장하지 않아 여러 번 참조하면 그만큼 다시 계산된다 |

## 7. 원칙 번호

`docs/principles.md` 의 **P1~P22**. 세부 항목은 `P6-1` 처럼 하이픈을 붙인다.
문서에서 인용할 때는 번호만 쓰지 말고 **무엇에 대한 원칙인지 한 마디를 같이 쓴다.**

```
(X)  grid 를 채운다 (P15)
(O)  PTD 는 활동이 없는 날도 행으로 만들어야 rollup 했을 때 맞는다 (P15)
```

---

## 쓰지 않는 말

문서와 코드 주석에서 아래 표현을 쓰지 않는다. 오른쪽이 대신 쓸 말이다.

| 쓰지 않는다 | 대신 |
|---|---|
| 접다 · 접기 · 걷다 · 걷어내다 | **rollup** |
| 차원 | **dimension** |
| 축 (dimension 을 가리킬 때) | **dimension**. 합산 방향을 뜻할 때만 "축"을 쓴다 |
| 겹 (단계를 가리킬 때) | **단계** |
| 격자 | **`grid`** (CTE 이름) |
| 기저 조합 | **`base`** (CTE 이름) |
| 뼈대 · 스파인 | **기준 날짜 목록** 또는 `sem_dim_date` |
| 폴백 | **fallback** |
| 물화 · 물화한다 | **테이블로 저장한다** |
| 원자 fact | **atomic fact** |
| sentinel | **특수값** |
| 창고 | **DW** 또는 **warehouse** |
| 살아남는다 (remaining 의 직역) | **남는다** · **그대로 둔다** |

새 단어가 필요하면 **이 문서에 먼저 추가하고 쓴다.**
