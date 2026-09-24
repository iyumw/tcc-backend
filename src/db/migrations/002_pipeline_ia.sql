-- Migração: integração com o serviço de IA (RE03, RE08, RN07, RN16).
-- Pode rodar mais de uma vez sem problema.
--
-- Rode assim (na pasta backend, com o Postgres do docker-compose no ar):
--   docker cp src/db/migrations/002_pipeline_ia.sql safe-evidence-db:/tmp/002.sql
--   MSYS_NO_PATHCONV=1 docker exec safe-evidence-db psql -U postgres -d safe_evidence -f /tmp/002.sql
-- (o MSYS_NO_PATHCONV=1 só é necessário no Git Bash)

-- --- gravacao: status da análise --------------------------------------------
ALTER TABLE gravacao
  ADD COLUMN IF NOT EXISTS duracao_segundos NUMERIC(10,3),
  ADD COLUMN IF NOT EXISTS status_analise VARCHAR(20) NOT NULL DEFAULT 'Pendente',
  ADD COLUMN IF NOT EXISTS tentativas_analise INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ultimo_erro_analise TEXT,
  ADD COLUMN IF NOT EXISTS analise_atualizada_em TIMESTAMP NOT NULL DEFAULT NOW();

ALTER TABLE gravacao DROP CONSTRAINT IF EXISTS ck_status_analise;
ALTER TABLE gravacao ADD CONSTRAINT ck_status_analise
  CHECK (status_analise IN ('Pendente', 'Processando', 'Concluido', 'Erro'));

-- --- analise_ia: alinhar com o dicionário de dados (score) e com a Tabela 15 --
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'analise_ia' AND column_name = 'score_facial') THEN
    ALTER TABLE analise_ia RENAME COLUMN score_facial TO score;
  END IF;
END $$;

ALTER TABLE analise_ia DROP CONSTRAINT IF EXISTS ck_score_facial;
ALTER TABLE analise_ia DROP CONSTRAINT IF EXISTS ck_score;
ALTER TABLE analise_ia ADD CONSTRAINT ck_score CHECK (score >= 0.00 AND score <= 100.00);

ALTER TABLE analise_ia
  ADD COLUMN IF NOT EXISTS segmentos_criticos JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS versao_modelo VARCHAR(100),          -- RN07
  ADD COLUMN IF NOT EXISTS tempo_processamento_ms INTEGER,      -- RN16
  ADD COLUMN IF NOT EXISTS concluida_em TIMESTAMP NOT NULL DEFAULT NOW();
