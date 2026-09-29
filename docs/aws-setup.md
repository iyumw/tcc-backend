# AWS: configuração e testes (S3 + RDS)

O backend usa dois serviços da AWS, os dois na região **sa-east-1 (São Paulo)**:

| Serviço | Pra quê | Variáveis do `.env` |
| --- | --- | --- |
| **RDS (PostgreSQL)** | metadados: contas, gravações, laudos, log | `DB_*` |
| **S3** | os vídeos | `S3_BUCKET`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` |

Os vídeos têm dois modos, escolhidos pelo `S3_BUCKET`:

| Modo | Quando | Onde fica o vídeo | URL de acesso |
| --- | --- | --- | --- |
| Local | `S3_BUCKET` vazio | `tmp/videos/` | assinada pelo próprio backend, rota `/api/evidencias/:id/arquivo` |
| S3 | `S3_BUCKET` preenchido | `s3://<bucket>/videos/<session_id>.mp4` | URL pré-assinada do S3 |

---

## 1. Banco (RDS)

### Acesso

No console do RDS, na instância:

- **Publicly accessible:** Yes (pra conectar do PC durante o desenvolvimento).
- **Security group → Inbound rules:** PostgreSQL, TCP 5432, origem = IP de
  quem vai conectar (`curl ifconfig.me` mostra o seu). O IP muda quando se
  troca de rede.

### `.env`

```
DB_HOST=<endpoint do RDS>
DB_PORT=5432
DB_NAME=safe_evidence
DB_USER=postgres
DB_PASSWORD=<senha>
DB_SSL=true
DB_SSL_CA=./global-bundle.pem
```

O RDS exige SSL. O `global-bundle.pem` é o certificado da AWS, que permite
ao backend conferir que está falando com o RDS de verdade:

```bash
curl -o global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
```

### Criar as tabelas

Com o `psql` do Docker (no Git Bash, na pasta `backend`):

```bash
RDS="host=<endpoint do RDS> port=5432 user=postgres dbname=safe_evidence sslmode=require"
export PGPASSWORD=<senha>

MSYS_NO_PATHCONV=1 docker run --rm -e PGPASSWORD -v "$(pwd -W)/src/db:/sql" postgres:16 \
  psql "$RDS" -v ON_ERROR_STOP=1 -f /sql/schema.sql -f /sql/migrations/003_autenticacao.sql

docker run --rm -e PGPASSWORD postgres:16 psql "$RDS" \
  -c "INSERT INTO dispositivo (id_dispositivo, status_bateria) VALUES ('esp32cam-01', 100) ON CONFLICT DO NOTHING;"
```

Banco que já tinha tabelas: rode só as migrações de `src/db/migrations/`
que faltam (todas podem rodar mais de uma vez).

---

## 2. Vídeos (S3)

### Criar o bucket

No console do S3, **Create bucket**:

- **Region:** sa-east-1.
- **Bucket name:** único no mundo todo, ex.: `safe-evidence-videos-<sufixo>`.
- **Block all public access:** marcado. A única forma de ver um vídeo é pela
  URL pré-assinada.
- **Bucket Versioning:** Enable (o Object Lock exige).
- **Default encryption:** SSE-S3 (AES-256). É o padrão; atende o RN01.
- **Object Lock:** Enable (em *Advanced settings*).

### Retenção / WORM (RN09)

Depois de criado: **Properties → Object Lock → Edit → Default retention**.

| Uso | Modo | Prazo |
| --- | --- | --- |
| Testes | **Governance** | 1 dia |
| Produção | **Compliance** | 5 anos |

Com retenção, nenhuma versão de vídeo pode ser apagada ou alterada antes do
prazo.

> ⚠️ **Não use Compliance no bucket de testes.** No modo Compliance nem o
> dono da conta AWS consegue apagar os objetos antes do prazo: os vídeos de
> teste ficariam lá (e sendo cobrados) por 5 anos. O Governance protege do
> mesmo jeito contra o backend e usuários comuns, mas um administrador ainda
> consegue liberar. No TCC, dá pra documentar a configuração de produção e
> testar com Governance.

### Usuário do backend (IAM)

O backend acessa o S3 com um usuário do IAM (as chaves vão no `.env`). Dê
a ele **só** o necessário, com esta política (troque o nome do bucket):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "VideosLerEGravar",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject"],
      "Resource": "arn:aws:s3:::NOME-DO-BUCKET/videos/*"
    },
    {
      "Sid": "ListarParaSaberSeExiste",
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::NOME-DO-BUCKET"
    }
  ]
}
```

- Sem `s3:DeleteObject`: nem um bug no backend consegue apagar uma
  evidência. Bom argumento pra seção de segurança. A consequência é que a
  exclusão pelo portal (RE09/RE12) apaga os dados do banco, mas o vídeo
  continua no bucket até um administrador remover; o log do backend avisa.
  Se o grupo preferir que o portal apague o vídeo, acrescente
  `s3:DeleteObject`. Com Object Lock, o S3 só esconde o vídeo (marcador de
  exclusão) e a versão original continua guardada até o fim da retenção.
- `s3:ListBucket` faz o S3 responder "não existe" (404) em vez de "acesso
  negado" (403) quando um vídeo some.

### `.env`

```
S3_BUCKET=<nome do bucket>
AWS_REGION=sa-east-1
AWS_ACCESS_KEY_ID=<access key do usuário do IAM>
AWS_SECRET_ACCESS_KEY=<secret access key>
```

E instale as bibliotecas:

```bash
npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner
```

> ⚠️ **Nunca suba as chaves para o Git.** O `.env` já está no `.gitignore`.
> Se uma chave vazar, desative no IAM e gere outra.

### Como o upload protege a evidência

- **Write once:** o upload usa `If-None-Match: *`, então um reenvio nunca
  sobrescreve um vídeo que já está no bucket.
- **Integridade na chegada:** o backend manda o SHA-256 junto e o S3 recusa
  o upload se o arquivo chegar diferente.
- **Metadados:** cada objeto guarda `sha256`, `session_id` e `recebido_em`.

---

## 3. Testando os endpoints

As rotas do vídeo exigem login (ver `docs/api-portal.md`). Faça login,
copie o `token` e use o `id_gravacao` que aparece em `GET /api/evidencias`:

```bash
TOKEN="cole-o-token-aqui"

# URL temporária (RN04 / CT06)
curl -H "Authorization: Bearer $TOKEN" http://localhost:8080/api/evidencias/1/url

# Verificação de integridade (RN05 / CT04)
curl -H "Authorization: Bearer $TOKEN" http://localhost:8080/api/evidencias/1/integridade
```

No modo S3, o `url` começa com `https://<bucket>.s3.sa-east-1.amazonaws.com/`.
A integridade responde `200` com `"integro": true`, ou `409` com
`"integro": false`, o hash esperado e o calculado.

### CT04: adulteração de 1 byte

**Modo local** (PowerShell, na pasta `backend`). Rodar uma vez adultera o
byte 1024; rodar de novo restaura o original:

```powershell
$f = "tmp\videos\NOME_DA_SESSAO.mp4"
$b = [IO.File]::ReadAllBytes($f); $b[1024] = $b[1024] -bxor 1; [IO.File]::WriteAllBytes($f, $b)
```

**Modo S3:** baixe o vídeo pelo console do S3, adultere com o comando acima
e envie de volta com o **mesmo nome** (Upload no console). Com versionamento,
o S3 não apaga o original: ele vira uma versão antiga, e a adulterada passa
a ser a atual. A verificação de integridade lê a atual e deve responder
`409`. Isso mostra as duas proteções juntas: o hash detecta a adulteração e
o versionamento + Object Lock preservam o original.

### CT06: expiração da URL

Suba o backend com `URL_VALIDADE_MINUTOS=1`, gere a URL, espere 2 minutos e
abra: o S3 responde `403` ("Request has expired"). Depois volte para 15.

Uma limitação a registrar: a URL assinada vale para quem tiver o link
durante os 15 min. O que o login garante é que só a dona consegue **gerar**
o link (`GET /api/evidencias/:id/url` de outra conta devolve `403`); o
critério do CT06 "URL copiada por outra sessão retorna 403" não é atendido
por URLs pré-assinadas, e vale registrar isso no TCC.
