// entity 선언 — 지표를 산출하는 fact 테이블이 entity가 된다.
// entity가 정해지면 grain과 쓸 수 있는 차원이 따라서 정해진다.
//
// dims가 join graph다. 여기 없는 차원은 그 entity에서 쓸 수 없다 (P6).
// 가능한 조합을 이어주는 것보다 불가능한 조합을 막는 쪽이 중요하다.
//
// pk는 반드시 surrogate key다 (P2). 이 DW의 자연키는 소스가 ID를 재사용해
// 유일하지 않고, 자연키로 조인하면 에러 없이 조용히 fan-out 된다.

const PRODUCT = "sem_dim_products";
const USER    = "sem_dim_users";

// from: null 이면 fact 자체 컬럼이라 조인이 필요 없다
const self = (col) => ({ from: null, key: null, col });

const ENTITIES = {
  order_item: {
    source:   "sem_fct_order_items",
    pk:       "order_item_key",
    date_col: "ordered_date",
    grain:    "주문 라인 1건",
    dims: {
      category:            { from: PRODUCT, key: "product_id", col: "category"   },
      brand:               { from: PRODUCT, key: "product_id", col: "brand"      },
      department:          { from: PRODUCT, key: "product_id", col: "department" },
      country:             { from: USER,    key: "user_id",    col: "country"             },
      age_group:           { from: USER,    key: "user_id",    col: "age_group"           },
      gender:              { from: USER,    key: "user_id",    col: "gender"              },
      acquisition_channel: { from: USER,    key: "user_id",    col: "acquisition_channel" },
      order_status:        self("order_status"),
    },
  },

  // 주문 grain에는 상품 차원이 없다. 한 주문이 여러 상품을 포함하므로
  // 카테고리가 정의되지 않는다. 이 공백이 order_count를 여기 둔 근거다 (P10).
  order: {
    source:   "sem_fct_orders",
    pk:       "order_key",
    date_col: "ordered_date",
    grain:    "주문 1건",
    dims: {
      country:             { from: USER, key: "user_id", col: "country"             },
      age_group:           { from: USER, key: "user_id", col: "age_group"           },
      gender:              { from: USER, key: "user_id", col: "gender"              },
      acquisition_channel: { from: USER, key: "user_id", col: "acquisition_channel" },
      order_status:        self("order_status"),
    },
  },

  session: {
    source:   "sem_fct_sessions",
    pk:       "session_id",
    date_col: "session_date",
    grain:    "세션 1건",
    dims: {
      country:              { from: USER, key: "user_id", col: "country"             },
      acquisition_channel:  { from: USER, key: "user_id", col: "acquisition_channel" },
      entry_traffic_source: self("entry_traffic_source"),
      browser:              self("browser"),
    },
  },

  user_event: {
    source:   "sem_fct_user_events",
    pk:       "event_key",
    date_col: "event_date",
    grain:    "이벤트 1건",
    dims: {
      country:        { from: USER, key: "user_id", col: "country" },
      event_type:     self("event_type"),
      traffic_source: self("traffic_source"),
    },
  },
};

// 그 entity에서 쓸 수 있는 차원 전체. 지표가 dims를 생략하면 이것을 쓴다.
const allDims = (entity) => Object.keys(ENTITIES[entity].dims);

module.exports = { ENTITIES, allDims };
