-- Encerrar a mesma sessão duas vezes não pode gerar duas gravações.
-- finalizacao_iniciada_em marca a montagem em andamento; o índice único
-- garante uma gravação por acionamento.
ALTER TABLE acionamento ADD COLUMN IF NOT EXISTS finalizacao_iniciada_em TIMESTAMP;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM gravacao GROUP BY id_acionamento HAVING COUNT(*) > 1) THEN
    RAISE WARNING 'Há acionamentos com mais de uma gravação. Apague as duplicadas e rode esta migração de novo.';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS uk_gravacao_acionamento ON gravacao (id_acionamento);
  END IF;
END $$;
