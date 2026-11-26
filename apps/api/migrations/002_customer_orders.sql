CREATE TABLE customer_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id uuid,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'awaiting_confirmation', 'confirmed', 'sent_to_integration', 'cancelled')),
  currency text NOT NULL DEFAULT 'BRL',
  lines jsonb NOT NULL DEFAULT '[]'::jsonb,
  fulfillment jsonb,
  subtotal_cents integer NOT NULL DEFAULT 0 CHECK (subtotal_cents >= 0),
  delivery_fee_cents integer NOT NULL DEFAULT 0 CHECK (delivery_fee_cents >= 0),
  total_cents integer NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  integration jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  confirmed_at timestamptz,
  cancelled_at timestamptz,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES conversations (tenant_id, id) ON DELETE SET NULL (conversation_id)
);

CREATE INDEX customer_orders_tenant_status_idx
  ON customer_orders (tenant_id, status, updated_at DESC);
