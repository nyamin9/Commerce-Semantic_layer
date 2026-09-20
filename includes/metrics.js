// 지표 선언. 새 지표가 기존 fact 위에 있으면 만지는 파일은 여기 하나다 (P8).
//
// additive는 플래그가 아니라 축별 객체다 (P9). 같은 함수라도 축에 따라 다르다.
//   true      그 축으로 가산            → SUM
//   "sketch"  병합 가능한 중간 상태      → HLL_COUNT.MERGE_PARTIAL
//   "last"    스냅샷 (재고·잔액)         → 마지막 값
//   false     복원 불가                 → rollup 생성을 거부한다 (P18)
//
// 축에 false가 나오면 기록할 사실이 아니라 고칠 신호다 — entity가 틀렸다 (P10).
//
// dimension 은 entity 가 정한다. 지표가 좁힐 수 없다 — daily_ 가 fallback 계층이라
// 여기서 빼면 복원이 안 된다. period_·metric_ 의 dimension 만 좁히려면 serving_dims 를 쓴다.
//
//   buyer_count: { serving_dims: ["country", "purchase_type"] }
//   → daily_ 는 dimension 전체, period_·metric_ 만 2개
//
// expr·filter 의 컬럼은 중괄호로 표시한다 (P5).
//   {sale_price}         fact 컬럼
//   {product.unit_cost}  entities.js 의 joins 에 선언된 이름으로 참조
// 중괄호 밖은 builder 가 건드리지 않으므로 어떤 SQL이든 그대로 쓸 수 있다.

const { allDims } = require("includes/entities");

// 전 축 동일한 가산성을 축별 객체로 펼친다. 선언을 짧게 유지하면서
// 저장되는 형태는 축별로 남는다.
const uniform = (entity, value) => {
  const acc = { time: value };
  for (const d of allDims(entity)) acc[d] = value;
  return acc;
};

const HLL_PRECISION = 15;   // 고정. 바꾸면 과거 sketch 와 병합할 수 없다
const hll = (col) => `HLL_COUNT.INIT({${col}}, ${HLL_PRECISION})`;

const METRICS = {
  // ── order_item ──────────────────────────────────────────────
  gross_revenue: {
    entity: "order_item", expr: "SUM({sale_price})",
    additive: uniform("order_item", true),
    description: "반품·취소를 포함한 총 판매 금액",
  },
  net_revenue: {
    // DW가 is_revenue_recognized 로 이미 계산한 컬럼을 합산만 한다.
    // 매출 인식 규칙을 semantic layer가 다시 정의하지 않는다.
    entity: "order_item", expr: "SUM({net_revenue})",
    additive: uniform("order_item", true),
    description: "매출 인식된 순 판매 금액",
  },
  cogs: {
    entity: "order_item", expr: "SUM(IF({is_revenue_recognized}, {unit_cost}, 0))",
    additive: uniform("order_item", true),
    description: "매출 인식된 매출원가",
  },
  gross_profit: {
    entity: "order_item", expr: "SUM({net_gross_profit})",
    additive: uniform("order_item", true),
    description: "매출 인식된 매출총이익",
  },
  order_item_count: {
    // 매출 인식 여부로 거르지 않는다. order_item_status 로 걸러 쓴다
    entity: "order_item", expr: "COUNT(*)",
    additive: uniform("order_item", true),
    description: "주문 라인 수. 취소·반품 포함",
  },
  units_sold: {
    entity: "order_item", expr: "COUNTIF({is_revenue_recognized})",
    additive: uniform("order_item", true),
    description: "매출 인식된 판매 수량",
  },
  units_returned: {
    entity: "order_item", expr: "COUNTIF({order_item_status} = 'returned')",
    additive: uniform("order_item", true),
    description: "반품된 수량",
  },
  buyer_count: {
    // 고객 하나가 여러 날에 걸치므로 날짜축 비가산이다. 고객 grain fact가
    // 없어 entity를 옮길 수 없으므로 sketch 로 저장한다 (P10-2).
    //
    // 매출 인식 필터를 걸지 않는다. order_item_status 가 dimension이라 소비 시점에
    // 거를 수 있고, 필터를 박으면 전체 구매자를 낼 방법이 없어진다 (P4).
    entity: "order_item", expr: hll("user_id"),
    additive: uniform("order_item", "sketch"),
    description: "구매 고객 수 (HLL 근사). 취소·반품 포함",
  },

  // 구매자를 매출 인식 여부로 나눈다. dimension 이 아니라 지표로 나누는 이유는
  // distinct count 라 뺄셈이 안 되기 때문이다 — 한 사람이 완료 주문과 취소 주문을
  // 둘 다 가질 수 있어서 buyer_count ≠ paying + void 다.
  //
  //   실측 2026-09-20. 전체 81,797 · paying 69,045 · void 30,328
  //   겹치는 사람 17,576 명. 전체 − void 를 하면 그 사람들이 통째로 빠진다
  //
  // 매출은 라인마다 한 bucket 이라 gross_revenue − net_revenue 로 나온다. 구매자만 다르다.
  paying_buyer_count: {
    entity: "order_item", expr: hll("user_id"),
    filter: "{is_revenue_recognized}",
    additive: uniform("order_item", "sketch"),
    description: "매출 인식된 주문이 있는 고객 수 (HLL 근사)",
  },
  void_buyer_count: {
    entity: "order_item", expr: hll("user_id"),
    filter: "NOT {is_revenue_recognized}",
    additive: uniform("order_item", "sketch"),
    description: "취소·반품된 주문이 있는 고객 수 (HLL 근사)",
  },

  // ── order ───────────────────────────────────────────────────
  order_count: {
    // order_item 에 두면 COUNT(DISTINCT order_key) 라 카테고리축 비가산이다.
    // 주문 grain 에는 카테고리 축이 없으므로 여기서는 COUNT(*) 로 전 축 가산이 된다.
    entity: "order", expr: "COUNT(*)",
    additive: uniform("order", true),
    description: "주문 건수",
  },
  returned_order_count: {
    entity: "order", expr: "COUNTIF({order_status} = 'returned')",
    additive: uniform("order", true),
    description: "반품된 주문 건수",
  },

  // ── session ─────────────────────────────────────────────────
  session_count: {
    entity: "session", expr: "COUNT(*)",
    additive: uniform("session", true),
    description: "세션 수",
  },
  bounce_count: {
    entity: "session", expr: "COUNTIF({is_bounce})",
    additive: uniform("session", true),
    description: "이탈 세션 수",
  },
  visitor_count: {
    entity: "session", expr: hll("user_id"),
    additive: uniform("session", "sketch"),
    description: "방문 사용자 수 (HLL 근사)",
  },

  // ── user_event ──────────────────────────────────────────────
  event_count: {
    entity: "user_event", expr: "COUNT(*)",
    additive: uniform("user_event", true),
    description: "이벤트 수",
  },
  active_user: {
    entity: "user_event", expr: hll("user_id"),
    additive: uniform("user_event", "sketch"),
    description: "활성 사용자 수 (HLL 근사)",
  },
};

// 비율 지표 — 테이블을 만들지 않고 registry 행으로만 존재한다 (P12).
// 유효 dimension은 분자·분모의 교집합이다. 교집합이 비면 그 조합은 정의되지 않는다.
const RATIOS = {
  gross_margin_rate: { numerator: "gross_profit",         denominator: "net_revenue",   description: "순매출 대비 매출총이익률" },
  return_rate:       { numerator: "units_returned",       denominator: "units_sold",    description: "판매 수량 대비 반품률" },
  bounce_rate:       { numerator: "bounce_count",         denominator: "session_count", description: "세션 이탈률" },
  order_return_rate: { numerator: "returned_order_count", denominator: "order_count",   description: "주문 반품률" },
  aov:               { numerator: "net_revenue",          denominator: "order_count",   description: "주문당 평균 순매출" },
  units_per_order:   { numerator: "units_sold",           denominator: "order_count",   description: "주문당 평균 수량" },
  revenue_per_buyer: { numerator: "net_revenue",          denominator: "buyer_count",   approximate: true, description: "구매 고객당 순매출 (분모가 HLL 근사)" },
};

// 의도적으로 생성하지 않는 지표. "생성되지 않았다"와 "존재하지 않는다"는
// 다르므로 registry 에는 남긴다 (P17).
const EXCLUDED = {
  session_funnel_rate: { reason: "상류 결함 7 — purchased 플래그가 이름대로 동작하지 않는다. 세션 구매율 77.1%" },
  cohort_retention:    { reason: "daily 집계로 복원 불가. 사용자 단위 식별자가 필요한 별도 모델" },
  ltv:                 { reason: "다일 상태(multi-day state). atomic fact 위의 별도 모델" },
  // purchase_type 이 생겨 재구매 고객 수는 metric_buyer_count 에서 바로 나온다.
  // RATIOS 로 못 넣는 이유는 분자·분모가 지표가 아니라 같은 지표의 다른 dimension
  // 값이기 때문이다 — buyer_count where repeat / buyer_count where '(all)'
  repurchase_rate:     { reason: "purchase_type 으로 조회 가능. 분자·분모가 지표가 아니라 dimension 값이라 RATIOS 에 못 넣는다" },
  delivery_days_p50:   { reason: "중앙값은 sketch 로도 병합 불가 (P10-3)" },
};

module.exports = { METRICS, RATIOS, EXCLUDED, HLL_PRECISION };
