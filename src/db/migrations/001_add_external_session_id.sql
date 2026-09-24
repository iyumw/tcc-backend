-- Migração pra quem já criou o banco ANTES desta mudança (adiciona a
-- coluna sem precisar apagar/recriar as tabelas existentes).
--
-- Rode assim:
--   docker exec -it safe-evidence-db psql -U postgres -d safe_evidence -f - < src/db/migrations/001_add_external_session_id.sql
-- ou, se estiver usando psql direto:
--   psql "postgresql://USUARIO:SENHA@HOST:5432/safe_evidence" -f src/db/migrations/001_add_external_session_id.sql

ALTER TABLE acionamento
  ADD COLUMN IF NOT EXISTS external_session_id VARCHAR(100) UNIQUE;
