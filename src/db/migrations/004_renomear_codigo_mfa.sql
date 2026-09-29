-- Migração: renomeia a tabela dos códigos de verificação por e-mail
-- (desafio_mfa -> codigo_mfa, id_desafio -> id_codigo).
--
-- Só é necessária em bancos que rodaram a 003 ANTES dessa mudança (ex.: o
-- Postgres local do docker-compose). Num banco novo a 003 já cria a
-- codigo_mfa e esta migração não faz nada. Pode rodar mais de uma vez.
--
-- Rode assim (na pasta backend, com o Postgres do docker-compose no ar):
--   docker cp src/db/migrations/004_renomear_codigo_mfa.sql safe-evidence-db:/tmp/004.sql
--   MSYS_NO_PATHCONV=1 docker exec safe-evidence-db psql -U postgres -d safe_evidence -f /tmp/004.sql
-- (o MSYS_NO_PATHCONV=1 só é necessário no Git Bash)

DO $$
BEGIN
  IF to_regclass('public.desafio_mfa') IS NULL THEN
    RETURN;  -- nada a fazer
  END IF;

  IF to_regclass('public.codigo_mfa') IS NOT NULL THEN
    -- As duas existem: a codigo_mfa já está em uso. A desafio_mfa só tem
    -- códigos antigos (valem 5 min), então pode ser descartada.
    DROP TABLE desafio_mfa;
    RETURN;
  END IF;

  ALTER TABLE desafio_mfa RENAME TO codigo_mfa;
  ALTER TABLE codigo_mfa RENAME COLUMN id_desafio TO id_codigo;
  ALTER INDEX IF EXISTS desafio_mfa_pkey RENAME TO codigo_mfa_pkey;
  ALTER TABLE codigo_mfa RENAME CONSTRAINT desafio_mfa_finalidade_check TO codigo_mfa_finalidade_check;
  ALTER TABLE codigo_mfa RENAME CONSTRAINT desafio_mfa_id_vitima_fkey TO codigo_mfa_id_vitima_fkey;
END $$;
