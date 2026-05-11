CREATE TABLE IF NOT EXISTS wars (
  war_id TEXT PRIMARY KEY,
  clan_tag TEXT NOT NULL,
  opponent_tag TEXT,
  opponent_name TEXT,
  state TEXT,
  preparation_start_time TEXT,
  start_time TEXT,
  end_time TEXT,
  attacks_per_member INTEGER,
  raw_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attacks (
  attack_key TEXT PRIMARY KEY,
  war_id TEXT NOT NULL,
  attacker_tag TEXT NOT NULL,
  attacker_name TEXT,
  defender_tag TEXT NOT NULL,
  defender_name TEXT,
  stars INTEGER NOT NULL,
  destruction_percentage REAL NOT NULL,
  order_no INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_attacks_war_order
ON attacks (war_id, order_no);

CREATE TABLE IF NOT EXISTS reminders (
  war_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  PRIMARY KEY (war_id, kind)
);

CREATE TABLE IF NOT EXISTS player_links (
  tg_user_id TEXT NOT NULL,
  tg_username TEXT,
  player_tag TEXT NOT NULL,
  player_name TEXT,
  town_hall_level INTEGER,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tg_user_id, player_tag)
);
