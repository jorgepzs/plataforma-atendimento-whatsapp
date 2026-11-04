CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'SUSPENDED', 'ARCHIVED')),
  timezone text NOT NULL DEFAULT 'America/Sao_Paulo',
  locale text NOT NULL DEFAULT 'pt-BR',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenant_config_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT', 'PUBLISHED', 'ARCHIVED')),
  operation_mode text NOT NULL DEFAULT 'INTAKE_AND_HANDOFF'
    CHECK (operation_mode IN ('ASSIST_ONLY', 'INTAKE_AND_HANDOFF', 'INTEGRATED')),
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  UNIQUE (tenant_id, version),
  UNIQUE (tenant_id, id)
);

CREATE UNIQUE INDEX tenant_config_one_published_idx
  ON tenant_config_versions (tenant_id)
  WHERE status = 'PUBLISHED';

CREATE TABLE channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('META_WHATSAPP')),
  provider_phone_number_id text NOT NULL,
  display_phone_number text,
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'INACTIVE')),
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_phone_number_id),
  UNIQUE (tenant_id, id)
);

CREATE INDEX channels_tenant_idx ON channels (tenant_id);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'DISABLED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_memberships (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL
    CHECK (role IN ('PLATFORM_ADMIN', 'TENANT_ADMIN', 'SUPERVISOR', 'ATTENDANT')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);

ALTER TABLE tenant_config_versions
  ADD CONSTRAINT tenant_config_created_by_membership_fk
  FOREIGN KEY (tenant_id, created_by)
  REFERENCES user_memberships (tenant_id, user_id)
  ON DELETE SET NULL (created_by);

CREATE TABLE consumers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel_id uuid NOT NULL,
  provider_external_id text NOT NULL,
  profile_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, channel_id, provider_external_id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, channel_id, id),
  FOREIGN KEY (tenant_id, channel_id)
    REFERENCES channels (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel_id uuid NOT NULL,
  consumer_id uuid NOT NULL,
  config_version_id uuid,
  state text NOT NULL DEFAULT 'BOT_ACTIVE'
    CHECK (state IN ('BOT_ACTIVE', 'WAITING_HUMAN', 'HUMAN_ACTIVE', 'CLOSED')),
  assigned_user_id uuid,
  last_consumer_message_at timestamptz,
  customer_service_window_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, channel_id, id),
  FOREIGN KEY (tenant_id, channel_id, consumer_id)
    REFERENCES consumers (tenant_id, channel_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, config_version_id)
    REFERENCES tenant_config_versions (tenant_id, id) ON DELETE SET NULL (config_version_id),
  FOREIGN KEY (tenant_id, assigned_user_id)
    REFERENCES user_memberships (tenant_id, user_id) ON DELETE SET NULL (assigned_user_id)
);

CREATE UNIQUE INDEX conversations_one_open_per_consumer_idx
  ON conversations (tenant_id, channel_id, consumer_id)
  WHERE state <> 'CLOSED';

CREATE INDEX conversations_queue_idx
  ON conversations (tenant_id, state, updated_at);

CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  provider_message_id text,
  direction text NOT NULL CHECK (direction IN ('INBOUND', 'OUTBOUND')),
  actor_type text NOT NULL CHECK (actor_type IN ('CONSUMER', 'BOT', 'HUMAN', 'SYSTEM')),
  actor_user_id uuid,
  message_type text NOT NULL,
  text_content text,
  media_reference text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider_message_id),
  FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES conversations (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, actor_user_id)
    REFERENCES user_memberships (tenant_id, user_id) ON DELETE SET NULL (actor_user_id)
);

CREATE INDEX messages_conversation_time_idx
  ON messages (conversation_id, occurred_at);

CREATE TABLE attendance_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  workflow_key text NOT NULL,
  workflow_version integer NOT NULL CHECK (workflow_version > 0),
  status text NOT NULL DEFAULT 'COLLECTING'
    CHECK (status IN ('COLLECTING', 'WAITING_HUMAN', 'HUMAN_ACTIVE', 'CLOSED')),
  collected_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  summary text,
  handoff_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, conversation_id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, conversation_id, id),
  FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES conversations (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE handoffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  attendance_case_id uuid,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'WAITING'
    CHECK (status IN ('WAITING', 'CLAIMED', 'CANCELLED', 'CLOSED')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  claimed_by uuid,
  closed_at timestamptz,
  FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES conversations (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, conversation_id, attendance_case_id)
    REFERENCES attendance_cases (tenant_id, conversation_id, id) ON DELETE SET NULL (attendance_case_id),
  FOREIGN KEY (tenant_id, claimed_by)
    REFERENCES user_memberships (tenant_id, user_id) ON DELETE SET NULL (claimed_by)
);

CREATE INDEX handoffs_queue_idx
  ON handoffs (tenant_id, status, requested_at);

CREATE TABLE connector_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_key text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  display_name text NOT NULL,
  capabilities jsonb NOT NULL,
  configuration_schema jsonb NOT NULL,
  credential_schema jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connector_key, version)
);

CREATE TABLE integration_instances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connector_definition_id uuid NOT NULL REFERENCES connector_definitions(id),
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT', 'ACTIVE', 'DISABLED', 'ERROR')),
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  encrypted_credentials bytea,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);

CREATE INDEX integration_instances_tenant_idx
  ON integration_instances (tenant_id, status);

CREATE TABLE action_executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id uuid,
  integration_instance_id uuid,
  capability text NOT NULL,
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'PROCESSING', 'ACCEPTED', 'COMPLETED', 'REJECTED', 'FAILED', 'UNKNOWN')),
  input jsonb NOT NULL,
  output jsonb,
  external_reference text,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES conversations (tenant_id, id) ON DELETE SET NULL (conversation_id),
  FOREIGN KEY (tenant_id, integration_instance_id)
    REFERENCES integration_instances (tenant_id, id) ON DELETE SET NULL (integration_instance_id)
);

CREATE TABLE action_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action_execution_id uuid NOT NULL REFERENCES action_executions(id) ON DELETE CASCADE,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  request_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  response_metadata jsonb,
  status text NOT NULL CHECK (status IN ('STARTED', 'SUCCEEDED', 'FAILED', 'TIMED_OUT')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (action_execution_id, attempt_number)
);

CREATE TABLE webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel_id uuid NOT NULL,
  provider text NOT NULL,
  provider_event_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'DEAD_LETTER')),
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processing_started_at timestamptz,
  processed_at timestamptz,
  error_code text,
  UNIQUE (provider, provider_event_id),
  FOREIGN KEY (tenant_id, channel_id)
    REFERENCES channels (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX webhook_events_processing_idx
  ON webhook_events (status, received_at)
  WHERE status IN ('PENDING', 'FAILED');

CREATE TABLE outbox_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel_id uuid NOT NULL,
  conversation_id uuid,
  message_category text NOT NULL
    CHECK (message_category IN ('SERVICE', 'UTILITY', 'AUTHENTICATION', 'MARKETING')),
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'PROCESSING', 'SENT', 'DELIVERED', 'FAILED', 'BLOCKED', 'DEAD_LETTER')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  provider_message_id text,
  blocked_reason text,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  FOREIGN KEY (tenant_id, channel_id)
    REFERENCES channels (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, channel_id, conversation_id)
    REFERENCES conversations (tenant_id, channel_id, id) ON DELETE SET NULL (conversation_id)
);

CREATE INDEX outbox_messages_processing_idx
  ON outbox_messages (status, next_attempt_at)
  WHERE status IN ('PENDING', 'FAILED');

CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,
  job_type text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'DEAD_LETTER')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX jobs_processing_idx
  ON jobs (status, available_at)
  WHERE status IN ('PENDING', 'FAILED');

CREATE TABLE audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES tenants(id) ON DELETE SET NULL,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, actor_user_id)
    REFERENCES user_memberships (tenant_id, user_id) ON DELETE SET NULL (actor_user_id)
);

CREATE INDEX audit_logs_tenant_time_idx
  ON audit_logs (tenant_id, created_at DESC);

