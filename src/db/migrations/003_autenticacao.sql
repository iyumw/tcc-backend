-- Migração: login com MFA, perfil, sessões e log de auditoria
-- (RE05, RE06, RE07, RE09, RE10, RE11, RE12, RN03, RN06, RN10).
-- Pode rodar mais de uma vez sem problema.
--
-- Rode assim (na pasta backend, com o Postgres do docker-compose no ar):
--   docker cp src/db/migrations/003_autenticacao.sql safe-evidence-db:/tmp/003.sql
--   MSYS_NO_PATHCONV=1 docker exec safe-evidence-db psql -U postgres -d safe_evidence -f /tmp/003.sql
-- (o MSYS_NO_PATHCONV=1 só é necessário no Git Bash)

-- --- vitima: senha, endereço de entrega, consentimento, bloqueio de login ----
ALTER TABLE vitima
  ADD COLUMN IF NOT EXISTS senha_hash VARCHAR(200),
  ADD COLUMN IF NOT EXISTS consentimento_em TIMESTAMP,
  ADD COLUMN IF NOT EXISTS cep CHAR(8),
  ADD COLUMN IF NOT EXISTS logradouro VARCHAR(150),
  ADD COLUMN IF NOT EXISTS numero VARCHAR(20),
  ADD COLUMN IF NOT EXISTS complemento VARCHAR(100),
  ADD COLUMN IF NOT EXISTS bairro VARCHAR(100),
  ADD COLUMN IF NOT EXISTS cidade VARCHAR(100),
  ADD COLUMN IF NOT EXISTS uf CHAR(2),
  -- RN10: 3 erros -> bloqueio de 30 min; depois disso, mais 2 erros -> bloqueio permanente
  ADD COLUMN IF NOT EXISTS falhas_login INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bloqueada_ate TIMESTAMP,
  ADD COLUMN IF NOT EXISTS ja_foi_bloqueada BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS bloqueio_permanente BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS criada_em TIMESTAMP NOT NULL DEFAULT NOW();

-- --- dispositivo: excluir a conta NÃO apaga o dispositivo físico, só desvincula
ALTER TABLE dispositivo DROP CONSTRAINT IF EXISTS fk_dispositivo_vitima;
ALTER TABLE dispositivo ADD CONSTRAINT fk_dispositivo_vitima
  FOREIGN KEY (id_vitima) REFERENCES vitima(id_vitima) ON DELETE SET NULL;

-- --- acionamento: a gravação pertence a quem era dona do dispositivo NA HORA
-- (se o dispositivo for reatribuído depois, as gravações antigas não mudam de dona)
ALTER TABLE acionamento ADD COLUMN IF NOT EXISTS id_vitima INTEGER;
UPDATE acionamento a SET id_vitima = d.id_vitima
  FROM dispositivo d
 WHERE d.id_dispositivo = a.id_device AND a.id_vitima IS NULL;
ALTER TABLE acionamento DROP CONSTRAINT IF EXISTS fk_acionamento_vitima;
ALTER TABLE acionamento ADD CONSTRAINT fk_acionamento_vitima
  FOREIGN KEY (id_vitima) REFERENCES vitima(id_vitima) ON DELETE CASCADE;
-- o acionamento também não deve sumir se o dispositivo for descadastrado
ALTER TABLE acionamento DROP CONSTRAINT IF EXISTS fk_acionamento_dispositivo;
ALTER TABLE acionamento ADD CONSTRAINT fk_acionamento_dispositivo
  FOREIGN KEY (id_device) REFERENCES dispositivo(id_dispositivo) ON DELETE RESTRICT;

-- --- gravacao: vínculo com processo judicial (RE09) ---------------------------
ALTER TABLE gravacao ADD COLUMN IF NOT EXISTS processo_judicial VARCHAR(50);

-- --- sessões de login (RE11: expira após 15 min sem uso) ----------------------
CREATE TABLE IF NOT EXISTS sessao (
    id_sessao UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    id_vitima INTEGER NOT NULL REFERENCES vitima(id_vitima) ON DELETE CASCADE,
    criada_em TIMESTAMP NOT NULL DEFAULT NOW(),
    ultimo_acesso TIMESTAMP NOT NULL DEFAULT NOW(),
    expira_em TIMESTAMP NOT NULL,
    encerrada_em TIMESTAMP
);

-- --- códigos de verificação por e-mail (MFA, recuperação de senha, etc.) -----
CREATE TABLE IF NOT EXISTS codigo_mfa (
    id_codigo UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    id_vitima INTEGER NOT NULL REFERENCES vitima(id_vitima) ON DELETE CASCADE,
    finalidade VARCHAR(30) NOT NULL
        CHECK (finalidade IN ('login', 'recuperar_senha', 'alterar_dados', 'excluir_conta')),
    codigo_hash CHAR(64) NOT NULL,
    expira_em TIMESTAMP NOT NULL,
    tentativas INTEGER NOT NULL DEFAULT 0,
    usado_em TIMESTAMP,
    criado_em TIMESTAMP NOT NULL DEFAULT NOW()
);

-- --- log de auditoria imutável (RN06) -----------------------------------------
-- Sem chave estrangeira de propósito: o registro continua existindo mesmo
-- depois que a conta é excluída (é a trilha de auditoria).
CREATE TABLE IF NOT EXISTS log_auditoria (
    id_log BIGSERIAL PRIMARY KEY,
    id_vitima INTEGER,
    acao VARCHAR(50) NOT NULL,
    detalhes JSONB NOT NULL DEFAULT '{}'::jsonb,
    ip VARCHAR(64),
    criado_em TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Impede UPDATE e DELETE no log, até pelo próprio backend.
CREATE OR REPLACE FUNCTION log_auditoria_imutavel() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'log_auditoria é imutável (RN06): % não permitido', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tg_log_auditoria_imutavel ON log_auditoria;
CREATE TRIGGER tg_log_auditoria_imutavel
  BEFORE UPDATE OR DELETE ON log_auditoria
  FOR EACH ROW EXECUTE FUNCTION log_auditoria_imutavel();

CREATE INDEX IF NOT EXISTS ix_log_auditoria_vitima ON log_auditoria (id_vitima, criado_em);
CREATE INDEX IF NOT EXISTS ix_acionamento_vitima ON acionamento (id_vitima);
