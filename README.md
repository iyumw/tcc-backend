# Safe Evidence — Backend

API de Serviço do projeto Safe Evidence (TCC), responsável por receber,
armazenar e processar as evidências digitais capturadas pelo hardware
(relógio + ESP32-CAM).

## Setup

```bash
npm install
cp .env.example .env
# edite o .env com os dados reais do seu banco
```

## Banco de dados

### Opção A — Docker (recomendado pra desenvolvimento local)

```bash
docker compose up -d
```

Isso sobe um Postgres 16 local e já cria as tabelas automaticamente na
primeira vez (o `schema.sql` é montado em
`/docker-entrypoint-initdb.d/`, que a imagem oficial do Postgres executa
sozinha quando o volume de dados está vazio). No `.env`, use
`DB_HOST=127.0.0.1`, `DB_PASSWORD=postgres` e `DB_SSL=false`, que batem
com o `docker-compose.yml`.

Pra conferir se as tabelas foram criadas:

```bash
docker exec -it safe-evidence-db psql -U postgres -d safe_evidence -c "\dt"
```

Pra derrubar o banco (mantendo os dados salvos no volume):

```bash
docker compose down
```

### Opção B — AWS RDS

Coloque o endpoint e a senha do RDS no `.env`, com `DB_SSL=true` e
`DB_SSL_CA=./global-bundle.pem`. Como liberar o acesso, baixar o
certificado e criar as tabelas: `docs/aws-setup.md`.

## Rodando localmente

```bash
npm run dev   # com auto-reload (nodemon)
# ou
npm start     # sem auto-reload
```

O servidor sobe em `http://localhost:8080` por padrão (configurável via
`PORT` no `.env`).

> Pra testar: cadastre o `dispositivo` no banco (o `id_dispositivo` precisa
> bater com o `DEVICE_ID` do firmware da ESP32-CAM), crie uma conta pelo
> portal (`POST /api/auth/cadastro`) e vincule o dispositivo a ela
> (`POST /api/perfil/dispositivo`). Detalhes em `docs/api-portal.md`.
>
> **Banco criado antes desta versão:** rode as migrações de
> `src/db/migrations/` que ainda não rodou (instruções no topo de cada uma).

## Endpoints

A API está dividida por quem chama:

| Prefixo | Quem chama | Autenticação |
| --- | --- | --- |
| `/api/captura/*` | ESP32-CAM | chave do dispositivo (ver abaixo) |
| `/api/ia/*` | serviço de IA | `IA_CALLBACK_TOKEN` (`docs/contrato-ia.md`) |
| `/api/auth/*`, `/api/perfil/*`, `/api/evidencias/*` | portal (front) | login + MFA por e-mail (`docs/api-portal.md`) |

Rotas do portal: veja **`docs/api-portal.md`** (é o documento pra quem faz
o front). Abaixo, as rotas do dispositivo e da IA.

### Autenticação da câmera

Cada dispositivo tem uma chave secreta; o banco guarda só o SHA-256 dela
(`dispositivo.chave_hash`, migração `005_chave_dispositivo.sql`). Para
cadastrar um dispositivo e gerar a chave (ou trocar uma chave vazada):

```bash
npm run chave-dispositivo -- esp32cam-01
```

A chave aparece uma vez no terminal: cole no `DEVICE_KEY` do firmware. Toda
requisição da câmera manda os cabeçalhos `X-Dispositivo-Id` e
`X-Dispositivo-Chave`; sem eles, ou com a chave errada, a resposta é `401`.
O `session_id` precisa começar com o id do próprio dispositivo
(`esp32cam-01-...`), senão `403`: uma câmera não mexe nas sessões de outra.

> `/api/evidencia/*` (sem o "s") é o endereço antigo da captura e continua
> funcionando só pra não quebrar o firmware já gravado na placa. O firmware
> novo usa `/api/captura/*`.

### Organização do código

Cada grupo de rotas tem um arquivo de rotas e um controller com o mesmo nome:

| Rotas | Controller | Quem chama |
| --- | --- | --- |
| `capturaRoutes.js` → `/api/captura` | `capturaController.js` | ESP32-CAM (frames, início/fim da sessão) |
| `iaRoutes.js` → `/api/ia` | `iaController.js` | serviço de IA (resultado da análise) |
| `authRoutes.js` → `/api/auth` | `authController.js` | portal: cadastro, login, MFA, senha |
| `perfilRoutes.js` → `/api/perfil` | `perfilController.js` | portal: dados da usuária |
| `evidenciaRoutes.js` → `/api/evidencias` | `evidenciaController.js` | portal: lista, vídeo, laudo, exclusão |

A regra de negócio fica em `src/services/` (um arquivo por assunto:
`storageService`, `pipelineIAService`, `authService`, `custodiaService`...).

### `GET /health`
Health check simples.

### `POST /api/captura/sessao/abrir`
Abre uma nova sessão de captura para um dispositivo já cadastrado.
(Endpoint auxiliar — no fluxo real com a ESP32-CAM, a sessão é aberta
automaticamente no primeiro frame recebido, ver `/upload` abaixo.)

**Body:** vazio. O dispositivo é o da chave; se mandar `id_dispositivo`,
ele tem que ser o mesmo.

### `POST /api/captura/upload`
Recebe UM frame JPEG da ESP32-CAM (chamado repetidamente durante a
gravação, a cada `INTERVALO_FRAMES_MS` do firmware). Multipart/form-data,
campos: `device_id`, `session_id`, `frame_index`, `timestamp`,
`t_captura_ms` (opcional: ms desde o início da gravação, usado pra montar
o vídeo na velocidade real) e `image` (arquivo). Os campos de texto
precisam vir antes do `image`.

Se for o primeiro frame de um `session_id` novo, a sessão é criada
automaticamente na tabela `acionamento` (vinculada ao `device_id` —
que precisa já existir na tabela `dispositivo`).

**Resposta (201):**
```json
{ "recebido": true, "frame_index": 0 }
```

### `POST /api/captura/sessao/encerrar`
Chamado pela ESP32-CAM quando recebe o comando STOP do relógio. 
Junta todos os frames recebidos daquela sessão num único
`.mp4` (via ffmpeg), calcula o hash SHA-256 do vídeo final (RN05) e
grava tudo na tabela `gravacao`. Depois de montar o vídeo, os frames
individuais são apagados.

**Body:**
```json
{ "session_id": "esp32cam-01-123456" }
```

**Resposta (201):**
```json
{
  "id_gravacao": 1,
  "url_storage": "/caminho/local/do/video.mp4",
  "hash_seguranca": "64889dbf..."
}
```

**Erros possíveis (upload e encerrar):**
- `400` — campo obrigatório ausente, ou nenhum frame recebido pra sessão
- `404` — dispositivo ou sessão não encontrados
- `500` — erro interno

### `GET /api/evidencias/:id/arquivo?expira=...&assinatura=...`
Só no modo local: serve o vídeo se a assinatura for válida e não tiver
expirado (`403` caso contrário). O link é gerado por
`GET /api/evidencias/:id/url` (portal, com login).

### `POST /api/ia/resultado/:id`
Callback chamado pelo **serviço de IA** com o resultado. Exige
`Authorization: Bearer <IA_CALLBACK_TOKEN>`. Contrato completo em
`docs/contrato-ia.md`.

## Análise por IA

Quando uma sessão é encerrada e o vídeo está salvo, o backend envia a
gravação pro serviço de IA (`IA_SERVICE_URL`). Se o serviço estiver fora do
ar ou devolver erro, tenta de novo automaticamente (1, 2, 4, 8... minutos).

Pra testar sem o modelo real, rode a IA falsa em outro terminal:

```bash
npm run ia-mock
```

e no `.env`: `IA_SERVICE_URL=http://localhost:8090` e um
`IA_CALLBACK_TOKEN` qualquer. **Banco já existente:** rode a migração
`src/db/migrations/002_pipeline_ia.sql` (instruções no topo do arquivo).

## Armazenamento (local ou AWS S3)

Sem `S3_BUCKET` no `.env`, os vídeos ficam em `tmp/videos/`. Com ele,
sobem pro bucket do S3. Passo a passo de criação do bucket, retenção
(Object Lock), permissões do IAM e testes dos CT04/CT06:
`docs/aws-setup.md`.

## Publicando na AWS

O backend roda numa EC2 (São Paulo), com HTTPS pelo Caddy e um domínio do
DuckDNS. Passo a passo completo, do zero: `docs/deploy-aws.md`. Os arquivos
de configuração do servidor ficam em `deploy/`.

Para atualizar o servidor depois de um `git push`:

```bash
cd ~/tcc-backend && bash deploy/atualizar.sh
```

## Próximos passos

- Timestamp confiável RFC 3161 — hoje só grava `data_hora` do servidor
- Guardar a chave da câmera cifrada na flash (eFuse / flash encryption) em vez de no firmware
- Perfil de colaborador interno / ordem judicial (RN11 / CT05 completo)
- Laudo em PDF (hoje o download é JSON com metadados de integridade)
