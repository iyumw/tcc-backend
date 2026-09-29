-- Migração: chave secreta por dispositivo (autenticação da ESP32-CAM nas
-- rotas /api/captura/*). Guarda só o SHA-256 da chave, nunca a chave.
-- Pode rodar mais de uma vez sem problema.
--
-- Depois de rodar, gere a chave de cada câmera com:
--   npm run chave-dispositivo -- esp32cam-01
--
-- Rode assim (na pasta backend, com o Postgres do docker-compose no ar):
--   docker cp src/db/migrations/005_chave_dispositivo.sql safe-evidence-db:/tmp/005.sql
--   MSYS_NO_PATHCONV=1 docker exec safe-evidence-db psql -U postgres -d safe_evidence -f /tmp/005.sql
-- (o MSYS_NO_PATHCONV=1 só é necessário no Git Bash)

ALTER TABLE dispositivo ADD COLUMN IF NOT EXISTS chave_hash CHAR(64);
