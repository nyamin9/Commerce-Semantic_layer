// entity 선언 — 지표를 산출하는 fact 테이블이 entity가 된다.
// entity가 정해지면 grain과 쓸 수 있는 차원이 따라서 정해진다.
//
// joins 와 dims 를 나눠 선언한다.
//   joins  어느 테이블에 어느 키로 붙는가. 이름을 준다
//   dims   그 조인에서 어느 컬럼을 차원으로 쓰는가
//
// 둘을 합쳐 쓰면 조인 슬롯에 부를 이름이 없어진다. 이름이 있어야 지표 수식이
// dim 컬럼을 가리킬 수 있다 — {product.unit_cost} 처럼. builder 가 만든 이름이
// 아니라 여기 적힌 이름이라 선언이 builder 내부를 모른다 (P5).
//
// 여기 없는 차원은 그 entity에서 쓸 수 없다 (P6).
// 가능한 조합을 이어주는 것보다 불가능한 조합을 막는 쪽이 중요하다.
//
// pk는 반드시 surrogate key다 (P2). 이 DW의 자연키는 소스가 ID를 재사용해
// 유일하지 않고, 자연키로 조인하면 에러 없이 조용히 fan-out 된다.
//
// cumulative_dims 는 누계(wtd·mtd·ytd)에 남길 축이다.
//
// 누계는 격자를 채워야 한다 — 그날 활동이 없어도 행이 있어야 걷었을 때 앞 구간이
// 빠지지 않는다. 격자 크기는 (조합 수 × 날짜)로만 정해지고 원본 행 수와 무관하다.
// 그래서 고유값이 적고 entity 를 가로지르는 conformed 축만 남긴다 (P4·P7).
//   category(26) 하나만 넣어도 격자가 26배가 된다.
//
// 여기 없는 차원은 누계 행에서 '(all)' 이 된다. NULL 로 두면 "값이 없는
// 버킷"(P6-1)과 뜻이 겹친다.
//
// refresh 는 daily_ 를 어떻게 갱신할지다. 상류가 정한다 — 상류가 전체 재생성하는
// fact 위에 증분을 올리면 과거 구간의 변경을 놓친다.
//   "incremental"  상류 raw 가 [ds-3, ds] 만 덮어쓴다. 그 구간만 다시 읽는다
//   "table"        상류가 전체 재생성한다. 우리도 매번 다시 만든다

// 이름 규칙은 naming.js 한 곳에만 둔다 (P19). 여기서 문자열을 직접 쓰면
// 접두사가 두 곳에 생기고, 어긋나도 ctx.ref() 가 실패하기 전까지 모른다
const { martName } = require("includes/naming");

const PRODUCT = martName("dim_products");
const USER    = martName("dim_users");

// via 가 null 이면 fact 자체 컬럼이라 조인이 필요 없다
const self = (col) => ({ via: null, col });

const ENTITIES = {
  order_item: {
    // raw orders · order_items 가 [ds-3, ds] 덮어쓰기. order_items 는 부모
    // (orders.created_at) 시각으로 잘리므로 ordered_date 축이 orders 와 같다
    refresh:  "incremental",
    source:   martName("fct_order_items"),
    cumulative_dims: ["country", "age_group", "gender", "acquisition_channel"],
    pk:       "order_item_key",
    date_col: "ordered_date",
    grain:    "주문 라인 1건",

    // key 는 fact 쪽 컬럼명. dim 쪽 PK 이름이 다르면 ref_key 를 덧붙인다
    joins: {
      product: { to: PRODUCT, key: "product_id" },
      user:    { to: USER,    key: "user_id"    },
    },

    // brand 는 차원이 아니다 (P4). 고유값 2,753개라 격자를 2,753배 부풀리는데,
    // 그러면 기간 롤업이 작동하지 않는다 — 2,754일을 8년으로 접어도 행이
    // 178,916 로 5% 밖에 안 줄었다. 빼면 83,320 이다 (2026-09-13 측정).
    // 브랜드별 집계가 필요하면 semantic_mart 에 직접 SQL 을 쓴다.
    dims: {
      category:            { via: "product", col: "category"   },
      department:          { via: "product", col: "department" },
      country:             { via: "user",    col: "country"             },
      age_group:           { via: "user",    col: "age_group"           },
      gender:              { via: "user",    col: "gender"              },
      acquisition_channel: { via: "user",    col: "acquisition_channel" },
      // 라인 grain 이므로 라인 상태를 쓴다. 헤더 상태(order_status)를 쓰면
      // 한 주문에 배송분과 반품분이 섞일 때 갈라진다. DW 의 is_revenue_recognized
      // 도 라인 상태에서 나온다 — order_item_status NOT IN ('cancelled','returned')
      order_item_status:   self("order_item_status"),
    },
  },

  // 주문 grain에는 상품 차원이 없다. 한 주문이 여러 상품을 포함하므로
  // 카테고리가 정의되지 않는다. 이 공백이 order_count를 여기 둔 근거다 (P10).
  order: {
    refresh:  "incremental",   // raw orders 가 [ds-3, ds] 덮어쓰기
    source:   martName("fct_orders"),
    cumulative_dims: ["country", "age_group", "gender", "acquisition_channel"],
    pk:       "order_key",
    date_col: "ordered_date",
    grain:    "주문 1건",

    joins: {
      user: { to: USER, key: "user_id" },
    },

    dims: {
      country:             { via: "user", col: "country"             },
      age_group:           { via: "user", col: "age_group"           },
      gender:              { via: "user", col: "gender"              },
      acquisition_channel: { via: "user", col: "acquisition_channel" },
      order_status:        self("order_status"),
    },
  },

  session: {
    // 상류 fct_sessions 가 증분이 아니라 매번 전체 재생성이다.
    // 과거 구간이 바뀌지 않는다고 확인되면 incremental 로 바꾼다
    refresh:  "table",
    source:   martName("fct_sessions"),
    cumulative_dims: ["country", "acquisition_channel"],
    pk:       "session_id",
    date_col: "session_date",
    grain:    "세션 1건",

    joins: {
      user: { to: USER, key: "user_id" },
    },

    dims: {
      country:              { via: "user", col: "country"             },
      acquisition_channel:  { via: "user", col: "acquisition_channel" },
      entry_traffic_source: self("entry_traffic_source"),
      browser:              self("browser"),
    },
  },

  user_event: {
    refresh:  "incremental",   // dbt fct_user_events 가 [ds-3, ds] 증분
    source:   martName("fct_user_events"),
    cumulative_dims: ["country"],
    pk:       "event_key",
    date_col: "event_date",
    grain:    "이벤트 1건",

    joins: {
      user: { to: USER, key: "user_id" },
    },

    dims: {
      country:        { via: "user", col: "country" },
      event_type:     self("event_type"),
      traffic_source: self("traffic_source"),
    },
  },
};

// 그 entity에서 쓸 수 있는 차원 전체. 지표가 dims를 생략하면 이것을 쓴다
const allDims = (entity) => Object.keys(ENTITIES[entity].dims);

// 지표 수식이 참조할 수 있는 조인 이름. 선언되지 않은 이름은 build.js가 거부한다
const allJoins = (entity) => Object.keys(ENTITIES[entity].joins || {});

// 누계에 남길 축. 나머지는 '(all)' 이 된다
const cumulativeDims = (entity) => ENTITIES[entity].cumulative_dims || [];

// daily_ 갱신 방식. gen_daily.js 가 이 값으로 type 을 고른다
const refreshOf = (entity) => ENTITIES[entity].refresh;

module.exports = { ENTITIES, allDims, allJoins, refreshOf, cumulativeDims };
