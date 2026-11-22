-- 0005_mpesa_settings
-- Per-business M-Pesa (Daraja) settings, entered by an admin in the dashboard instead of the
-- server environment. Secrets are encrypted by the application (AES-256-GCM) before they are
-- stored; the database never holds them in plain text and the API never returns them.

CREATE TABLE mpesa_settings (
  business_id        uuid PRIMARY KEY REFERENCES businesses(id),
  enabled            boolean NOT NULL DEFAULT true,
  transaction_type   text NOT NULL DEFAULT 'paybill' CHECK (transaction_type IN ('till', 'paybill')),
  shortcode          text NOT NULL CHECK (shortcode ~ '^[0-9]{4,10}$'),
  party_b            text CHECK (party_b IS NULL OR party_b ~ '^[0-9]{4,10}$'),
  passkey_enc        text NOT NULL,
  consumer_key_enc   text,
  consumer_secret_enc text,
  updated_by         uuid REFERENCES users(id),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
