# Google Cloud Storage: configuração e testes

O backend funciona em **dois modos**, escolhidos pela variável `GCS_BUCKET`
no `.env`:

| Modo | Quando | Onde fica o vídeo | URL de acesso |
| --- | --- | --- | --- |
| Local | `GCS_BUCKET` vazio | `tmp/videos/` | assinada pelo próprio backend (HMAC), rota `/api/evidencias/:id/arquivo` |
| GCS | `GCS_BUCKET` preenchido | `gs://<bucket>/videos/<session_id>.mp4` | URL pré-assinada V4 do GCS |

Dá para testar tudo no modo local primeiro e só depois ligar o GCS.

---

## 1. Instalar a biblioteca

```bash
npm install @google-cloud/storage
```

(Só é carregada no modo GCS. No modo local não é obrigatória.)

## 2. Criar o bucket

Troque `SEU_PROJETO` e o nome do bucket (tem que ser único no mundo todo).

```bash
gcloud config set project SEU_PROJETO
gcloud services enable storage.googleapis.com

gcloud storage buckets create gs://safe-evidence-videos-SEUSUFIXO \
  --location=southamerica-east1 \
  --uniform-bucket-level-access \
  --public-access-prevention
```

- **Criptografia em repouso (RN01):** o GCS cifra todo objeto com AES-256
  por padrão, sem configuração extra.
- **Acesso público bloqueado:** a única forma de ver um vídeo é pela URL
  pré-assinada.

## 3. Retenção / WORM (RN09)

```bash
# Para testes: retenção curta e NÃO travada
gcloud storage buckets update gs://safe-evidence-videos-SEUSUFIXO --retention-period=1d
```

Com retenção ativa, nenhum objeto pode ser apagado ou sobrescrito antes do
prazo, nem pelo dono do projeto.

> ⚠️ **Não use 5 anos nem trave a política (`--lock-retention-period`) no
> bucket de testes.** Travar é irreversível: você não conseguiria apagar os
> vídeos de teste, nem o bucket, por 5 anos, e continuaria pagando por eles.
> Os 5 anos do RN09 valem para produção. No TCC, dá para documentar o
> comando de produção e rodar os testes com `1d`.

## 4. Service account do backend

```bash
gcloud iam service-accounts create safe-evidence-backend

SA=safe-evidence-backend@SEU_PROJETO.iam.gserviceaccount.com
BUCKET=gs://safe-evidence-videos-SEUSUFIXO

# Pode criar e ler objetos; NÃO pode apagar nem sobrescrever
gcloud storage buckets add-iam-policy-binding $BUCKET --member=serviceAccount:$SA --role=roles/storage.objectCreator
gcloud storage buckets add-iam-policy-binding $BUCKET --member=serviceAccount:$SA --role=roles/storage.objectViewer
```

Como o backend não tem permissão de apagar, nem um bug nele consegue
destruir uma evidência. Isso é um bom argumento para a seção de segurança.

### Rodando localmente com o GCS

```bash
gcloud iam service-accounts keys create chave-gcs.json --iam-account=$SA
```

No `.env`:

```
GCS_BUCKET=safe-evidence-videos-SEUSUFIXO
GOOGLE_APPLICATION_CREDENTIALS=./chave-gcs.json
```

> ⚠️ **Nunca suba o `chave-gcs.json` para o Git.** Coloque `chave-gcs.json`
> e `.env` no `.gitignore`.
>
> Use a chave da service account, não o `gcloud auth application-default
> login`: com credencial de usuário o GCS não consegue gerar URL assinada.

### No Cloud Run

Não precisa de chave JSON: rode o serviço com essa service account
(`--service-account=$SA`). Para gerar URLs assinadas lá, ela também precisa
poder assinar em nome de si mesma:

```bash
gcloud iam service-accounts add-iam-policy-binding $SA \
  --member=serviceAccount:$SA --role=roles/iam.serviceAccountTokenCreator
```

---

## 5. Testando os endpoints

As rotas do vídeo exigem login (ver `docs/api-portal.md`). Faça login,
copie o `token` e use o `id_gravacao` que aparece no log do backend
(`gravacao <id>`) ou em `GET /api/evidencias`:

```bash
TOKEN="cole-o-token-aqui"

# URL temporária (RN04 / CT06)
curl -H "Authorization: Bearer $TOKEN" http://localhost:8080/api/evidencias/1/url

# Verificação de integridade (RN05 / CT04)
curl -H "Authorization: Bearer $TOKEN" http://localhost:8080/api/evidencias/1/integridade
```

Resposta da integridade: `200` com `"integro": true`, ou `409` com
`"integro": false`, o hash esperado e o calculado.

### CT04: adulteração de 1 byte

**Modo local** (PowerShell, na pasta `backend`). Rodar uma vez adultera o
byte 1024, e rodar de novo restaura o original (é a condição de contorno do
CT04):

```powershell
$f = "tmp\videos\NOME_DA_SESSAO.mp4"
$b = [IO.File]::ReadAllBytes($f); $b[1024] = $b[1024] -bxor 1; [IO.File]::WriteAllBytes($f, $b)
```

**Modo GCS:** com a retenção do passo 3 ativa, o GCS **recusa** sobrescrever
o objeto, e isso por si só já é um resultado a registrar (o WORM impediu a
adulteração). Para medir a detecção pelo hash, use um bucket de teste sem
retenção:

```bash
gcloud storage cp gs://BUCKET/videos/SESSAO.mp4 video.mp4
# altere o byte 1024 como acima
gcloud storage cp video.mp4 gs://BUCKET/videos/SESSAO.mp4
```

### CT06: expiração da URL

Para não esperar 16 minutos, suba o servidor com `URL_VALIDADE_MINUTOS=1`,
gere a URL, espere 2 minutos e abra. No modo local a resposta é `403`. No
modo GCS, quem responde é o Google, e para URL expirada ele costuma devolver
`400` ("Request has expired"), não `403`. Anote o código que aparecer e
ajuste o critério do CT06 se precisar. Depois volte para 15.

Uma limitação a registrar: a URL assinada vale para quem tiver o link
durante os 15 min. O que o login garante é que só a dona consegue **gerar**
o link (`GET /api/evidencias/:id/url` de outra conta devolve `403`); o
critério do CT06 "URL copiada por outra sessão retorna 403" não é atendido
por URLs pré-assinadas e vale registrar isso no TCC.
