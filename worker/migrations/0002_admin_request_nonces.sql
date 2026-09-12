CREATE TABLE admin_request_nonces (
  nonce TEXT PRIMARY KEY NOT NULL,
  used_at INTEGER NOT NULL
);

CREATE INDEX idx_admin_request_nonces_used_at
ON admin_request_nonces(used_at);
