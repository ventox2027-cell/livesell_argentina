-- =============================================================================
-- LIVE SHOPPING ARGENTINA — Migración inicial
-- PostgreSQL 16
--
-- Principios aplicados (ver blueprint/05-datos-postgres.md):
--   · Las invariantes viven en la base, no en el código.
--   · IDs = ULID con prefijo, en TEXT.
--   · Dinero = BIGINT en centavos. Nunca FLOAT.
--   · Tiempo = TIMESTAMPTZ en UTC. Siempre.
--   · Los pedidos guardan SNAPSHOTS, no referencias, de lo que puede cambiar.
-- =============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS "citext";      -- emails case-insensitive
CREATE EXTENSION IF NOT EXISTS "pgcrypto";    -- cifrado de DNI/CUIL
CREATE EXTENSION IF NOT EXISTS "pg_trgm";     -- búsqueda difusa y typos
CREATE EXTENSION IF NOT EXISTS "unaccent";    -- "camion" encuentra "camión"

-- =============================================================================
-- ENUMS
-- =============================================================================

CREATE TYPE auth_provider   AS ENUM ('google', 'apple', 'phone');
CREATE TYPE user_role       AS ENUM ('buyer', 'seller', 'moderator', 'admin');
CREATE TYPE user_status     AS ENUM ('active', 'suspended', 'deleted');
CREATE TYPE doc_type        AS ENUM ('dni', 'cuil', 'cuit', 'passport');
CREATE TYPE geocode_status  AS ENUM ('pending', 'ok', 'low_confidence', 'failed');
CREATE TYPE device_platform AS ENUM ('android', 'ios');

CREATE TYPE seller_status   AS ENUM ('pending_review', 'active', 'suspended', 'rejected');
CREATE TYPE product_status  AS ENUM ('draft', 'active', 'paused', 'archived');

-- Máquina de estados del LIVE — blueprint/06
CREATE TYPE live_status AS ENUM (
  'SCHEDULED', 'STARTING', 'LIVE', 'RECONNECTING', 'ENDED', 'FAILED', 'CANCELLED'
);

-- Máquina de estados de ORDER — blueprint/06
CREATE TYPE order_status AS ENUM (
  'DRAFT', 'RESERVED', 'PAYMENT_PENDING', 'PAID', 'CONFIRMED',
  'PREPARING', 'READY_TO_SHIP', 'SHIPPED', 'DELIVERED',
  'CANCELLED', 'REFUNDED', 'EXPIRED'
);

-- Máquina de estados de PAYMENT — blueprint/06
CREATE TYPE payment_status AS ENUM (
  'INITIATED', 'PENDING', 'IN_PROCESS', 'APPROVED', 'REJECTED',
  'CANCELLED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'CHARGED_BACK'
);
CREATE TYPE payment_provider AS ENUM ('mercadopago', 'modo');
CREATE TYPE payment_method   AS ENUM (
  'credit_card', 'debit_card', 'account_money', 'bank_transfer', 'cash'
);

CREATE TYPE reservation_status AS ENUM ('ACTIVE', 'COMMITTED', 'RELEASED', 'EXPIRED');

CREATE TYPE shipment_status AS ENUM (
  'PENDING', 'LABEL_CREATED', 'DISPATCHED', 'IN_TRANSIT',
  'OUT_FOR_DELIVERY', 'DELIVERED', 'FAILED', 'RETURNED', 'CANCELLED'
);
CREATE TYPE shipping_provider AS ENUM (
  'own_flex', 'andreani', 'correo_argentino', 'mercado_envios', 'pickup'
);

CREATE TYPE notification_kind AS ENUM (
  'LIVE_STARTED', 'CONTENT_PUBLISHED', 'ORDER_UPDATE', 'PAYMENT_UPDATE',
  'SHIPMENT_UPDATE', 'SELLER_SALE', 'MARKETING'
);
CREATE TYPE notification_channel AS ENUM ('push', 'whatsapp', 'email', 'in_app');
CREATE TYPE notification_state   AS ENUM ('queued', 'sent', 'delivered', 'opened', 'failed');

-- =============================================================================
-- FUNCIONES AUXILIARES
-- =============================================================================

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Extrae los 4 dígitos núcleo de un CP argentino.
-- Acepta '1414' (clásico) y 'C1414AAJ' (CPA). Es la unidad de agrupación
-- logística: sin esto no se pueden armar hojas de ruta por zona.
CREATE OR REPLACE FUNCTION ar_postal_core(cp TEXT) RETURNS TEXT AS $$
DECLARE clean TEXT;
BEGIN
  clean := upper(regexp_replace(coalesce(cp, ''), '\s', '', 'g'));
  IF clean ~ '^[A-Z]\d{4}[A-Z]{3}$' THEN RETURN substring(clean FROM 2 FOR 4); END IF;
  IF clean ~ '^\d{4}$'              THEN RETURN clean;                        END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- =============================================================================
-- IDENTIDAD
-- =============================================================================

CREATE TABLE users (
  id                   TEXT PRIMARY KEY,                        -- usr_<ulid>
  first_name           TEXT NOT NULL CHECK (length(trim(first_name)) BETWEEN 1 AND 60),
  last_name            TEXT NOT NULL CHECK (length(trim(last_name))  BETWEEN 1 AND 60),
  email                CITEXT NOT NULL,
  email_verified       BOOLEAN NOT NULL DEFAULT false,

  -- E.164. En Argentina es el identificador operativo real.
  phone_e164           TEXT NOT NULL CHECK (phone_e164 ~ '^\+[1-9]\d{7,14}$'),
  phone_verified       BOOLEAN NOT NULL DEFAULT false,
  whatsapp_opt_in      BOOLEAN NOT NULL DEFAULT true,

  auth_provider        auth_provider NOT NULL,
  provider_sub         TEXT,
  avatar_url           TEXT,

  -- Desnormalizado a propósito: se lee en CADA apertura de la hoja de compra.
  -- Un JOIN en ese camino es inaceptable.
  has_default_address  BOOLEAN NOT NULL DEFAULT false,
  has_saved_card       BOOLEAN NOT NULL DEFAULT false,

  role                 user_role   NOT NULL DEFAULT 'buyer',
  status               user_status NOT NULL DEFAULT 'active',

  locale               TEXT NOT NULL DEFAULT 'es-AR',
  timezone             TEXT NOT NULL DEFAULT 'America/Argentina/Buenos_Aires',

  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at           TIMESTAMPTZ
);

CREATE UNIQUE INDEX uq_users_email     ON users (email)      WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_users_phone     ON users (phone_e164) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_users_provider  ON users (auth_provider, provider_sub)
  WHERE provider_sub IS NOT NULL AND deleted_at IS NULL;
CREATE TRIGGER trg_users_updated BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- Se crea en la PRIMERA COMPRA, nunca en el registro.
CREATE TABLE user_addresses (
  id                 TEXT PRIMARY KEY,                          -- adr_<ulid>
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label              TEXT NOT NULL DEFAULT 'Principal',
  is_default         BOOLEAN NOT NULL DEFAULT true,

  -- Identidad fiscal. doc_number_enc va CIFRADO con pgcrypto.
  doc_type           doc_type NOT NULL,
  doc_number_enc     BYTEA NOT NULL,
  doc_number_last4   TEXT NOT NULL,                             -- para mostrar enmascarado
  recipient_name     TEXT NOT NULL CHECK (length(trim(recipient_name)) >= 3),
  contact_phone      TEXT NOT NULL CHECK (contact_phone ~ '^\+[1-9]\d{7,14}$'),

  -- DESGLOSADA. Nunca texto libre: sin desglose no hay zonificación ni ruteo.
  street             TEXT NOT NULL CHECK (length(trim(street)) >= 2),
  street_number      TEXT NOT NULL,                             -- TEXT: existe "s/n"
  floor              TEXT,
  apartment          TEXT,
  between_streets    TEXT,                                      -- el repartidor lo usa de verdad
  city               TEXT NOT NULL,
  province           TEXT NOT NULL CHECK (province ~ '^AR-[A-Z]$'),  -- ISO 3166-2:AR
  postal_code        TEXT NOT NULL,
  postal_code_core   TEXT GENERATED ALWAYS AS (ar_postal_core(postal_code)) STORED,
  country            CHAR(2) NOT NULL DEFAULT 'AR',
  delivery_notes     TEXT,

  -- Geocodificación ASÍNCRONA: la compra nunca espera a un servicio externo.
  lat                NUMERIC(9,6),
  lng                NUMERIC(9,6),
  geocode_status     geocode_status NOT NULL DEFAULT 'pending',
  geocode_confidence REAL,

  -- Persistidos al calcularse. No se recalculan: los envíos ya agrupados
  -- conservan su agrupación aunque cambie el algoritmo.
  zone               TEXT,
  zone_cluster       TEXT,

  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at         TIMESTAMPTZ
);

CREATE UNIQUE INDEX uq_address_default ON user_addresses (user_id)
  WHERE is_default = true AND deleted_at IS NULL;
CREATE INDEX ix_address_user      ON user_addresses (user_id) WHERE deleted_at IS NULL;
CREATE INDEX ix_address_logistics ON user_addresses (province, postal_code_core);
CREATE TRIGGER trg_addresses_updated BEFORE UPDATE ON user_addresses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


CREATE TABLE devices (
  id             TEXT PRIMARY KEY,                              -- dev_<ulid>
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  push_token     TEXT NOT NULL UNIQUE,
  platform       device_platform NOT NULL,
  app_version    TEXT NOT NULL,
  os_version     TEXT NOT NULL,
  timezone       TEXT NOT NULL DEFAULT 'America/Argentina/Buenos_Aires',
  push_enabled   BOOLEAN NOT NULL DEFAULT true,
  failure_count  SMALLINT NOT NULL DEFAULT 0,
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Índice del fan-out: solo dispositivos vivos.
CREATE INDEX ix_devices_active ON devices (user_id)
  WHERE push_enabled = true AND failure_count < 5;


CREATE TABLE refresh_tokens (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,                            -- SHA-256, nunca el token
  device_id    TEXT REFERENCES devices(id) ON DELETE SET NULL,
  -- Rotación: al usar un token se emite otro y este apunta al sucesor.
  -- Si llega un token YA rotado, es robo → se revoca toda la familia.
  replaced_by  TEXT REFERENCES refresh_tokens(id),
  revoked_at   TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ NOT NULL,
  created_ip   INET,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_refresh_user ON refresh_tokens (user_id) WHERE revoked_at IS NULL;

-- =============================================================================
-- VENDEDORES Y CATÁLOGO
-- =============================================================================

CREATE TABLE sellers (
  id                 TEXT PRIMARY KEY,                          -- sel_<ulid>
  user_id            TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
  legal_name         TEXT NOT NULL,
  tax_id             TEXT NOT NULL,                             -- CUIT
  status             seller_status NOT NULL DEFAULT 'pending_review',
  verified           BOOLEAN NOT NULL DEFAULT false,

  mp_user_id         TEXT,                                      -- cuenta de Mercado Pago
  mp_access_token_enc BYTEA,                                    -- OAuth, cifrado
  payout_hold_days   SMALLINT NOT NULL DEFAULT 7,
  commission_bps     INTEGER NOT NULL DEFAULT 1000,             -- 1000 bps = 10 %

  has_flex_delivery  BOOLEAN NOT NULL DEFAULT false,
  flex_min_stops     SMALLINT NOT NULL DEFAULT 5,

  rating             NUMERIC(2,1),
  rating_count       INTEGER NOT NULL DEFAULT 0,

  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  suspended_at       TIMESTAMPTZ,
  suspended_reason   TEXT
);
CREATE INDEX ix_sellers_status ON sellers (status);
CREATE TRIGGER trg_sellers_updated BEFORE UPDATE ON sellers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


CREATE TABLE stores (
  id           TEXT PRIMARY KEY,                                -- sto_<ulid>
  seller_id    TEXT NOT NULL UNIQUE REFERENCES sellers(id) ON DELETE CASCADE,
  handle       CITEXT NOT NULL UNIQUE CHECK (handle ~ '^[a-z0-9_]{3,30}$'),
  display_name TEXT NOT NULL,
  bio          TEXT,
  avatar_url   TEXT,
  banner_url   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_stores_updated BEFORE UPDATE ON stores
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


CREATE TABLE categories (
  id         TEXT PRIMARY KEY,
  parent_id  TEXT REFERENCES categories(id) ON DELETE SET NULL,
  slug       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  icon       TEXT,
  position   SMALLINT NOT NULL DEFAULT 0,
  active     BOOLEAN NOT NULL DEFAULT true
);


CREATE TABLE products (
  id           TEXT PRIMARY KEY,                                -- prd_<ulid>
  seller_id    TEXT NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  category_id  TEXT REFERENCES categories(id) ON DELETE SET NULL,
  title        TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 3 AND 140),
  description  TEXT,
  brand        TEXT,
  status       product_status NOT NULL DEFAULT 'draft',

  -- Denormalizado desde variants para poder ordenar y filtrar sin JOIN.
  min_price_cents BIGINT,
  max_price_cents BIGINT,

  -- Búsqueda: PostgreSQL FTS en el PMV (blueprint/11).
  -- unaccent + spanish hace que "camion" encuentre "camión" y "camperas" → "campera".
  search_vector tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('spanish', unaccent(coalesce(title, ''))),       'A') ||
    setweight(to_tsvector('spanish', unaccent(coalesce(brand, ''))),       'B') ||
    setweight(to_tsvector('spanish', unaccent(coalesce(description, ''))), 'C')
  ) STORED,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ
);

CREATE INDEX ix_products_seller ON products (seller_id, status) WHERE deleted_at IS NULL;
CREATE INDEX ix_products_search ON products USING GIN (search_vector);
CREATE INDEX ix_products_trgm   ON products USING GIN (title gin_trgm_ops);  -- typos
CREATE TRIGGER trg_products_updated BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


CREATE TABLE product_images (
  id         TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  url        TEXT NOT NULL,
  thumb_url  TEXT,
  position   SMALLINT NOT NULL DEFAULT 0,
  width      INTEGER,
  height     INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_images_product ON product_images (product_id, position);


CREATE TABLE product_variants (
  id            TEXT PRIMARY KEY,                               -- var_<ulid>
  product_id    TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sku           TEXT NOT NULL,
  label         TEXT NOT NULL,                                  -- "M / Negro"
  size          TEXT,
  color         TEXT,
  color_hex     CHAR(7),

  price_cents        BIGINT NOT NULL CHECK (price_cents >= 0),
  compare_at_cents   BIGINT CHECK (compare_at_cents IS NULL OR compare_at_cents >= price_cents),
  cost_cents         BIGINT,                                    -- guardarraíl de margen
  currency           CHAR(3) NOT NULL DEFAULT 'ARS',

  -- OBLIGATORIO: sin peso no hay cotización de envío posible.
  weight_gr     INTEGER NOT NULL CHECK (weight_gr > 0),
  length_cm     SMALLINT,
  width_cm      SMALLINT,
  height_cm     SMALLINT,

  active        BOOLEAN NOT NULL DEFAULT true,
  position      SMALLINT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_variant_sku ON product_variants (product_id, sku);
CREATE INDEX ix_variants_product   ON product_variants (product_id) WHERE active = true;
CREATE TRIGGER trg_variants_updated BEFORE UPDATE ON product_variants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================================
-- INVENTARIO — la tabla más crítica del sistema (blueprint/07)
-- =============================================================================

-- Tabla propia y no una columna en variants: es la fila con más contención.
-- Separarla evita que un UPDATE de stock bloquee la lectura de precio y título,
-- que ocurre miles de veces por segundo durante un live.
CREATE TABLE inventory (
  variant_id  TEXT PRIMARY KEY REFERENCES product_variants(id) ON DELETE CASCADE,
  on_hand     INTEGER NOT NULL DEFAULT 0,
  reserved    INTEGER NOT NULL DEFAULT 0,
  available   INTEGER GENERATED ALWAYS AS (on_hand - reserved) STORED,
  low_stock_threshold SMALLINT NOT NULL DEFAULT 3,
  version     INTEGER NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- ⛔ LAS RESTRICCIONES QUE HACEN IMPOSIBLE LA SOBREVENTA.
  -- Aunque el código tenga un bug, la base rechaza la escritura.
  CONSTRAINT chk_inv_non_negative CHECK (on_hand >= 0 AND reserved >= 0),
  CONSTRAINT chk_inv_reserved_lte CHECK (reserved <= on_hand)
);

CREATE INDEX ix_inventory_low ON inventory (variant_id)
  WHERE available <= 3 AND available > 0;


CREATE TABLE inventory_reservations (
  id          TEXT PRIMARY KEY,                                 -- rsv_<ulid>
  variant_id  TEXT NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  order_id    TEXT,                                             -- FK diferida: orders se crea después
  live_id     TEXT,
  quantity    INTEGER NOT NULL CHECK (quantity > 0 AND quantity <= 20),
  status      reservation_status NOT NULL DEFAULT 'ACTIVE',
  expires_at  TIMESTAMPTZ NOT NULL,
  released_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Idempotencia: el mismo intento de compra no reserva dos veces.
  idempotency_key TEXT NOT NULL
);

CREATE UNIQUE INDEX uq_reservation_idem ON inventory_reservations (user_id, idempotency_key);
-- Barrido de vencidas: índice parcial sobre las pocas activas, no sobre el histórico.
CREATE INDEX ix_reservations_expiring ON inventory_reservations (expires_at)
  WHERE status = 'ACTIVE';
CREATE INDEX ix_reservations_variant  ON inventory_reservations (variant_id)
  WHERE status = 'ACTIVE';


-- Trazabilidad de todo movimiento de stock. Permite auditar un descuadre.
CREATE TABLE inventory_movements (
  id          BIGSERIAL PRIMARY KEY,
  variant_id  TEXT NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  delta_on_hand  INTEGER NOT NULL DEFAULT 0,
  delta_reserved INTEGER NOT NULL DEFAULT 0,
  reason      TEXT NOT NULL,   -- reserve | release | commit | restock | adjust | return
  ref_type    TEXT,
  ref_id      TEXT,
  actor_id    TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_movements_variant ON inventory_movements (variant_id, created_at DESC);

-- =============================================================================
-- LIVE
-- =============================================================================

CREATE TABLE live_sessions (
  id                TEXT PRIMARY KEY,                           -- liv_<ulid>
  seller_id         TEXT NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  title             TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 3 AND 120),
  description       TEXT,
  cover_url         TEXT,
  status            live_status NOT NULL DEFAULT 'SCHEDULED',

  livekit_room_name TEXT NOT NULL UNIQUE,
  hls_url           TEXT,                                       -- se llena al activar Egress
  recording_url     TEXT,

  scheduled_for     TIMESTAMPTZ,
  started_at        TIMESTAMPTZ,
  ended_at          TIMESTAMPTZ,
  reconnect_until   TIMESTAMPTZ,                                -- ventana de gracia de 90 s

  viewer_count      INTEGER NOT NULL DEFAULT 0,                 -- sincronizado desde Redis
  peak_viewers      INTEGER NOT NULL DEFAULT 0,
  unique_viewers    INTEGER NOT NULL DEFAULT 0,
  orders_count      INTEGER NOT NULL DEFAULT 0,
  gmv_cents         BIGINT  NOT NULL DEFAULT 0,

  search_vector tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('spanish', unaccent(coalesce(title, ''))),       'A') ||
    setweight(to_tsvector('spanish', unaccent(coalesce(description, ''))), 'C')
  ) STORED,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Un vendedor NO puede tener dos transmisiones activas a la vez.
CREATE UNIQUE INDEX uq_one_live_per_seller ON live_sessions (seller_id)
  WHERE status IN ('STARTING', 'LIVE', 'RECONNECTING');

-- Feed: índice parcial sobre ~50 filas activas, no sobre el histórico completo.
CREATE INDEX ix_lives_active ON live_sessions (viewer_count DESC, started_at DESC)
  WHERE status = 'LIVE';
CREATE INDEX ix_lives_seller ON live_sessions (seller_id, started_at DESC);
CREATE INDEX ix_lives_search ON live_sessions USING GIN (search_vector);
CREATE TRIGGER trg_lives_updated BEFORE UPDATE ON live_sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


CREATE TABLE live_featured_products (
  id             TEXT PRIMARY KEY,                              -- ftr_<ulid>
  live_id        TEXT NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
  product_id     TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_id     TEXT REFERENCES product_variants(id) ON DELETE SET NULL,

  featured_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  unfeatured_at  TIMESTAMPTZ,
  offset_ms      BIGINT NOT NULL,        -- desde started_at: reconstruye el VOD
  price_cents    BIGINT NOT NULL,        -- snapshot histórico

  -- Embudo desnormalizado: distingue "no lo miran" de "lo miran y no compran".
  impressions    BIGINT NOT NULL DEFAULT 0,
  taps           BIGINT NOT NULL DEFAULT 0,
  orders_count   BIGINT NOT NULL DEFAULT 0,
  revenue_cents  BIGINT NOT NULL DEFAULT 0
);

-- ⛔ UN SOLO producto destacado a la vez. Imposible el doble destacado
-- por doble toque o por dos peticiones en paralelo.
CREATE UNIQUE INDEX uq_one_featured_per_live ON live_featured_products (live_id)
  WHERE unfeatured_at IS NULL;
CREATE INDEX ix_featured_live ON live_featured_products (live_id, offset_ms);


CREATE TABLE live_viewers (
  id          BIGSERIAL PRIMARY KEY,
  live_id     TEXT NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
  user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  joined_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  left_at     TIMESTAMPTZ,
  watch_sec   INTEGER,
  mode        TEXT,                       -- webrtc | llhls
  network     TEXT,
  carrier     TEXT                        -- detecta "solo falla en Personal 4G"
);
CREATE INDEX ix_viewers_live ON live_viewers (live_id, joined_at DESC);

-- =============================================================================
-- COMERCIO
-- =============================================================================

CREATE TABLE orders (
  id                  TEXT PRIMARY KEY,                         -- ord_<ulid>
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  seller_id           TEXT NOT NULL REFERENCES sellers(id) ON DELETE RESTRICT,
  status              order_status NOT NULL DEFAULT 'DRAFT',

  -- ⛔ LO QUE IMPIDE EL COBRO DOBLE.
  idempotency_key     TEXT NOT NULL,

  -- Atribución: sin esto no hay métricas de conversión del live.
  live_id             TEXT REFERENCES live_sessions(id) ON DELETE SET NULL,
  featured_product_id TEXT REFERENCES live_featured_products(id) ON DELETE SET NULL,
  source              TEXT NOT NULL DEFAULT 'live',
  channel             TEXT NOT NULL DEFAULT 'ui_button',        -- SOLO telemetría (fase 2: voice)

  -- Todo calculado en el SERVIDOR. El cliente nunca envía importes.
  currency            CHAR(3) NOT NULL DEFAULT 'ARS',
  subtotal_cents      BIGINT NOT NULL CHECK (subtotal_cents >= 0),
  discount_cents      BIGINT NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  shipping_cents      BIGINT NOT NULL DEFAULT 0 CHECK (shipping_cents >= 0),
  total_cents         BIGINT NOT NULL CHECK (total_cents >= 0),
  platform_fee_cents  BIGINT NOT NULL DEFAULT 0,
  seller_payout_cents BIGINT NOT NULL DEFAULT 0,

  -- SNAPSHOT de la dirección, no referencia: si el comprador se muda,
  -- el pedido ya despachado conserva a dónde realmente fue.
  address_id          TEXT REFERENCES user_addresses(id) ON DELETE SET NULL,
  shipping_snapshot   JSONB,

  expires_at          TIMESTAMPTZ,
  paid_at             TIMESTAMPTZ,
  confirmed_at        TIMESTAMPTZ,
  cancelled_at        TIMESTAMPTZ,
  cancel_reason       TEXT,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_order_idempotency ON orders (user_id, idempotency_key);
CREATE INDEX ix_orders_user    ON orders (user_id, created_at DESC);
CREATE INDEX ix_orders_seller  ON orders (seller_id, status, created_at DESC);
CREATE INDEX ix_orders_live    ON orders (live_id) WHERE live_id IS NOT NULL;
CREATE INDEX ix_orders_expiring ON orders (expires_at)
  WHERE status IN ('DRAFT', 'RESERVED', 'PAYMENT_PENDING');
CREATE TRIGGER trg_orders_updated BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- FK diferida de reservations → orders (orders se define después)
ALTER TABLE inventory_reservations
  ADD CONSTRAINT fk_reservation_order
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL;


CREATE TABLE order_items (
  id               TEXT PRIMARY KEY,
  order_id         TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  variant_id       TEXT NOT NULL REFERENCES product_variants(id) ON DELETE RESTRICT,
  reservation_id   TEXT REFERENCES inventory_reservations(id) ON DELETE SET NULL,

  -- SNAPSHOTS: el pedido conserva lo que realmente se vendió, aunque
  -- el vendedor cambie precio, título o imagen mañana.
  sku              TEXT NOT NULL,
  product_title    TEXT NOT NULL,
  variant_label    TEXT NOT NULL,
  image_url        TEXT,
  unit_price_cents BIGINT NOT NULL CHECK (unit_price_cents >= 0),
  quantity         INTEGER NOT NULL CHECK (quantity > 0),
  weight_gr        INTEGER NOT NULL,
  total_cents      BIGINT NOT NULL,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_order_items_order ON order_items (order_id);
CREATE UNIQUE INDEX uq_order_item_variant ON order_items (order_id, variant_id);


CREATE TABLE payments (
  id                     TEXT PRIMARY KEY,                      -- pay_<ulid>
  order_id               TEXT NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  provider               payment_provider NOT NULL,
  status                 payment_status NOT NULL DEFAULT 'INITIATED',

  external_id            TEXT,
  external_status        TEXT,                                  -- crudo, para depurar
  external_status_detail TEXT,
  idempotency_key        TEXT NOT NULL,

  method                 payment_method,
  card_brand             TEXT,
  card_last4             TEXT,
  installments           SMALLINT NOT NULL DEFAULT 1,

  amount_cents           BIGINT NOT NULL CHECK (amount_cents > 0),
  currency               CHAR(3) NOT NULL DEFAULT 'ARS',
  fee_cents              BIGINT NOT NULL DEFAULT 0,
  net_cents              BIGINT,
  refunded_cents         BIGINT NOT NULL DEFAULT 0,

  approved_at            TIMESTAMPTZ,
  rejected_at            TIMESTAMPTZ,
  rejection_reason       TEXT,

  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_payment_external ON payments (provider, external_id)
  WHERE external_id IS NOT NULL;
CREATE UNIQUE INDEX uq_payment_idem     ON payments (provider, idempotency_key);
CREATE INDEX ix_payments_order  ON payments (order_id);
-- Conciliación: pagos que quedaron colgados.
CREATE INDEX ix_payments_stale  ON payments (created_at)
  WHERE status IN ('INITIATED', 'PENDING', 'IN_PROCESS');
CREATE TRIGGER trg_payments_updated BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ⛔ La tabla que evita la DOBLE ACREDITACIÓN.
-- Mercado Pago reenvía webhooks de forma rutinaria.
CREATE TABLE payment_webhook_events (
  id                TEXT PRIMARY KEY,
  provider          payment_provider NOT NULL,
  external_event_id TEXT NOT NULL,
  event_type        TEXT NOT NULL,
  payload           JSONB NOT NULL,
  signature_valid   BOOLEAN NOT NULL,
  processed_at      TIMESTAMPTZ,
  error             TEXT,
  attempts          SMALLINT NOT NULL DEFAULT 0,
  received_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT uq_webhook_event UNIQUE (provider, external_event_id)
);
CREATE INDEX ix_webhook_unprocessed ON payment_webhook_events (received_at)
  WHERE processed_at IS NULL;


CREATE TABLE shipments (
  id                   TEXT PRIMARY KEY,                        -- shp_<ulid>
  order_id             TEXT NOT NULL UNIQUE REFERENCES orders(id) ON DELETE RESTRICT,
  provider             shipping_provider NOT NULL,
  status               shipment_status NOT NULL DEFAULT 'PENDING',

  external_id          TEXT,
  tracking_code        TEXT,
  label_url            TEXT,
  qr_payload           TEXT,

  -- Persistidos al confirmar el pago. Alimentan la agrupación por CP.
  zone                 TEXT,
  zone_cluster         TEXT,
  postal_code_core     TEXT,

  weight_gr            INTEGER NOT NULL,
  declared_value_cents BIGINT NOT NULL,
  cost_cents           BIGINT,

  dispatched_at        TIMESTAMPTZ,
  delivered_at         TIMESTAMPTZ,
  delivered_by         TEXT,

  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ix_shipments_tracking ON shipments (tracking_code) WHERE tracking_code IS NOT NULL;
-- Agrupación logística por zona (§19).
CREATE INDEX ix_shipments_routing  ON shipments (zone_cluster, status)
  WHERE status IN ('PENDING', 'LABEL_CREATED');
CREATE TRIGGER trg_shipments_updated BEFORE UPDATE ON shipments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


CREATE TABLE shipment_events (
  id          BIGSERIAL PRIMARY KEY,
  shipment_id TEXT NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  status      shipment_status NOT NULL,
  note        TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_shipment_events ON shipment_events (shipment_id, occurred_at DESC);

-- =============================================================================
-- SOCIAL Y CRECIMIENTO
-- =============================================================================

CREATE TABLE follows (
  follower_id      TEXT NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  seller_id        TEXT NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  notify_live      BOOLEAN NOT NULL DEFAULT true,
  notify_content   BOOLEAN NOT NULL DEFAULT true,
  is_favorite      BOOLEAN NOT NULL DEFAULT false,   -- único permiso para saltar horario de silencio
  muted_until      TIMESTAMPTZ,

  -- Señales de afinidad: ordenan el fan-off por tramos y personalizan el feed.
  last_watched_at  TIMESTAMPTZ,
  total_watch_sec  INTEGER NOT NULL DEFAULT 0,
  orders_count     INTEGER NOT NULL DEFAULT 0,
  engagement_score REAL NOT NULL DEFAULT 0,

  -- ⛔ El follow duplicado es imposible. INSERT ... ON CONFLICT DO NOTHING es idempotente.
  PRIMARY KEY (follower_id, seller_id)
);

-- Fan-out de push Tipo B: index-only scan, ya ordenado por afinidad.
CREATE INDEX ix_follows_notify_live ON follows (seller_id, engagement_score DESC)
  INCLUDE (follower_id)
  WHERE notify_live = true AND muted_until IS NULL;
CREATE INDEX ix_follows_notify_content ON follows (seller_id)
  INCLUDE (follower_id)
  WHERE notify_content = true AND muted_until IS NULL;
CREATE INDEX ix_follows_by_user ON follows (follower_id, engagement_score DESC);


-- Contadores FRAGMENTADOS: evita la fila caliente cuando 3.000 personas
-- siguen al mismo vendedor durante un live viral.
CREATE TABLE seller_counters (
  seller_id TEXT NOT NULL REFERENCES sellers(id) ON DELETE CASCADE,
  shard     SMALLINT NOT NULL CHECK (shard BETWEEN 0 AND 15),
  followers BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (seller_id, shard)
);


CREATE TABLE notifications (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          notification_kind NOT NULL,
  channel       notification_channel NOT NULL,
  state         notification_state NOT NULL DEFAULT 'queued',

  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  deep_link     TEXT,
  data          JSONB,

  -- ⛔ Deduplicación: un reintento de la cola no genera un segundo push.
  dedupe_key    TEXT NOT NULL,

  provider_msg_id TEXT,
  sent_at       TIMESTAMPTZ,
  delivered_at  TIMESTAMPTZ,
  opened_at     TIMESTAMPTZ,
  failed_reason TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_notification_dedupe ON notifications (dedupe_key);
CREATE INDEX ix_notifications_user ON notifications (user_id, created_at DESC);

-- =============================================================================
-- INFRAESTRUCTURA
-- =============================================================================

-- Transactional outbox: el evento se inserta en la MISMA transacción que el
-- cambio de estado. Si el proceso muere, el evento no se pierde.
CREATE TABLE outbox (
  id             BIGSERIAL PRIMARY KEY,
  aggregate_type TEXT NOT NULL,
  aggregate_id   TEXT NOT NULL,
  event_type     TEXT NOT NULL,
  payload        JSONB NOT NULL,
  published_at   TIMESTAMPTZ,
  attempts       SMALLINT NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_outbox_pending ON outbox (id) WHERE published_at IS NULL;


CREATE TABLE idempotency_keys (
  key            TEXT NOT NULL,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint       TEXT NOT NULL,
  request_hash   TEXT NOT NULL,     -- detecta misma clave con cuerpo distinto
  response_status SMALLINT,
  response_body  JSONB,
  locked_at      TIMESTAMPTZ,
  completed_at   TIMESTAMPTZ,
  expires_at     TIMESTAMPTZ NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);
CREATE INDEX ix_idempotency_expiry ON idempotency_keys (expires_at);


CREATE TABLE audit_logs (
  id          BIGSERIAL PRIMARY KEY,
  actor_type  TEXT NOT NULL,
  actor_id    TEXT,
  action      TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  before      JSONB,
  after       JSONB,
  ip          INET,
  user_agent  TEXT,
  trace_id    TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_audit_entity ON audit_logs (entity_type, entity_id, created_at DESC);
CREATE INDEX ix_audit_actor  ON audit_logs (actor_id, created_at DESC);


-- Eventos de negocio (§49). Tabla append-only, particionable por mes cuando crezca.
CREATE TABLE analytics_events (
  id         BIGSERIAL PRIMARY KEY,
  user_id    TEXT,
  session_id TEXT,
  name       TEXT NOT NULL,        -- live_view, product_click, purchase, …
  live_id    TEXT,
  seller_id  TEXT,
  product_id TEXT,
  props      JSONB,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_analytics_name_time ON analytics_events (name, occurred_at DESC);
CREATE INDEX ix_analytics_live      ON analytics_events (live_id, occurred_at DESC)
  WHERE live_id IS NOT NULL;

COMMIT;

-- =============================================================================
-- ÍNDICES CONCURRENTES — van fuera de la transacción, en su propia migración.
-- CREATE INDEX normal bloquea escrituras; CONCURRENTLY no.
-- =============================================================================
-- CREATE INDEX CONCURRENTLY ix_orders_seller_created ON orders (seller_id, created_at DESC);
