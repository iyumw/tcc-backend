-- Schema do banco de dados do Safe Evidence.
-- Idêntico ao script apresentado no Apêndice A do TCC (Tabela 4 - Dicionário
-- de dados). Rode este arquivo uma vez pra criar as tabelas no AWS RDS
-- (ou em qualquer Postgres local pra desenvolvimento).

CREATE TABLE vitima (
    id_vitima SERIAL,
    nome VARCHAR(100) NOT NULL,
    cpf CHAR(11) NOT NULL,
    telefone VARCHAR(15) NOT NULL,
    email VARCHAR(100) NOT NULL,
    consentimento BOOLEAN NOT NULL,
    CONSTRAINT pk_vitima PRIMARY KEY (id_vitima),
    CONSTRAINT uk_vitima_cpf UNIQUE (cpf),
    CONSTRAINT uk_vitima_email UNIQUE (email)
);

CREATE TABLE dispositivo (
    id_dispositivo VARCHAR(50),
    id_vitima INTEGER UNIQUE,
    status_bateria INTEGER,
    CONSTRAINT pk_dispositivo PRIMARY KEY (id_dispositivo),
    CONSTRAINT fk_dispositivo_vitima
        FOREIGN KEY (id_vitima)
        REFERENCES vitima(id_vitima)
        ON DELETE CASCADE,
    CONSTRAINT ck_status_bateria
        CHECK (status_bateria >= 0 AND status_bateria <= 100)
);

CREATE TABLE acionamento (
    id_acionamento SERIAL,
    id_device VARCHAR(50) NOT NULL,
    data_hora TIMESTAMP DEFAULT NOW(),
    -- Identificador de sessão gerado pela própria ESP32-CAM (String(DEVICE_ID)
    -- + "-" + millis(), ver firmware da Amanda). É por esse valor que o
    -- backend correlaciona os frames recebidos e o aviso de encerramento
    -- com a linha certa desta tabela — não existe um "abrir sessão" prévio
    -- vindo do dispositivo, então essa linha é criada no primeiro frame
    -- que chega com um external_session_id ainda não visto.
    external_session_id VARCHAR(100) UNIQUE,
    CONSTRAINT pk_acionamento PRIMARY KEY (id_acionamento),
    CONSTRAINT fk_acionamento_dispositivo
        FOREIGN KEY (id_device)
        REFERENCES dispositivo(id_dispositivo)
        ON DELETE CASCADE
);

CREATE TABLE camera (
    id_camera VARCHAR(50),
    status_rede VARCHAR(20) NOT NULL,
    CONSTRAINT pk_camera PRIMARY KEY (id_camera),
    CONSTRAINT ck_status_rede
        CHECK (status_rede IN ('Ativa', 'Inativa'))
);

CREATE TABLE gravacao (
    id_gravacao SERIAL,
    id_acionamento INTEGER NOT NULL,
    url_storage VARCHAR(255) NOT NULL,
    hash_seguranca CHAR(64) NOT NULL,
    duracao_segundos NUMERIC(10,3),
    -- Status da análise de IA (RE08): Pendente -> Processando -> Concluido / Erro
    status_analise VARCHAR(20) NOT NULL DEFAULT 'Pendente',
    tentativas_analise INTEGER NOT NULL DEFAULT 0,
    ultimo_erro_analise TEXT,
    analise_atualizada_em TIMESTAMP NOT NULL DEFAULT NOW(),
    CONSTRAINT pk_gravacao PRIMARY KEY (id_gravacao),
    CONSTRAINT ck_status_analise
        CHECK (status_analise IN ('Pendente', 'Processando', 'Concluido', 'Erro')),
    CONSTRAINT fk_gravacao_acionamento
        FOREIGN KEY (id_acionamento)
        REFERENCES acionamento(id_acionamento)
        ON DELETE CASCADE
);

CREATE TABLE analise_ia (
    id_analise SERIAL,
    id_gravacao INTEGER NOT NULL,
    score NUMERIC(5,2) NOT NULL,
    veredicto VARCHAR(20) NOT NULL,
    -- Trechos com indício de agressão: [{"inicio_s": 2.0, "fim_s": 5.0, "score": 91.3}, ...]
    segmentos_criticos JSONB NOT NULL DEFAULT '[]'::jsonb,
    versao_modelo VARCHAR(100),          -- RN07
    tempo_processamento_ms INTEGER,      -- RN16
    concluida_em TIMESTAMP NOT NULL DEFAULT NOW(),
    CONSTRAINT pk_analise_ia PRIMARY KEY (id_analise),
    CONSTRAINT fk_analise_ia_gravacao
        FOREIGN KEY (id_gravacao)
        REFERENCES gravacao(id_gravacao)
        ON DELETE CASCADE,
    CONSTRAINT uk_analise_ia_gravacao
        UNIQUE (id_gravacao),
    CONSTRAINT ck_score
        CHECK (score >= 0.00 AND score <= 100.00),
    CONSTRAINT ck_veredicto
        CHECK (veredicto IN ('Alerta Alto', 'Anomalia', 'Normal'))
);
