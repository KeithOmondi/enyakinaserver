-- 0003_mpesa_requests
-- One row per M-Pesa STK Push prompt sent to a customer's phone. A sale later "consumes" a
-- paid request, so the same payment can never be counted twice.

CREATE TABLE mpesa_requests (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         uuid NOT NULL REFERENCES businesses(id),
  created_by          uuid NOT NULL REFERENCES users(id),
  phone               text NOT NULL CHECK (phone ~ '^254[17][0-9]{8}$'),
  amount_cents        bigint NOT NULL CHECK (amount_cents >= 100 AND amount_cents % 100 = 0),
  status              text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'paid', 'failed', 'cancelled', 'timeout')),
  request_key         text,                 -- client-generated, makes "send prompt" safe to retry
  provider_request_id text,                 -- Safaricom's CheckoutRequestID
  merchant_request_id text,
  receipt             text,                 -- M-Pesa receipt number, e.g. QK12AB34CD
  result_code         integer,
  result_desc         text,
  sale_id             uuid REFERENCES sales(id) ON DELETE SET NULL,
  expires_at          timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX mpesa_requests_key ON mpesa_requests (business_id, request_key) WHERE request_key IS NOT NULL;
CREATE INDEX mpesa_requests_provider_idx ON mpesa_requests (provider_request_id);
CREATE INDEX mpesa_requests_business_created_idx ON mpesa_requests (business_id, created_at DESC);

-- A payment backed by a confirmed prompt points at it; a manually typed M-Pesa code does not
-- (those are "unverified" and are reported on the closing screen).
ALTER TABLE payments ADD COLUMN mpesa_request_id uuid REFERENCES mpesa_requests(id);
CREATE UNIQUE INDEX payments_mpesa_request_key ON payments (mpesa_request_id) WHERE mpesa_request_id IS NOT NULL;
