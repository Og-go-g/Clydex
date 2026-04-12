-- Add session_id_str column to copy_sessions
-- Run: psql -U clydex -d clydex_history -h localhost -f scripts/add-session-id.sql

ALTER TABLE copy_sessions ADD COLUMN IF NOT EXISTS session_id_str TEXT;
