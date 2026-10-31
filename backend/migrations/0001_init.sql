PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  short_name TEXT NOT NULL,
  logo_path TEXT NOT NULL,
  color TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  nickname TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS wallets (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  balance INTEGER NOT NULL DEFAULT 1000 CHECK(balance >= 0),
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY,
  round_no INTEGER NOT NULL,
  home_team_id INTEGER NOT NULL REFERENCES teams(id),
  away_team_id INTEGER NOT NULL REFERENCES teams(id),
  starts_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','live','finished')),
  home_score INTEGER NOT NULL DEFAULT 0,
  away_score INTEGER NOT NULL DEFAULT 0,
  seed INTEGER NOT NULL,
  odds_home REAL NOT NULL DEFAULT 2.10,
  odds_draw REAL NOT NULL DEFAULT 3.20,
  odds_away REAL NOT NULL DEFAULT 2.80,
  created_at INTEGER NOT NULL,
  UNIQUE(starts_at, home_team_id, away_team_id)
);

CREATE TABLE IF NOT EXISTS bets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  match_id TEXT NOT NULL REFERENCES matches(id),
  pick TEXT NOT NULL CHECK(pick IN ('home','draw','away')),
  stake INTEGER NOT NULL CHECK(stake > 0 AND stake <= 500),
  odds REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','settled')),
  payout INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  settled_at INTEGER,
  UNIQUE(user_id, match_id)
);

CREATE TABLE IF NOT EXISTS match_events (
  id TEXT PRIMARY KEY,
  match_id TEXT NOT NULL REFERENCES matches(id),
  minute INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  team_id INTEGER,
  description TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_matches_start ON matches(starts_at, status);
CREATE INDEX IF NOT EXISTS idx_bets_match ON bets(match_id, status);
CREATE INDEX IF NOT EXISTS idx_bets_user ON bets(user_id, created_at DESC);

INSERT OR IGNORE INTO teams(id,name,short_name,logo_path,color) VALUES
(1,'الأهلي المصري','الأهلي','logos/teams/00.svg','#c51f32'),
(2,'الزمالك','الزمالك','logos/teams/01.svg','#f5f5f5'),
(3,'بيراميدز','بيراميدز','logos/teams/02.svg','#4b8fe8'),
(4,'الإسماعيلي','الإسماعيلي','logos/teams/03.svg','#f4c542'),
(5,'ليفربول','ليفربول','logos/teams/04.svg','#c8102e'),
(6,'مانشستر سيتي','مان سيتي','logos/teams/05.svg','#6caddf'),
(7,'مانشستر يونايتد','مان يونايتد','logos/teams/06.svg','#da291c'),
(8,'أرسنال','أرسنال','logos/teams/07.svg','#ef0107'),
(9,'تشيلسي','تشيلسي','logos/teams/08.svg','#034694'),
(10,'توتنهام','توتنهام','logos/teams/09.svg','#132257');
