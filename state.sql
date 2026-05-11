CREATE TABLE IF NOT EXISTS bot_states (
  chat_id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
