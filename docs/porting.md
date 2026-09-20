# 다른 프로젝트로 옮기기

이 레포의 무엇이 어디서나 통하고 무엇이 이 데이터셋에만 해당하는지.
용어는 [glossary.md](glossary.md) 를 따른다.

네 갈래로 나뉜다.

| | |
|---|---|
| **A. 설계** | 엔진과 데이터가 달라도 그대로 통한다. 옮길 가치가 있는 것은 이쪽이다 |
| **B. 선언** | 갈아끼운다. 새 프로젝트의 fact 와 지표를 적으면 된다 |
| **C. 엔진** | BigQuery·Dataform 에 묶여 있다. 다른 엔진이면 다시 재야 한다 |
| **D. 서빙 레이어** | Cube·Looker 위로 옮길 때 `serving_dims` 가 무엇이 되는가 |

---

## A. 설계 — 어디서나 통하는 것

### A-1. 테이블을 3단계로 나눈다

```
1단계  원자 집계   조인을 실행한다. dimension 을 전부 갖는다
2단계  기간 확장   dimension 을 좁히고 PTD 와 rollup 행을 만든다
3단계  비교        2단계를 시프트해 self-join 한다
```

**셋 다 테이블로 저장한다.** 한 쿼리에 넣으면 같은 집계가 여러 번 돈다. 2단계를
3단계 안의 서브쿼리로 두면 self-join 수만큼 다시 계산된다.

**1단계를 따로 두는 이유는 조인이다.** 2단계 이후는 1단계만 읽으므로 fact 와
dimension 을 다시 읽지 않는다. dimension 을 추가해도 fact 를 다시 만들 필요가 없다.

### A-2. 지표를 선언으로 쓰고 SQL 을 생성한다

```
선언 1항목  →  테이블 3개 + 카탈로그 1행
```

사람이 쓰는 집계 SQL 이 0개가 되는 것이 목표다. 손으로 쓰면 지표당 모델 여러 개를
만들고 비교 로직을 복사하게 되는데, 복사한 쪽과 원본이 어긋나도 에러가 나지 않는다.

선언에 담을 것은 이만큼이다.

```
entity      어느 fact 에서 나오는가
expr        집계식
filter      집계 전 행 필터 (선택)
dims        쓸 수 있는 dimension
additive    축별 가산성
```

### A-3. `additive` 를 축별로 선언한다

플래그 하나가 아니라 **축마다** 선언한다. 같은 지표라도 축에 따라 다르기 때문이다.

```
true      그 축으로 합산 가능
"sketch"  병합 가능한 중간 상태로 저장
"last"    스냅샷. 마지막 값
false     복원 불가
```

이 선언 하나가 rollup 함수와 PTD 계산 방법을 동시에 정한다. 사람이 `SUM` 인지
`MERGE` 인지 고르지 않는다.

**dimension 축에 `false` 가 나오면 entity 가 틀린 것이다.** 기록할 사실이 아니라
고칠 신호로 다룬다.

잘못 선언하면 `SUM` 이 선택되어 distinct count 가 부푼다 — 에러는 나지 않고 숫자만
틀린다 ([findings.md](findings.md) 11).

### A-4. entity 는 fact 이고 grain 은 바뀌지 않는다

fact 하나가 entity 하나다. entity 가 정해지면 grain 과 쓸 수 있는 dimension 이 따라서
정해진다. **한 entity 안에서 grain 을 섞지 않는다.**

주문 grain 에 상품 dimension 이 없는 것은 누락이 아니다. 한 주문이 여러 상품을
포함하므로 그 grain 에서 category 가 정의되지 않는다. 이 빈자리가 "주문 수를 어느
entity 에 둘 것인가" 의 답이 된다.

### A-5. 서빙 grain 을 따로 둔다

1단계는 dimension 을 전부 갖고, 2단계는 그 부분집합만 갖는다.

2단계가 전부를 못 쓰는 이유는 A-6 의 빈 날 채우기 때문이다. 행 수가
**(dimension 조합 수 × 날짜 수)** 로만 정해지므로 조합이 늘면 그대로 곱해진다.

고르는 기준은 **고유값이 적고 entity 를 가로지르는 dimension**(conformed dimension)이다.
서로 다른 fact 의 지표를 나란히 놓을 수 있는 축이기 때문이다.

고유값이 많은 dimension 은 연 단위로 집계해도 행이 거의 줄지 않는다. 값이 2개인
dimension 도 조합을 3배로 만든다 ([findings.md](findings.md) 2).

**넣기 전에 셋을 확인한다.**

| | 기준 |
|---|---|
| dimension 고유값 | 10개 이하 |
| 조합 수 | 1,500 내외 |
| distinct 근사 지표의 누계를 **실제로 돌려본다** | dry run 으로는 안 잡힌다 |

세 번째가 핵심이다. 이 프로젝트에서 가장 아팠던 것이 전부 거기였고, 컴파일로도
dry run 으로도 미리 잡히지 않았다.

### A-6. PTD 는 빈 날을 채운 위에서 계산한다

활동이 있는 날에만 PTD 행을 만들면 **rollup 했을 때 대부분이 사라진다.**

빈 날을 채우지 않으면 rollup 한 값이 실제의 13% 가 나온다. 그날 활동이 없던 조합의
앞 구간이 통째로 빠지기 때문이다 ([findings.md](findings.md) 4).

```
1) 날짜 × dimension 조합을 모두 만든다
2) 값을 붙인다. 없으면 0 (가산) 또는 NULL (sketch)
3) 그 위에 누적한다
```

**날짜는 날짜 dimension 테이블에서 가져온다.** 집계 결과의 날짜를 쓰면 전사적으로
활동이 0인 날이 빠져 PTD 가 끊긴다.

**범위는 실제 데이터가 있는 구간으로 자른다.** 그러지 않으면 미래 날짜에 행이 생긴다.

### A-7. rollup 보다 PTD 를 먼저 계산한다

순서를 바꿔도 값은 같다. 합산은 결합법칙이 성립하고 HLL 병합은 합집합이다.

**비용은 다르다.** rollup 을 먼저 하면 `'(all)'` 행의 sketch 가 조밀해지는데, sketch PTD 는
구간을 self-join 해서 병합하므로 그 조밀한 sketch 를 날마다 수백 번 읽는다.

rollup 을 먼저 하면 CPU 한도에 걸려 생성 자체가 실패한다 ([findings.md](findings.md) 6).

### A-8. 완결된 기간을 따로 만들지 않는다

`weekly`·`monthly`·`yearly` 는 PTD 와 값이 같다. 기간의 마지막 날인지를 표시하는
플래그 하나면 된다.

```
monthly  =  mtd  where is_month_end
```

행으로 따로 두면 값이 중복되고, 진행 중인 기간이 아직 오지 않은 날짜를 달게 된다.
그 행의 비교 기준값은 4일치를 7일 전체와 맞대는 식으로 틀린다.

### A-9. 비교는 증감률이 아니라 기준값을 저장한다

비율을 저장하면 rollup 할 때 깨진다. `AVG` 도 `SUM` 도 틀린 값을 낸다.
시프트한 시점의 **값**을 복사해 두고 나눗셈은 조회 시점에 한다.

**self-join 은 간격 단위로 묶는다.** 비교 컬럼이 8개라도 서로 다른 간격이 5개면
조인은 5번이다.

**주 단위 비교의 전년 시프트는 364일이다.** 1년으로 시프트하면 요일이 어긋난다.

### A-10. 선언 오류는 컴파일 타임에 거부한다

런타임에 틀린 숫자가 나오는 것보다 생성을 거부하는 쪽이 낫다.

```
미선언 dimension 사용         예외
additive 키 누락              예외
dimension 축이 false          예외
조인 이름이 SQL 예약어        예외
지표 수식의 중괄호가 안 닫힘   예외
```

빈 테이블을 만들지 않는 것도 같은 이유다. 빈 테이블이 남으면 소비자가 "값이 0" 으로
오해한다.

### A-11. 증분은 구간을 지우고 다시 넣는다

`MERGE` 는 지우지 않는다. dimension 값이 바뀌면 키가 달라져 옛 행이 매칭되지 않고
그대로 남는다. 키는 여전히 유일하므로 `uniqueKey` 검사도 통과한다.

상류를 최신화하고 `MERGE` 증분을 돌리면 남은 옛 행이 합계를 부풀린다
([findings.md](findings.md) 9).

**증분 구간은 상류가 정한다.** 상류가 최근 N일을 덮어쓰면 우리도 N일을 다시 읽는다.
상류보다 촘촘하게 잡아도 이득이 없고, 넓게 잡으면 다시 읽기만 한다.

**상류가 전체를 다시 만드는 fact 위에는 증분을 올리지 않는다.** 과거 구간의 변경을
놓친다.

### A-12. 상류에 건 검사는 게이트가 아니라 감시다

우리가 고칠 수 없는 것은 파이프라인을 멈추게 하지 않는다. 별도 워크플로로 돌려
보고만 한다. 알려진 결함은 우회하지 말고 기록한다 — 조용한 우회는 문제를 숨긴다.

### A-13. 나란히 적힌 선언은 구조로 묶지 말고 감시한다

같은 값이 두 곳에 적히는데 한쪽이 다른 쪽을 읽을 수 없는 경우가 있다. 이 레포에는
둘 있다.

| 두 곳 | 어긋나면 |
|---|---|
| `entities.js` 의 `date_col` ↔ 마트의 `partitionBy` | 증분이 파티션을 못 걸러 느려진다. 값은 맞다 |
| 액션의 `tags` ↔ 실행 설정의 `includedTags` | 0개 액션으로 성공한다. 알림도 없다 |

**구조로 묶고 싶어지지만 방향을 보면 안 된다.** 마트가 `entities.js` 를 참조하게 만들면
상류가 하류를 읽게 되고, 마트를 다른 팀이 소유하면 결합이 조직 경계를 넘는다.

대신 **양쪽을 다 읽을 수 있는 제3자가 대조한다.**

```
파티션   assertion 이 INFORMATION_SCHEMA 와 entities.js 를 대조    게이트
태그     apply.js 가 컴파일 그래프와 workflows.json 을 대조        적용 전 거부
```

옮길 때도 같은 원칙을 쓴다 — 선언을 합치기 전에 **누가 누구를 읽어야 하는지**를 먼저 본다.

---

## B. 선언 — 갈아끼우는 것

새 프로젝트에서 실제로 쓰는 파일은 이만큼이다.

| 파일 | 무엇을 적나 |
|---|---|
| `workflow_settings.yaml` | 프로젝트 ID · 리전 · `dataformCoreVersion` · 상류 데이터셋 |
| `includes/naming.js` 의 `DATASETS` | 우리가 만드는 데이터셋 3개. 각 파일은 `schema` 를 명시하고 값은 여기 |
| `includes/naming.js` 의 `TAGS` | 태그 이름. `infra/apply.js` 가 이것으로 `workflows.json` 을 검증한다 |
| `definitions/sources/declarations.js` | 읽을 상류 테이블 목록 |
| `definitions/mart/*.sqlx` | 상류를 정규화한 중간 테이블. **사람이 SQL 을 쓰는 유일한 곳** |
| `includes/entities.js` | fact 마다 `source` · `pk` · `date_col` · `grain` · `joins` · `dims` · `serving_dims` · `refresh` |
| `includes/metrics.js` | 지표 목록 |
| `definitions/assertions/*.js` | 상류 감시 |
| `infra/workflows.json` | 스케줄 · 태그 · 실행 계정 |

**거의 그대로 쓰는 것**

| 파일 | 손볼 곳 |
|---|---|
| `includes/naming.js` | `DATASETS` · `TAGS` · 접두사 |
| `includes/periods.js` | 기간이 다르면. 대개 그대로 |
| `includes/build.js` | 없음 |
| `definitions/semantic/gen_*.js` | 없음 |
| `definitions/metadata/gen_registry.js` | 없음 |

### 옮기는 순서

```
1. workflow_settings.yaml 과 declarations.js        상류를 읽을 수 있게
2. mart/*.sqlx                                      surrogate key 와 grain 을 보증
3. entities.js 에 entity 하나                        가장 중요한 fact 부터
4. metrics.js 에 지표 하나                           끝까지 돌려본다
5. serving_dims 를 정한다                            조합 수 × 날짜 수를 먼저 세어본다
6. 나머지 entity 와 지표를 채운다
7. infra/workflows.json                             스케줄
```

**4번까지를 먼저 끝낸다.** 지표 하나가 3단계를 모두 통과하는 것을 확인한 뒤에
나머지를 채우는 편이 빠르다.

**5번에서 반드시 조합 수를 세어본다.** `serving_dims` 후보의 고유값을 곱하고 날짜 수를
곱하면 2단계 테이블의 행 수가 나온다. 이 숫자가 감당되는지가 설계의 분기점이다.

---

## C. 엔진 — 옮기면 다시 재야 하는 것

**이 절이 이 문서의 핵심이다.** 컴파일로도 dry run 으로도 미리 잡히지 않는 것이
섞여 있다. 숫자는 [findings.md](findings.md) 에 있다.

### C-1. BigQuery

| 제약 | 증상 | 대응 |
|---|---|---|
| **`CUBE` 를 다른 grouping element 와 못 섞는다** | `GROUP BY record_date, CUBE(...)` 가 *"only supports CUBE when there are no other grouping elements"* 로 거부 | 부분집합을 직접 펼치거나 마스크를 쓴다 |
| **`GROUPING SETS` 가 집합마다 입력을 다시 읽는다** | dimension 4개면 16번. 입력에 self-join 이 있으면 CPU 한도 초과 | 마스크를 `CROSS JOIN` 으로 붙여 입력을 한 번만 읽는다 |
| **`IS NOT DISTINCT FROM` 이 해시 조인 키가 못 된다** | 일반 술어로 취급되어 중첩 루프가 된다. 구간 self-join 에서 CPU 한도 초과 | `NULL` 을 값으로 바꿔 `=` 로 조인한다 |
| **`HLL_COUNT.MERGE_PARTIAL` 이 analytic function 을 지원하지 않는다** | dry run 통과, 실행에서 `Analytic function MERGE_PARTIAL is not supported` | 창 함수 대신 구간 self-join |
| **on-demand 의 CPU/바이트 비율 제한** | 스캔이 작아도 CPU 를 많이 쓰면 거부한다 | 중간 결과를 테이블로 저장해 재계산을 없앤다 |
| **파티션 컬럼을 바꿀 수 없다** | `CREATE OR REPLACE` 가 *"Cannot replace a table with a different partitioning spec"* 로 거부 | 테이블을 지우고 다시 만든다 |
| **예약어 78개** | 조인 이름이 `order`·`cube` 면 생성된 SQL 이 깨진다 | 컴파일 타임에 거부한다 |
| **`DATE_SUB` 이 월말을 보정한다** | `2026-03-31 - 1 MONTH = 2026-02-28`. 3/30 과 3/31 이 둘 다 2/28 로 간다 | 월말 며칠의 전월 비교는 이 성질을 알고 본다 |
| **HLL precision** | 바꾸면 과거 sketch 와 병합할 수 없다 | 처음에 정하고 고정한다. 이 레포는 15 |

**다른 엔진으로 옮길 때 확인할 것**

```
GROUPING SETS / CUBE 의 재계산 여부      → 마스크 방식이 필요한가
NULL-safe 조인이 해시 조인이 되는가      → '(unknown)' bucket 이 필요한가
distinct 근사 자료구조의 이름과 정밀도   → HLL 대신 무엇이 있는가
그 자료구조를 창 함수에서 쓸 수 있는가   → 구간 self-join 이 필요한가
파티션 정의를 바꿀 수 있는가             → 스키마 변경 절차
```

### C-2. Dataform

| 성질 | 무엇 |
|---|---|
| **CTE 는 결과를 저장하지 않는다** | 여러 번 참조하면 그만큼 다시 계산된다. 단계를 테이블로 쪼개는 근거 |
| **`ctx.ref()` 가 의존 관계를 등록한다** | builder 가 프로젝트 이름도 데이터셋 이름도 모른다 |
| **`preOps` 로 `DECLARE` 와 `DELETE` 를 넣는다** | insert_overwrite 를 구현하는 방법 |
| **`uniqueKey` 를 주면 `MERGE` 를 쓴다** | 쓰지 않는다. `preOps` 로 직접 구간을 지운다 |
| **컴파일 타임 도구다** | 런타임에 SQL 을 조립하지 않는다. 선언한 조합 안에서만 움직인다 |
| **release / workflow configuration 은 git 에 없다** | GCP 리소스다. 선언 파일을 따로 두고 스크립트로 맞춘다 |

**dbt 로 옮긴다면** — 3단계 분리는 모델 3개로, `additive` 선언은 매크로로, generator 는
Jinja 루프로 바뀐다. 설계(A)는 그대로 통하고, CTE 재계산 문제도 같은 방식으로 나타난다.
dbt 역시 컴파일 타임 도구라 자동 라우팅은 없다.

---

## D. 서빙 레이어가 있는 환경으로 옮긴다면

`entities.js` 와 `metrics.js` 는 거의 그대로 옮겨간다. **`serving_dims` 만 성격이 바뀐다.**

```
entities.js   →  Cube 의 cubes · joins · dimensions
metrics.js    →  Cube 의 measures
periods.js    →  granularity · 시간 비교 설정
serving_dims  →  대응 개념이 없다. preAggregations 선언이 된다
```

### 사전 집계는 자동으로 만들어지지 않는다

Cube 든 Looker 든 **어떤 사전 집계를 만들지는 손으로 선언한다.** 자동인 것은 선택이다 —
쿼리가 들어오면 맞는 것을 고르고, 없으면 원본으로 간다.

```js
// Cube. a×b 와 a×c 가 필요하면 두 블록을 직접 쓴다
preAggregations: {
  byCountryAndType: { measures: [...], dimensions: [CUBE.country, CUBE.purchaseType], ... },
  byCategory:       { measures: [...], dimensions: [CUBE.category], ... },
}
```

`a × b × c × d` 의 모든 부분집합이 알아서 생기지는 않는다. 조합 폭발이라 어떤 도구도
그렇게 하지 않는다. 다만 실제 쿼리 로그를 보고 후보를 **추천**하는 기능은 있다 —
Cube 의 Rollup Designer, Looker 의 Aggregate Awareness Recommendations.

### 그래서 여러 개를 두는 것이 싸진다

```
큐브 하나        a × b × c × d       모든 조합. 이 레포의 방식
rollup 여러 개   a×b · a×c · b×d     실제로 쓰는 것만. 나머지는 원본으로 간다
```

**fallback 이 있어서 다 안 만들어도 되는 것이다.** 이 레포는 자동 라우팅이 없어서
안 만든 조합에 답이 없고, 그래서 전부 만들어야 한다. dimension 하나가 행 수를
곱하는 이유가 여기에 있다.

### 이 레포에서 쪼개려면

기술적으로는 가능하다. `metrics.js` 에 지표별 `serving_dims` 를 적으면 그 지표의
큐브만 좁아진다. 한 지표에 rollup 을 여럿 두려면 generator 를 손봐야 한다.

**다만 소비자가 어느 테이블을 읽을지 알아야 한다.** 쿼리를 보고 골라주는 계층이
없어서 view 로도 못 가린다 — view 는 들어온 쿼리에 따라 대상을 바꾸지 못하고,
`UNION` 으로 묶으면 전부 스캔해 쪼갠 의미가 없다.

그래서 순서가 중요하다. **소비자에게 열기 전에 쪼개면 마이그레이션 비용이 0이다.**

```
1. 넓게 만든다
2. 분석가 몇 명에게 먼저 연다          ← 쿼리 로그가 여기서 생긴다
3. INFORMATION_SCHEMA.JOBS 로 실제 조합을 센다
4. 그 근거로 쪼갠다
5. 전사에 연다
```

2번을 건너뛰면 4번을 감으로 하게 된다.

## 옮길 때 처음에 정할 것 세 가지

가장 되돌리기 어려운 순서다.

**하나 — `serving_dims`.** 2단계 테이블의 행 수를 결정한다. 나중에 넓히면 재생성
비용이 크고, 좁히면 그 dimension 으로 보던 것을 잃는다. 조합 수를 미리 세어본다.

**둘 — distinct 근사의 정밀도.** 바꾸면 과거 데이터와 병합할 수 없다.

**셋 — 날짜 컬럼 이름과 파티션.** 파티션 컬럼은 나중에 못 바꾼다. 3단계가 같은 이름을
쓰도록 처음에 정한다.

---

**다음으로 읽을 것**

| | |
|---|---|
| 왜 이 구조인가 | [architecture.md](architecture.md) |
| 파일별 역할 | [code-map.md](code-map.md) |
| 테이블 구조 | [tables.md](tables.md) |
| 판단 기준 P1~P22 | [principles.md](principles.md) |
| 실측과 실패 기록 | [findings.md](findings.md) |
