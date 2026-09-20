// 마트의 파티션 컬럼이 entities.js 의 date_col 과 같은지 검사한다.
//
// 둘은 나란히 적힌 독립 선언이다. 어느 쪽도 상대를 읽지 않는다.
//
//   entities.js   date_col: "ordered_date"      build.js 가 daily_ 의 날짜 축과
//                                               증분 WHERE·경계에 쓴다
//   *.sqlx        partitionBy: "ordered_date"   물리 저장 설정
//
// 둘이 어긋나면 증분의 `WHERE base.ordered_date >= ...` 가 파티션을 걸러내지
// 못해 매번 전체를 읽는다. 결과는 맞고 비용만 는다 — 에러도 안 나고 값 검증에도
// 안 걸린다. 실측으로 프루닝 여부에 따라 15,896 B 대 3,000,288 B 였다 (189배).
//
// 그래서 구조로 묶는 대신 감시한다. 마트가 entities.js 를 참조하게 만들면 상류가
// 하류를 읽게 되고, 마트를 다른 팀이 소유하는 경우 결합이 조직 경계를 넘는다.
//
// 게이트다 (P20). 우리가 만든 테이블이고 우리가 고칠 수 있으므로 깨지면 멈춘다.

const { ENTITIES }       = require("includes/entities");
const { DATASETS, TAGS } = require("includes/naming");

// entity 가 쓰는 마트 테이블과 그 날짜 컬럼. sem_dim_* 은 entity 가 아니라 빠진다
const CONTRACT = Object.values(ENTITIES).map((e) => ({
  table: e.source,
  declared: e.date_col,
}));

assert("mart_partition_matches_date_col")
  .tags([TAGS.MART, "contract"])
  .description("마트의 파티션 컬럼이 entities.js 의 date_col 과 다른 테이블")
  // 마트가 만들어진 뒤에 돌아야 한다. INFORMATION_SCHEMA 를 읽으므로 ref() 로
  // 의존이 잡히지 않아 직접 건다
  .dependencies(CONTRACT.map((c) => c.table))
  .query((ctx) => `
WITH declared AS (
  SELECT * FROM UNNEST([
${CONTRACT.map((c) => `    STRUCT('${c.table}' AS table_name, '${c.declared}' AS date_col)`).join(",\n")}
  ])
),
actual AS (
  SELECT table_name, column_name AS partitioning_column
  FROM \`${ctx.database()}.${DATASETS.MART}.INFORMATION_SCHEMA.COLUMNS\`
  WHERE is_partitioning_column = 'YES'
)
SELECT d.table_name, d.date_col AS declared_in_entities_js, a.partitioning_column AS actual
FROM declared d
LEFT JOIN actual a USING (table_name)
WHERE a.partitioning_column IS NULL
   OR a.partitioning_column != d.date_col`);
