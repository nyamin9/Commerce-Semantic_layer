// 상류(DW) 계약 감시. 게이트가 아니라 감시다 (P20).
//
// 여기서 깨지는 것은 우리가 고칠 수 없다. 원인은 dbt-airflow 쪽에 있고,
// 우리가 할 일은 보고하는 것이다. 그래서 마트 자체 assertion 과 태그를 나눈다.
//
//   tags: ["mart"]        마트가 보장하는 것. 깨지면 파이프라인을 멈춘다
//   tags: ["monitoring"]  상류가 어긴 것. 별도 워크플로로 돌려 보고만 한다
//
// 알려진 결함은 우회하지 않고 기록한다 (P21). 조용한 우회는 문제를 숨긴다.
// 항목 번호는 docs/principles.md 5장과 같다.

const monitor = (name, description, query) =>
  assert(name)
    .tags(["monitoring", "upstream"])
    .description(description)
    .query(query);

// 결함 1 — 소스가 ID를 재사용해 자연키가 유일하지 않다.
// 마트에서 자연키를 제거해 대응했으므로(P2) 규모만 추적한다.
monitor(
  "upstream_natural_key_reuse",
  "결함 1. order_id / order_item_id 가 재사용되어 중복된다",
  (ctx) => `
SELECT 'order_id' AS natural_key, COUNT(*) - COUNT(DISTINCT order_id) AS duplicate_rows
FROM ${ctx.ref("fct_orders")}
HAVING duplicate_rows > 0
UNION ALL
SELECT 'order_item_id', COUNT(*) - COUNT(DISTINCT order_item_id)
FROM ${ctx.ref("fct_order_items")}
HAVING COUNT(*) - COUNT(DISTINCT order_item_id) > 0`
);

// 결함 2 — 최근 구간의 order_key 가 NULL 이면 주문 단위 조인이 끊긴다.
// 2026-08 관측 시 1,673행이었고 이후 backfill 로 해소되었다. 재발을 본다.
monitor(
  "upstream_order_key_null",
  "결함 2. fct_order_items.order_key 가 NULL 인 행",
  (ctx) => `
SELECT MIN(ordered_date) AS first_date, MAX(ordered_date) AS last_date, COUNT(*) AS null_rows
FROM ${ctx.ref("fct_order_items")}
WHERE order_key IS NULL
HAVING null_rows > 0`
);

// 결함 3 — line item 이 하나도 없는 주문. 두 fact 의 정합이 어긋난다.
monitor(
  "upstream_orders_without_items",
  "결함 3. sem_fct_orders 에 있으나 line item 이 없는 주문",
  (ctx) => `
SELECT o.order_status, COUNT(*) AS orders, MIN(o.ordered_date) AS first_date, MAX(o.ordered_date) AS last_date
FROM ${ctx.ref("fct_orders")} AS o
LEFT JOIN (SELECT DISTINCT order_key FROM ${ctx.ref("fct_order_items")} WHERE order_key IS NOT NULL) AS i
  USING (order_key)
WHERE i.order_key IS NULL
GROUP BY o.order_status
HAVING orders > 0`
);

// 결함 4 — fct_orders 적재가 fct_order_items 보다 뒤처지면
// 주문 grain 지표(order_count 등)의 최근 구간이 결측된다.
monitor(
  "upstream_orders_load_lag",
  "결함 4. fct_orders 가 fct_order_items 보다 2일 넘게 뒤처졌다",
  (ctx) => `
WITH edge AS (
  SELECT
    (SELECT MAX(ordered_date) FROM ${ctx.ref("fct_order_items")}) AS items_max,
    (SELECT MAX(ordered_date) FROM ${ctx.ref("fct_orders")})      AS orders_max
)
SELECT items_max, orders_max, DATE_DIFF(items_max, orders_max, DAY) AS lag_days
FROM edge
WHERE DATE_DIFF(items_max, orders_max, DAY) > 2`
);

// 결함 7 — 퍼널 플래그가 이름대로 동작하지 않는다.
// 마트에서 해당 컬럼을 제외해 대응했으므로 원인 해소 여부만 본다.
monitor(
  "upstream_session_funnel_flags",
  "결함 7. purchased 인데 viewed_product 가 아닌 세션",
  (ctx) => `
SELECT
  COUNTIF(purchased AND NOT viewed_product) AS purchased_not_viewed,
  ROUND(100 * COUNTIF(purchased) / COUNT(*), 1) AS purchase_rate_pct
FROM ${ctx.ref("fct_sessions")}
HAVING purchased_not_viewed > 0`
);
