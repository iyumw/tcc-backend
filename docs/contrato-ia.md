# Contrato entre o backend e o serviço de IA

Este documento define como o backend e o serviço de IA conversam. O modelo
(YOLO) roda num **serviço separado**, com a API que você quiser (FastAPI,
Flask...). Ele só precisa seguir as duas chamadas abaixo.

```
 backend                                   serviço de IA
    │  1. POST /analisar  (pedido)              │
    │ ─────────────────────────────────────────▶│
    │ ◀──────────────── 202 Accepted ───────────│  responde na hora
    │                                           │  baixa o vídeo, roda o modelo...
    │  2. POST /api/ia/resultado/:id (callback) │
    │ ◀─────────────────────────────────────────│
    │ ─────────────── 201 Created ─────────────▶│
```

Por que em duas partes: a análise demora (RN16 permite até 50% da duração do
vídeo), e segurar uma requisição HTTP aberta esse tempo todo é frágil. O
serviço aceita o pedido na hora e devolve o resultado quando terminar.

---

## 1. Pedido de análise (backend → IA)

`POST {IA_SERVICE_URL}/analisar`

Cabeçalhos:

```
Content-Type: application/json
Authorization: Bearer <IA_TOKEN>        (se IA_TOKEN estiver configurado)
```

Corpo:

```json
{
  "id_gravacao": 12,
  "video_url": "https://<bucket>.s3.sa-east-1.amazonaws.com/...(URL assinada, vale 60 min)",
  "video_url_expira_em": "2026-09-22T23:50:00.000Z",
  "hash_sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "duracao_segundos": 16.44,
  "callback_url": "https://backend.../api/ia/resultado/12",
  "tentativa": 1
}
```

| Campo | O que é |
| --- | --- |
| `video_url` | Link pra baixar o `.mp4` com um GET simples, sem login. Expira em 60 min. |
| `hash_sha256` | Hash registrado quando o vídeo chegou. **Confira antes de analisar** (ver abaixo). |
| `duracao_segundos` | Duração do vídeo. |
| `callback_url` | Para onde mandar o resultado. Use exatamente esta URL. |
| `tentativa` | 1 na primeira vez. Se for maior, é uma nova tentativa depois de um erro. |

**Resposta esperada:** `202` (ou qualquer 2xx), sem esperar a análise
terminar. Se o serviço responder outro código ou demorar mais de 10 s, o
backend marca a gravação como `Erro` e tenta de novo depois.

## 2. Resultado (IA → backend)

`POST {callback_url}`

Cabeçalhos:

```
Content-Type: application/json
Authorization: Bearer <IA_CALLBACK_TOKEN>
```

### Análise concluída

```json
{
  "status": "concluido",
  "score": 95.24,
  "veredicto": "Alerta Alto",
  "segmentos_criticos": [
    { "inicio_s": 2.0, "fim_s": 5.0, "score": 96.1 },
    { "inicio_s": 12.0, "fim_s": 14.0, "score": 88.7 }
  ],
  "versao_modelo": "Violence-Detection-V2.1-Alpha",
  "tempo_processamento_ms": 4210,
  "hash_sha256_verificado": "e3b0c442...b855"
}
```

| Campo | Obrigatório | Regra |
| --- | --- | --- |
| `status` | sim | `"concluido"` |
| `score` | sim | 0 a 100: probabilidade de agressão no vídeo como um todo (Tabela 15: `indice_probabilidade`) |
| `veredicto` | sim | exatamente `"Alerta Alto"`, `"Anomalia"` ou `"Normal"` (dicionário de dados) |
| `segmentos_criticos` | não | lista de trechos com indício de agressão, em **segundos desde o início do vídeo**; `inicio_s <= fim_s` |
| `versao_modelo` | sim | nome/versão do modelo usado (RN07, rastreabilidade) |
| `tempo_processamento_ms` | não | tempo gasto na análise; usado pra medir o RN16 |
| `hash_sha256_verificado` | não, mas recomendado | SHA-256 do arquivo que você **de fato** analisou |

Se `hash_sha256_verificado` vier diferente do registrado, o backend
**recusa o resultado** (409) e marca a gravação como `Erro`. É a garantia de
que o laudo se refere ao vídeo original, sem adulteração (cadeia de custódia).

### Deu erro na análise

```json
{ "status": "erro", "erro": "descrição curta do problema" }
```

O backend marca como `Erro` e manda de novo mais tarde (RE08).

### Respostas do backend

| Código | Quando |
| --- | --- |
| `201` | resultado gravado |
| `200` | erro registrado |
| `400` | campo inválido (a mensagem diz qual) |
| `401` | token errado |
| `409` | gravação já tinha análise concluída, ou hash não confere |

---

## Novas tentativas (RE08)

- Falhou (serviço fora do ar, erro no callback, hash divergente)? A gravação
  vira `Erro` e o backend tenta de novo depois de 1, 2, 4, 8... minutos, até
  `IA_MAX_TENTATIVAS` (padrão 5).
- Aceitou o pedido mas não devolveu nada em `IA_TIMEOUT_MINUTOS` (padrão 30)?
  Conta como erro e entra na mesma fila.
- Por isso o serviço deve aceitar receber o **mesmo `id_gravacao` mais de
  uma vez**.

---

## Esqueleto do serviço em Python (FastAPI)

Ponto de partida pra plugar o YOLO:

```python
# pip install fastapi uvicorn requests
import hashlib, os, tempfile, time, requests
from fastapi import FastAPI, BackgroundTasks, Header, HTTPException

IA_TOKEN = os.environ.get("IA_TOKEN", "")
IA_CALLBACK_TOKEN = os.environ["IA_CALLBACK_TOKEN"]
VERSAO_MODELO = "yolov9-violencia-v1"

app = FastAPI()

@app.post("/analisar", status_code=202)
def analisar(pedido: dict, tarefas: BackgroundTasks, authorization: str = Header(default="")):
    if IA_TOKEN and authorization != f"Bearer {IA_TOKEN}":
        raise HTTPException(401, "token inválido")
    tarefas.add_task(processar, pedido)   # roda depois de responder 202
    return {"aceito": True}

def processar(p: dict):
    inicio = time.time()
    try:
        # 1. baixa o vídeo
        video = requests.get(p["video_url"], timeout=120).content
        # 2. confere a integridade
        h = hashlib.sha256(video).hexdigest()
        if h != p["hash_sha256"]:
            raise ValueError(f"hash não confere: {h}")
        with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as f:
            f.write(video)
            caminho = f.name

        # 3. >>> AQUI ENTRA O MODELO <<<
        score, veredicto, segmentos = rodar_modelo(caminho)

        resultado = {
            "status": "concluido",
            "score": round(score, 2),
            "veredicto": veredicto,
            "segmentos_criticos": segmentos,
            "versao_modelo": VERSAO_MODELO,
            "tempo_processamento_ms": int((time.time() - inicio) * 1000),
            "hash_sha256_verificado": h,
        }
    except Exception as e:
        resultado = {"status": "erro", "erro": str(e)[:500]}

    # 4. devolve pro backend
    requests.post(p["callback_url"], json=resultado,
                  headers={"Authorization": f"Bearer {IA_CALLBACK_TOKEN}"}, timeout=30)

def rodar_modelo(caminho_video):
    # Trocar pelo YOLO: ler os frames, classificar, juntar trechos.
    # Deve devolver: score (0-100), veredicto ("Alerta Alto" | "Anomalia" | "Normal"),
    # segmentos [{"inicio_s": 2.0, "fim_s": 5.0, "score": 96.1}, ...]
    return 0.0, "Normal", []

# rodar: uvicorn servico_ia:app --port 8090
```

## Testando sem o modelo

O backend tem uma IA falsa que segue este mesmo contrato:

```bash
npm run ia-mock          # sobe em http://localhost:8090
```

Com `IA_SERVICE_URL=http://localhost:8090` no `.env` do backend, cada
gravação encerrada é "analisada" em ~3 s com um resultado inventado.
`IA_MOCK_FALHA=0.5` faz metade das análises falhar, pra testar as novas
tentativas.

## Rede

O serviço de IA precisa alcançar o backend (pra baixar o vídeo no modo
local e pra chamar o `callback_url`). Se os dois não estiverem na mesma
máquina, configure `PUBLIC_BASE_URL` no backend com um endereço que o
serviço consiga acessar. Um serviço rodando no **Colab**, por exemplo, não
alcança `192.168.x.x`: aí o backend precisa estar publicado (ex.: numa EC2) ou
exposto por um túnel.
