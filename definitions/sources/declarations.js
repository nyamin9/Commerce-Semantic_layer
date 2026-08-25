// semantic layer가 참조할 기존 테이블 declaration.
//
// 변환(transformation)은 dbt-airflow에서 처리하고, 이 레포는 semantic layer만 담당한다.
// 따라서 Dataform은 아래 테이블들을 만들지 않고 ref()로 읽기만 한다.
// staging 레이어는 물리 테이블이 아니라 view라서 등록하지 않는다.

const { dwDataset, snapshotDataset } = dataform.projectConfig.vars;

const SOURCES = {
  // semantic layer의 소스가 되는 DW 레이어
  [dwDataset]: [
    "dim_users",
    "dim_products",
    "dim_products_history",
    "dim_distribution_centers",
    "fct_order_items",
    "fct_orders",
    "fct_sessions",
    "fct_user_events",
  ],

  // dbt snapshot 원본. dim_products_history의 소스라서 보통 직접 읽을 일은 없다.
  [snapshotDataset]: ["snap_products"],
};

Object.entries(SOURCES).forEach(([schema, tables]) => {
  tables.forEach((name) => declare({ schema, name }));
});
