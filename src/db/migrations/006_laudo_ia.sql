-- Migração: linha do tempo da análise e resultado da IA guardado do jeito que chegou
-- (usado no laudo em PDF; o código de verificação impresso no PDF é o hash dele).
-- Pode rodar mais de uma vez sem problema.
--
-- Rode assim (na pasta backend, com o Postgres do docker-compose no ar):
--   docker cp src/db/migrations/006_laudo_ia.sql safe-evidence-db:/tmp/006.sql
--   MSYS_NO_PATHCONV=1 docker exec safe-evidence-db psql -U postgres -d safe_evidence -f /tmp/006.sql
-- (o MSYS_NO_PATHCONV=1 só é necessário no Git Bash)

ALTER TABLE analise_ia
  ADD COLUMN IF NOT EXISTS linha_do_tempo JSONB,
  ADD COLUMN IF NOT EXISTS resultado_ia JSONB;
