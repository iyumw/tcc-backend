# Safe Evidence — Backend

API de Serviço do projeto Safe Evidence (TCC), responsável por receber,
armazenar e processar as evidências digitais capturadas pelo hardware
(relógio + ESP32-CAM).

```
Relógio ──BLE──> ESP32-CAM ──HTTPS──> Backend (EC2) ──> RDS (metadados) + S3 (vídeos)
                                         │   ▲
                         Portal (front) ─┘   └── Serviço de IA (callback)
```

**Em produção:** `https://safeevidence.duckdns.org` (teste com `/health`).
Base da API para o front e o Postman: `https://safeevidence.duckdns.org/api`.

## Setup

Requer **Node.js 22** (o ffmpeg vem junto, pelo pacote `ffmpeg-static`).

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

> Pra testar com a câmera: cadastre o dispositivo e gere a chave dele
> (`npm run chave-dispositivo -- esp32cam-01`, ver "Autenticação da câmera"),
> crie uma conta pelo portal (`POST /api/auth/cadastro`) e vincule o
> dispositivo a ela (`POST /api/perfil/dispositivo`). Detalhes em
> `docs/api-portal.md`.
>
> **Banco criado antes desta versão:** rode as migrações de
> `src/db/migrations/` que ainda não rodou (instruções no topo de cada uma;
> todas podem rodar mais de uma vez).

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

> O apelido antigo `/api/evidencia/*` (sem o "s") e a rota
> `/sessao/abrir` foram removidos em 08/10/2026: o firmware usa só
> `/api/captura/upload` e `/api/captura/sessao/encerrar`.

### Organização do código

Cada grupo de rotas tem um arquivo de rotas e um controller com o mesmo nome:

| Rotas | Controller | Quem chama |
| --- | --- | --- |
| `capturaRoutes.js` → `/api/captura` | `capturaController.js` | ESP32-CAM (frames e fim da sessão) |
| `iaRoutes.js` → `/api/ia` | `iaController.js` | serviço de IA (resultado da análise) |
| `authRoutes.js` → `/api/auth` | `authController.js` | portal: cadastro, login, MFA, senha |
| `perfilRoutes.js` → `/api/perfil` | `perfilController.js` | portal: dados da usuária |
| `evidenciaRoutes.js` → `/api/evidencias` | `evidenciaController.js` | portal: lista, vídeo, laudo, exclusão |

A regra de negócio fica em `src/services/` (um arquivo por assunto:
`storageService`, `pipelineIAService`, `authService`, `custodiaService`...).
A parte da IA está dividida em `clienteIa` (HTTP com o serviço de IA),
`validacaoResultadoIA` (callback), `laudoService` (laudo JSON/PDF) e
`pipelineIAService` (fila de análise e reenvios).
Validações e helpers usados em vários lugares (CPF, e-mail, senha, ids)
ficam em `src/utils/`. Os controllers não têm `try/catch`: o
`comTratamentoDeErros` repassa qualquer erro ao `tratadorDeErros`, que responde
sempre `{ "erro": "...", "codigo": "..." }`.

### `GET /health`
Health check simples.

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

Limites: só JPEG (`Content-Type: image/jpeg` e conteúdo começando com a
assinatura de JPEG, senão `415`), até 2 MB por frame e 20.000 frames por
sessão (`413`).

**Resposta (201):**
```json
{ "recebido": true, "frame_index": 0 }
```

### `POST /api/captura/sessao/encerrar`
Chamado pela ESP32-CAM quando recebe o comando STOP do relógio.
Responde na hora (`202`) e, em segundo plano, junta os frames daquela
sessão num único `.mp4` (via ffmpeg), calcula o hash SHA-256 do vídeo
(RN05), guarda o vídeo (local ou S3), grava a linha em `gravacao` e manda
o vídeo para a IA. Depois de montar o vídeo, os frames individuais são
apagados. O resultado aparece no log do backend e em `GET /api/evidencias`.

**Body:**
```json
{ "session_id": "esp32cam-01-123456" }
```

**Resposta (202):**
```json
{ "session_id": "esp32cam-01-123456", "status": "processando" }
```

Encerrar de novo a mesma sessão não monta outro vídeo: enquanto a montagem
anda, a resposta continua `202`; depois de pronta, é `200` com
`"status": "concluida"` e o `id_gravacao`. Se o backend cair no meio da
montagem, ela é retomada sozinha quando ele subir de novo.

**Erros possíveis (upload e encerrar):**
- `400` — campo obrigatório ausente, ou nenhum frame recebido pra sessão
- `401` — sem chave do dispositivo, ou chave errada
- `403` — `device_id` ou `session_id` de outro dispositivo
- `404` — sessão não encontrada
- `413` — frame grande demais ou sessão com frames demais
- `415` — o arquivo não é JPEG
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
`IA_CALLBACK_TOKEN` qualquer. Sem `IA_SERVICE_URL`, as análises ficam
`Pendente` até o serviço ser configurado.

O laudo em PDF ("Download de Segurança", `GET /api/evidencias/:id/laudo.pdf`)
também é gerado pelo serviço de IA (`POST {IA_SERVICE_URL}/laudo`); a IA falsa
devolve um PDF de teste. **Banco já existente:** rode as migrações
`006_laudo_ia.sql` e `007_finalizacao_idempotente.sql` (esta impede que
encerrar a mesma sessão duas vezes gere duas gravações) e
`008_carimbo_tempo.sql`.

## Carimbo de tempo (RFC 3161)

Cada vídeo montado recebe um carimbo de tempo de uma autoridade externa
(FreeTSA, por padrão), que prova a data do hash sem depender do relógio do
servidor. O arquivo `.tsr` sai em `GET /api/evidencias/:id/carimbo.tsr`.
Configuração, API e como verificar com o `openssl`: `docs/carimbo-tempo.md`.

## Testando sem a câmera

Para simular uma gravação (gera frames de teste com o ffmpeg, envia com a
chave do dispositivo e encerra a sessão):

```bash
npm run simular-camera -- --chave <DEVICE_KEY>
# opções: --url http://localhost:8080  --id esp32cam-01  --segundos 10
```

Funciona contra o backend local ou o da nuvem (`--url https://...`).

## Testes automáticos

Os testes cobrem a parte do backend dos casos de teste do TCC (CT01 a CT11).
Cada arquivo em `tests/` sobe um backend próprio, com um banco temporário
(criado e apagado no fim) e o e-mail desligado. Nada é gravado no RDS, no S3
ou no Gmail. A análise dos vídeos é feita pela **IA real** (YOLOv9).

Antes de rodar:

1. Postgres onde o usuário possa criar bancos. O mais simples é o do Docker
   (`docker compose up -d`, Opção A acima).
2. IA real rodando **no mesmo computador** (ela baixa o vídeo e devolve o
   laudo em `127.0.0.1`). Na pasta `Projeto_YOLO_violencia`, com `IA_TOKEN` e
   `IA_CALLBACK_TOKEN` iguais aos do `.env` do backend:

   ```bash
   uvicorn servico.app:app --host 127.0.0.1 --port 8090
   ```

Depois:

```bash
npm test
```

Os arquivos rodam um de cada vez (a IA analisa um vídeo por vez). Os testes
leem `IA_SERVICE_URL`, `IA_TOKEN` e `IA_CALLBACK_TOKEN` do `.env`; para usar
outros valores, defina `TESTE_IA_URL`, `TESTE_IA_TOKEN` e
`TESTE_IA_CALLBACK_TOKEN`. Se a IA estiver lenta (CPU), aumente a espera com
`TESTE_IA_TEMPO_MAXIMO_S` (padrão: 600).

O CT03 usa um vídeo sintético de 5 s. Para medir com um vídeo de verdade
(ex.: agressão encenada), informe o vídeo e o segundo em que a agressão
acontece:

```powershell
$env:TESTE_VIDEO="C:\caminho\encenacao.mp4"; $env:TESTE_VIDEO_AGRESSAO_S="12"; node --test tests/ct03-tempo-ia.test.js
```

Para usar outro Postgres, defina antes `TESTE_DB_HOST`, `TESTE_DB_PORT`,
`TESTE_DB_USER`, `TESTE_DB_PASSWORD` e, se ele exigir SSL (como o RDS),
`TESTE_DB_SSL=true`.

O que cada teste verifica e o que fica para teste manual (relógio, câmera e
front) está em [docs/casos-de-teste.md](docs/casos-de-teste.md).

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

- Guardar a chave da câmera cifrada na flash (eFuse / flash encryption) em vez de no firmware
- Perfil de colaborador interno / ordem judicial (RN11 / CT05 completo)
