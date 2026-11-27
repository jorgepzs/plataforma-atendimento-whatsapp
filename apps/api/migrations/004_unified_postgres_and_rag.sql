-- Migração unificada PostgreSQL: persistência completa da plataforma (atendimento,
-- identidade, fila inbound, Consumer Partner) + RAG híbrido (FTS português + embeddings).

CREATE TABLE IF NOT EXISTS app_attendance_tenants (
  id text PRIMARY KEY,
  ordinal integer NOT NULL UNIQUE,
  slug text NOT NULL,
  display_name text NOT NULL,
  segment text NOT NULL CHECK (segment IN ('pizzaria', 'barbearia', 'outro')),
  channel_phone_number_id text NOT NULL UNIQUE,
  config_json jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS app_attendance_conversations (
  id text PRIMARY KEY,
  ordinal integer NOT NULL UNIQUE,
  tenant_id text NOT NULL REFERENCES app_attendance_tenants(id) ON DELETE CASCADE,
  customer_name text NOT NULL,
  customer_phone text NOT NULL,
  state text NOT NULL CHECK (state IN ('BOT_ACTIVE', 'WAITING_HUMAN', 'HUMAN_ACTIVE', 'CLOSED')),
  assigned_user_id text,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  last_message_preview text NOT NULL,
  waiting_since text,
  last_inbound_message_id text,
  last_inbound_source text CHECK (
    last_inbound_source IS NULL OR last_inbound_source IN (
      'META_WEBHOOK', 'LOCAL_SIMULATOR', 'LEGACY_UNKNOWN', 'WHATSAPP_QR'
    )
  ),
  last_inbound_phone_number_id text,
  last_inbound_at text,
  UNIQUE (tenant_id, customer_phone)
);

CREATE TABLE IF NOT EXISTS app_attendance_messages (
  id text PRIMARY KEY,
  ordinal integer NOT NULL UNIQUE,
  conversation_id text NOT NULL REFERENCES app_attendance_conversations(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('CUSTOMER', 'BOT', 'ATTENDANT')),
  text text NOT NULL,
  created_at text NOT NULL,
  delivery_status text NOT NULL CHECK (delivery_status IN (
    'RECEIVED', 'SIMULATED', 'PENDING', 'SENDING', 'ACCEPTED', 'BLOCKED', 'HTTP_ERROR', 'INDETERMINATE'
  )),
  delivery_detail text,
  author_name text,
  bot_session_id text
);

CREATE TABLE IF NOT EXISTS app_attendance_outbox (
  id text PRIMARY KEY,
  ordinal integer NOT NULL UNIQUE,
  tenant_id text NOT NULL REFERENCES app_attendance_tenants(id) ON DELETE CASCADE,
  conversation_id text NOT NULL REFERENCES app_attendance_conversations(id) ON DELETE CASCADE,
  message_id text NOT NULL UNIQUE REFERENCES app_attendance_messages(id) ON DELETE CASCADE,
  source_inbound_message_id text,
  source text CHECK (source IS NULL OR source IN (
    'META_WEBHOOK', 'LOCAL_SIMULATOR', 'LEGACY_UNKNOWN', 'WHATSAPP_QR'
  )),
  phone_number_id text,
  last_inbound_at text,
  status text NOT NULL CHECK (status IN (
    'SIMULATED', 'PENDING', 'SENDING', 'ACCEPTED', 'BLOCKED', 'HTTP_ERROR', 'INDETERMINATE'
  )),
  blocked_reason text,
  attempt_count integer NOT NULL CHECK (attempt_count BETWEEN 0 AND 1),
  provider_message_id text,
  result_code text,
  created_at text NOT NULL,
  attempted_at text,
  completed_at text
);

CREATE INDEX IF NOT EXISTS app_attendance_outbox_dispatch_idx
  ON app_attendance_outbox (status, created_at, ordinal);

CREATE TABLE IF NOT EXISTS app_attendance_orders (
  id text PRIMARY KEY,
  ordinal integer NOT NULL UNIQUE,
  tenant_id text NOT NULL REFERENCES app_attendance_tenants(id) ON DELETE CASCADE,
  conversation_id text NOT NULL REFERENCES app_attendance_conversations(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('draft', 'awaiting_confirmation', 'confirmed', 'sent_to_integration', 'cancelled')),
  order_json jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS app_attendance_bot_sessions (
  id text PRIMARY KEY,
  ordinal integer NOT NULL UNIQUE,
  tenant_id text NOT NULL REFERENCES app_attendance_tenants(id) ON DELETE CASCADE,
  conversation_id text NOT NULL REFERENCES app_attendance_conversations(id) ON DELETE CASCADE,
  customer_phone text NOT NULL,
  session_json jsonb NOT NULL,
  UNIQUE (tenant_id, customer_phone)
);

CREATE TABLE IF NOT EXISTS app_attendance_processed_inbound (
  event_key text PRIMARY KEY,
  ordinal integer NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS app_identity_users (
  id text PRIMARY KEY,
  ordinal integer NOT NULL UNIQUE,
  email text NOT NULL UNIQUE,
  display_name text NOT NULL,
  platform_admin boolean NOT NULL DEFAULT false,
  salt_hex text NOT NULL CHECK (length(salt_hex) = 32),
  password_hash_hex text NOT NULL CHECK (length(password_hash_hex) = 128)
);

CREATE TABLE IF NOT EXISTS app_identity_memberships (
  user_id text NOT NULL REFERENCES app_identity_users(id) ON DELETE CASCADE,
  ordinal integer NOT NULL,
  tenant_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('TENANT_ADMIN', 'ATTENDANT')),
  PRIMARY KEY (user_id, ordinal),
  UNIQUE (user_id, tenant_id)
);

CREATE TABLE IF NOT EXISTS app_identity_sessions (
  token_hash text PRIMARY KEY CHECK (length(token_hash) = 64),
  ordinal integer NOT NULL UNIQUE,
  user_id text NOT NULL REFERENCES app_identity_users(id) ON DELETE CASCADE,
  csrf_token text NOT NULL,
  expires_at_ms bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS app_inbound_events (
  id bigserial PRIMARY KEY,
  provider text NOT NULL,
  provider_event_id text NOT NULL,
  provider_phone_number_id text NOT NULL,
  payload_json jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING', 'PROCESSING', 'PROCESSED', 'FAILED')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  received_at_ms bigint NOT NULL,
  next_attempt_at_ms bigint NOT NULL,
  lease_expires_at_ms bigint,
  processed_at_ms bigint,
  last_error text,
  UNIQUE (provider, provider_event_id),
  CHECK ((status = 'PROCESSING' AND lease_expires_at_ms IS NOT NULL)
    OR (status <> 'PROCESSING' AND lease_expires_at_ms IS NULL))
);

CREATE INDEX IF NOT EXISTS app_inbound_events_pending_idx
  ON app_inbound_events (status, next_attempt_at_ms, received_at_ms, id);

CREATE TABLE IF NOT EXISTS app_consumer_partner_configs (
  tenant_id text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT false,
  enabled_since text,
  public_base_url text NOT NULL,
  merchant_id text NOT NULL,
  merchant_name text NOT NULL,
  sales_channel text,
  delivery_fee_received_by text CHECK (delivery_fee_received_by IS NULL OR delivery_fee_received_by IN ('MERCHANT', 'PARTNER')),
  token_hash text NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  token_created_at text NOT NULL,
  product_mappings_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  option_mappings_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  variant_choices_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at text NOT NULL
);

CREATE TABLE IF NOT EXISTS app_consumer_order_details_contexts (
  tenant_id text NOT NULL,
  order_id text NOT NULL,
  context_json jsonb NOT NULL,
  updated_at text NOT NULL,
  PRIMARY KEY (tenant_id, order_id)
);

CREATE TABLE IF NOT EXISTS app_consumer_order_events (
  tenant_id text NOT NULL,
  order_id text NOT NULL,
  event_id text NOT NULL UNIQUE,
  created_at text NOT NULL,
  details_requested_at text,
  PRIMARY KEY (tenant_id, order_id)
);

CREATE INDEX IF NOT EXISTS app_consumer_order_events_polling_idx
  ON app_consumer_order_events (tenant_id, details_requested_at, created_at);

CREATE TABLE IF NOT EXISTS app_consumer_order_status_callbacks (
  tenant_id text NOT NULL,
  order_id text NOT NULL,
  callback_hash text NOT NULL,
  status text NOT NULL,
  justification text,
  received_at text NOT NULL,
  PRIMARY KEY (tenant_id, callback_hash)
);

-- RAG híbrido nativo no PostgreSQL (busca lexical portuguesa FTS + embeddings opcionais por chunk).
CREATE TABLE IF NOT EXISTS rag_knowledge_chunks (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('profile', 'policy', 'faq', 'catalog_item')),
  source_key text NOT NULL,
  title text NOT NULL,
  content text NOT NULL,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  content_hash text NOT NULL,
  embedding jsonb,
  embedding_model text,
  search_vector tsvector GENERATED ALWAYS AS (
    to_tsvector('portuguese', coalesce(title, '') || ' ' || coalesce(content, ''))
  ) STORED,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source_kind, source_key)
);

CREATE INDEX IF NOT EXISTS rag_knowledge_chunks_tenant_idx
  ON rag_knowledge_chunks (tenant_id, source_kind);

CREATE INDEX IF NOT EXISTS rag_knowledge_chunks_fts_idx
  ON rag_knowledge_chunks USING GIN (search_vector);
