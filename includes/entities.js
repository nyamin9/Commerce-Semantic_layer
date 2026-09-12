// entity 선언 — 지표를 산출하는 fact 테이블이 entity가 된다.
// entity가 정해지면 grain과 쓸 수 있는 차원이 따라서 정해진다.
//
// joins 와 dims 를 나눠 선언한다.
//   joins  어느 테이블에 어느 키로 붙는가. 이름을 준다
//   dims   그 조인에서 어느 컬럼을 차원으로 쓰는가
//
// 둘을 합쳐 쓰면 조인 슬롯에 부를 이름이 없어진다. 이름이 있어야 지표 수식이
// dim 컬럼을 가리킬 수 있다 — {product.unit_cost} 처럼. 생성기가 만든 이름이
// 아니라 여기 적힌 이름이라 선언이 생성기 내부를 모른다 (P5).
//
// 여기 없는 차원은 그 entity에서 쓸 수 없다 (P6).
// 가능한 조합을 이어주는 것보다 불가능한 조합을 막는 쪽이 중요하다.
//
// pk는 반드시 surrogate key다 (P2). 이 DW의 자연키는 소스가 ID를 재사용해
// 유일하지 않고, 자연키로 조인하면 에러 없이 조용히 fan-out 된다.

// 이름 규칙은 naming.js 한 곳에만 둔다 (P19). 여기서 문자열을 직접 쓰면
// 접두사가 두 곳에 생기고, 어긋나도 ctx.ref() 가 실패하기 전까지 모른다
const { martName } = require("includes/naming");

const PRODUCT = martName("dim_products");
const USER    = martName("dim_users");

// via 가 null 이면 fact 자체 컬럼이라 조인이 필요 없다
const self = (col) => ({ via: null, col });

const ENTITIES = {
  order_item: {
    source:   martName("fct_order_items"),
    pk:       "order_item_key",
    date_col: "ordered_date",
    grain:    "주문 라인 1건",

    // key 는 fact 쪽 컬럼명. dim 쪽 PK 이름이 다르면 ref_key 를 덧붙인다
    joins: {
      product: { to: PRODUCT, key: "product_id" },
      user:    { to: USER,    key: "user_id"    },
    },

    dims: {
      category:            { via: "product", col: "category"   },
      brand:               { via: "product", col: "brand"      },
      department:          { via: "product", col: "department" },
      country:             { via: "user",    col: "country"             },
      age_group:           { via: "user",    col: "age_group"           },
      gender:              { via: "user",    col: "gender"              },
      acquisition_channel: { via: "user",    col: "acquisition_channel" },
      order_status:        self("order_status"),
    },
  },

  // 주문 grain에는 상품 차원이 없다. 한 주문이 여러 상품을 포함하므로
  // 카테고리가 정의되지 않는다. 이 공백이 order_count를 여기 둔 근거다 (P10).
  order: {
    source:   martName("fct_orders"),
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
    source:   martName("fct_sessions"),
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
    source:   martName("fct_user_events"),
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

module.exports = { ENTITIES, allDims, allJoins };
