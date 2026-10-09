-- Carimbo de tempo RFC 3161 de cada gravação: a resposta da TSA (DER) e os
-- dados lidos dela. Pode rodar mais de uma vez.
ALTER TABLE gravacao
  ADD COLUMN IF NOT EXISTS carimbo_tempo BYTEA,
  ADD COLUMN IF NOT EXISTS carimbo_emitido_em TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS carimbo_autoridade VARCHAR(255),
  ADD COLUMN IF NOT EXISTS carimbo_numero_serie VARCHAR(80),
  ADD COLUMN IF NOT EXISTS carimbo_tentativas INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS carimbo_ultimo_erro TEXT;
