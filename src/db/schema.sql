-- BATBOT_V11 HFT PostgreSQL Persistence Schema
-- Target Engine: PostgreSQL 15+
-- Notes:
--   * Idempotent DDL statements (CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS)
--   * High-precision fixed-point NUMERIC(28, 10) for financial amounts and BIGINT for Unix ns/ms sequences

CREATE TABLE IF NOT EXISTS telemetry_signals (
  id BIGSERIAL PRIMARY KEY,
  symbol VARCHAR(24) NOT NULL,
  sequence_num BIGINT NOT NULL,
  event_ts_ms BIGINT NOT NULL,
  bid_price NUMERIC(24, 10) NOT NULL,
  ask_price NUMERIC(24, 10) NOT NULL,
  obi DOUBLE PRECISION NOT NULL,
  cvd DOUBLE PRECISION NOT NULL,
  spread_velocity DOUBLE PRECISION NOT NULL,
  ai_direction DOUBLE PRECISION NOT NULL,
  ai_confidence DOUBLE PRECISION NOT NULL,
  rolling_ic DOUBLE PRECISION NOT NULL,
  tick_latency_us DOUBLE PRECISION NOT NULL,
  ai_inference_latency_ns BIGINT NOT NULL,
  last_signal VARCHAR(12) NOT NULL CHECK (last_signal IN ('BUY', 'SELL', 'NONE')),
  risk_status VARCHAR(64) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_telemetry_signals_symbol_ts
  ON telemetry_signals (symbol, event_ts_ms DESC);

CREATE INDEX IF NOT EXISTS idx_telemetry_signals_seq
  ON telemetry_signals (symbol, sequence_num DESC);

CREATE TABLE IF NOT EXISTS exchange_orders (
  id BIGSERIAL PRIMARY KEY,
  exchange_order_id BIGINT NOT NULL,
  client_order_id VARCHAR(64) NOT NULL,
  symbol VARCHAR(24) NOT NULL,
  side VARCHAR(8) NOT NULL CHECK (side IN ('BUY', 'SELL')),
  position_side VARCHAR(8) NOT NULL DEFAULT 'BOTH' CHECK (position_side IN ('LONG', 'SHORT', 'BOTH')),
  order_type VARCHAR(32) NOT NULL,
  time_in_force VARCHAR(8),
  reduce_only BOOLEAN NOT NULL DEFAULT FALSE,
  close_position BOOLEAN NOT NULL DEFAULT FALSE,
  orig_qty NUMERIC(28, 10) NOT NULL,
  executed_qty NUMERIC(28, 10) NOT NULL DEFAULT 0,
  price NUMERIC(28, 10) NOT NULL DEFAULT 0,
  stop_price NUMERIC(28, 10) NOT NULL DEFAULT 0,
  avg_price NUMERIC(28, 10) NOT NULL DEFAULT 0,
  status VARCHAR(32) NOT NULL,
  exchange_update_ms BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_exchange_orders_symbol_order_id UNIQUE (symbol, exchange_order_id),
  CONSTRAINT uq_exchange_orders_client_order_id UNIQUE (client_order_id)
);

CREATE INDEX IF NOT EXISTS idx_exchange_orders_symbol_status
  ON exchange_orders (symbol, status, exchange_update_ms DESC);

CREATE TABLE IF NOT EXISTS trade_executions (
  id BIGSERIAL PRIMARY KEY,
  exchange_trade_id BIGINT NOT NULL,
  exchange_order_id BIGINT NOT NULL,
  symbol VARCHAR(24) NOT NULL,
  side VARCHAR(8) NOT NULL CHECK (side IN ('BUY', 'SELL')),
  position_side VARCHAR(8) NOT NULL DEFAULT 'BOTH' CHECK (position_side IN ('LONG', 'SHORT', 'BOTH')),
  exec_price NUMERIC(28, 10) NOT NULL,
  exec_qty NUMERIC(28, 10) NOT NULL,
  quote_qty NUMERIC(28, 10) NOT NULL,
  commission NUMERIC(28, 10) NOT NULL DEFAULT 0,
  commission_asset VARCHAR(16) NOT NULL DEFAULT 'USDT',
  realized_pnl NUMERIC(28, 10) NOT NULL DEFAULT 0,
  is_maker BOOLEAN NOT NULL DEFAULT FALSE,
  trade_ts_ms BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_trade_executions_symbol_trade_id UNIQUE (symbol, exchange_trade_id)
);

CREATE INDEX IF NOT EXISTS idx_trade_executions_symbol_ts
  ON trade_executions (symbol, trade_ts_ms DESC);

CREATE TABLE IF NOT EXISTS closed_trades (
  id BIGSERIAL PRIMARY KEY,
  symbol VARCHAR(24) NOT NULL,
  side VARCHAR(8) NOT NULL CHECK (side IN ('LONG', 'SHORT')),
  size NUMERIC(28, 10) NOT NULL,
  entry_price NUMERIC(28, 10) NOT NULL,
  exit_price NUMERIC(28, 10) NOT NULL,
  exit_reason VARCHAR(64) NOT NULL,
  duration_ms BIGINT NOT NULL,
  roe_percent DOUBLE PRECISION NOT NULL,
  pnl_usdt NUMERIC(28, 10) NOT NULL,
  closed_ts_ms BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_closed_trades_symbol_ts
  ON closed_trades (symbol, closed_ts_ms DESC);

CREATE TABLE IF NOT EXISTS model_recalibrations (
  id BIGSERIAL PRIMARY KEY,
  generation_num INTEGER NOT NULL,
  model_type VARCHAR(24) NOT NULL CHECK (model_type IN ('MAMBA2', 'CFC', 'TKAN_LUT')),
  weights_path TEXT NOT NULL,
  tkan_path TEXT,
  trigger_ic DOUBLE PRECISION NOT NULL,
  shadow_ic DOUBLE PRECISION,
  shadow_dir_accuracy DOUBLE PRECISION,
  avg_latency_ns BIGINT,
  status VARCHAR(32) NOT NULL CHECK (status IN ('STARTED', 'SHADOW_PASSED', 'PROMOTED', 'FAILED')),
  failure_reason VARCHAR(64),
  error_details TEXT,
  started_ts_ms BIGINT NOT NULL,
  completed_ts_ms BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_model_recalibrations_status_ts
  ON model_recalibrations (status, started_ts_ms DESC);

CREATE TABLE IF NOT EXISTS account_snapshots (
  id BIGSERIAL PRIMARY KEY,
  snapshot_ts_ms BIGINT NOT NULL,
  wallet_balance_usdt NUMERIC(28, 10) NOT NULL,
  available_balance_usdt NUMERIC(28, 10) NOT NULL,
  unrealized_pnl_usdt NUMERIC(28, 10) NOT NULL,
  cumulative_funding_usdt NUMERIC(28, 10) NOT NULL DEFAULT 0,
  cumulative_commission_usdt NUMERIC(28, 10) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_account_snapshots_ts
  ON account_snapshots (snapshot_ts_ms DESC);

