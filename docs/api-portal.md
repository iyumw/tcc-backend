# API do portal (para o front em Angular)

Base: `http://localhost:8080/api` (em produção, o endereço onde o backend for publicado).

Todas as respostas são JSON. Erros sempre vêm como:

```json
{ "erro": "mensagem pronta pra mostrar na tela", "codigo": "CODIGO_OPCIONAL", "campos": { "cpf": "CPF inválido." } }
```

`campos` aparece nos erros de formulário: a chave é o nome do campo e o
valor é a mensagem desse campo. Serve pra mostrar o erro embaixo de cada
input.

---

## Autenticação

### Fluxo de login (Figuras 8 e 9)

```
POST /auth/login  { email, senha }          -> { mfa_token, email_mascarado, ... }
   (usuária recebe o código de 6 dígitos no e-mail)
POST /auth/mfa    { mfa_token, codigo }     -> { token, expira_em, inatividade_minutos, usuario }
```

Depois disso, toda requisição leva o cabeçalho:

```
Authorization: Bearer <token>
```

Guarde o `token` no `localStorage` (como o TCC descreve) e anexe com um
**HttpInterceptor**.

### Quando a sessão cai

Qualquer rota protegida pode responder `401` com um destes `codigo`:

| codigo | O que aconteceu | O que o front faz |
| --- | --- | --- |
| `SEM_TOKEN` | não mandou o token | ir pro login |
| `TOKEN_INVALIDO` | token adulterado ou vencido | limpar localStorage, ir pro login |
| `SESSAO_INATIVA` | 15 min sem usar o portal (RE11) | limpar, ir pro login com aviso "sessão expirada por inatividade" |
| `SESSAO_ENCERRADA` / `SESSAO_EXPIRADA` | logout ou passou de 8 h | limpar, ir pro login |

Ou seja: **qualquer 401 em rota protegida → limpar sessão e mandar pro
login.** Isso resolve o CT09 no Interceptor.

### Rotas

| Método e rota | Corpo | Resposta |
| --- | --- | --- |
| `POST /auth/cadastro` | ver abaixo | `201 { id_vitima, mensagem }` |
| `POST /auth/login` | `{ email, senha }` | `200 { mfa_token, validade_minutos, email_mascarado, mensagem }` |
| `POST /auth/mfa` | `{ mfa_token, codigo }` | `200 { token, expira_em, inatividade_minutos, usuario: { id_vitima, nome, email } }` |
| `POST /auth/mfa/reenviar` | `{ mfa_token }` | `200 { mfa_token, validade_minutos }` (**use o novo mfa_token**) |
| `POST /auth/logout` | — (com token) | `204` |
| `POST /auth/senha/esqueci` | `{ email }` | `200 { mensagem }` (sempre, exista ou não o e-mail) |
| `POST /auth/senha/redefinir` | `{ email, codigo, nova_senha }` | `200 { mensagem }` |

**Cadastro (Figuras 10 a 12):**

```json
{
  "nome": "Maria da Silva",
  "cpf": "529.982.247-25",
  "email": "maria@exemplo.com",
  "telefone": "(11) 98888-7777",
  "senha": "Senha@123",
  "endereco": {
    "cep": "01310-100", "logradouro": "Av. Paulista", "numero": "1000",
    "complemento": "ap 12", "bairro": "Bela Vista", "cidade": "São Paulo", "uf": "SP"
  },
  "consentimento": true
}
```

CPF, telefone e CEP podem vir com ou sem máscara. Erros:

- **`400`:** algum campo inválido. `campos` diz qual.
- **`409`:** e-mail ou CPF já cadastrado. `campos.email` / `campos.cpf`.

**Senha forte (RN03):** 8+ caracteres, com maiúscula, minúscula, número e
caractere especial. Vale validar isso no front também, mas o backend sempre
confere.

**Erros do login:**

| Status | codigo | Mensagem |
| --- | --- | --- |
| `401` | `CREDENCIAIS_INVALIDAS` | "E-mail ou senha incorretos." (não diz qual dos dois) |
| `423` | `BLOQUEIO_TEMPORARIO` | 3 erros seguidos → 30 min. Vem `minutos_restantes`. |
| `423` | `BLOQUEIO_PERMANENTE` | depois do desbloqueio, mais 2 erros → só o suporte libera (RN10). |

**Erros do MFA:** `401` com `codigo: "MFA_INVALIDO"` e a mensagem já diz
quantas tentativas restam. O código vale 5 min e aceita 5 tentativas.

---

## Perfil (Figura 13) — exige token

| Método e rota | Corpo | Resposta |
| --- | --- | --- |
| `GET /perfil` | — | perfil (abaixo) |
| `PUT /perfil` | campos a alterar | perfil atualizado |
| `POST /perfil/codigo` | `{ finalidade: "alterar_dados" \| "excluir_conta" }` | manda código por e-mail |
| `POST /perfil/dispositivo` | `{ id_dispositivo }` | vincula o dispositivo à conta |
| `DELETE /perfil` | `{ codigo }` | `204`, conta excluída (RE12) |

Perfil:

```json
{
  "id_vitima": 2,
  "nome": "Maria da Silva",
  "cpf_mascarado": "***.982.247-**",
  "email": "maria@exemplo.com",
  "telefone": "11988887777",
  "endereco": { "cep": "01310100", "logradouro": "...", "numero": "1000", "complemento": null,
                "bairro": "...", "cidade": "São Paulo", "uf": "SP" },
  "consentimento_em": "2026-09-22T23:28:34.146Z",
  "criada_em": "2026-09-22T23:28:34.146Z",
  "dispositivo": { "id_dispositivo": "esp32cam-01", "status_bateria": 90 }
}
```

**Alterar dados (RE10):**

- `nome` e `endereco` mudam direto.
- `email`, `telefone` e `nova_senha` exigem um código. Chame primeiro
  `POST /perfil/codigo { "finalidade": "alterar_dados" }` e mande o código
  junto: `PUT /perfil { "email": "...", "codigo": "123456" }`.
- Sem o código, a resposta é `401` com `codigo: "MFA_OBRIGATORIO"`.

**Excluir conta (RE12):**

1. `POST /perfil/codigo { "finalidade": "excluir_conta" }`
2. `DELETE /perfil { "codigo": "123456" }`

Se alguma evidência estiver vinculada a processo judicial, a resposta é
`409` com `gravacoes_vinculadas`.

---

## Evidências (Figuras 14 e 15) — exige token

| Método e rota | Resposta |
| --- | --- |
| `GET /evidencias` | lista do dashboard |
| `GET /evidencias/:id` | detalhe + laudo |
| `GET /evidencias/:id/url` | link temporário do vídeo (15 min, RN04) |
| `GET /evidencias/:id/laudo` | baixa o laudo (arquivo `.json`) |
| `GET /evidencias/:id/integridade` | confere o hash SHA-256 do vídeo |
| `POST /evidencias/:id/analise` | pede nova análise (quando deu erro) |
| `DELETE /evidencias/:id` com `{ "confirmacao": true }` | exclui (RE09) |
| `GET /evidencias/eventos?token=...` | status em tempo real (SSE) |

Evidência de **outra** usuária → `403` (e fica registrado no log, CT05).

**Lista:**

```json
[
  {
    "id_gravacao": 4,
    "gravada_em": "2026-09-22T23:28:49.886Z",
    "dispositivo": "esp32cam-01",
    "duracao_segundos": 16.4,
    "status_analise": "Concluido",
    "veredicto": "Alerta Alto",
    "score": 84.94,
    "vinculada_a_processo": false
  }
]
```

`status_analise`: `Pendente` | `Processando` | `Concluido` | `Erro`
(sugestão de rótulos na tela: Pendente, Em análise, Analisado, Erro).
`veredicto`: `Alerta Alto` | `Anomalia` | `Normal`, ou `null` enquanto não
tiver laudo.

**Detalhe:** os mesmos campos, mais `hash_sha256`, `processo_judicial`,
`tentativas_analise`, `ultimo_erro_analise` e `laudo`. O `laudo` vem
`null` até a análise terminar. Quando pronto:

```json
{
  "id_laudo": "LAUDO-2026-000003",
  "timestamp_emissao": "...",
  "dispositivo_origem": "esp32cam-01",
  "hash_video_original": "cdfc43ba...",
  "status_analise": "CONCLUIDO",
  "classificacao_final": "EVENTO_AGRESSIVIDADE_DETECTADO",
  "veredicto": "Alerta Alto",
  "indice_probabilidade": 84.94,
  "segmentos_criticos": [{ "inicio_s": 2.0, "fim_s": 5.0, "score": 96.1 }],
  "algoritmo_versao": "...",
  "duracao_video_segundos": 16.4,
  "tempo_processamento_ms": 4210,
  "dentro_do_prazo_rn16": true
}
```

`segmentos_criticos` é o que alimenta a **linha do tempo** da Figura 15:
são os trechos marcados, em segundos desde o início do vídeo.

**Tocar o vídeo:** chame `GET /evidencias/:id/url` e use o `url` direto no
`<video [src]>`. O link vale 15 minutos. Se o player der erro depois disso,
peça um link novo.

**Baixar (RE04):**

- **Vídeo:** o mesmo `url`, com `<a [href]="url" download>`.
- **Laudo:** `GET /evidencias/:id/laudo` com `responseType: 'blob'`. O nome
  do arquivo vem no cabeçalho `Content-Disposition`, e o hash do arquivo no
  `X-Laudo-SHA256`.
- **Vídeo + laudo:** dispare os dois.

**Excluir (RE09 / CT11):** abra o diálogo de confirmação (PrimeNG
`ConfirmDialog`) e só depois envie `DELETE` com `{ "confirmacao": true }`.
No `HttpClient`, o `delete` com corpo é assim:
`http.delete(url, { body: { confirmacao: true } })`. Erros:

- **`409 VINCULO_JUDICIAL`:** evidência vinculada a processo.
- **`400 CONFIRMACAO_OBRIGATORIA`:** faltou `{ "confirmacao": true }`.

### Status em tempo real (RE08 / CT08)

O `EventSource` do navegador não manda cabeçalhos, por isso o token vai na
URL:

```ts
const fonte = new EventSource(`${api}/evidencias/eventos?token=${token}`);
fonte.addEventListener('status_analise', (e) => {
  const ev = JSON.parse((e as MessageEvent).data);
  // ev = { id_gravacao, status_analise, veredicto, score }
  // -> atualizar o signal da lista/detalhe
});
fonte.addEventListener('sessao_encerrada', () => {
  fonte.close();
  // -> ir pro login
});
```

Sem polling: o backend empurra o evento quando o status muda (Pendente →
Processando → Concluido/Erro). Feche o `EventSource` no logout e ao sair
do dashboard (`DestroyRef.onDestroy`).

---

## CORS

O backend só aceita chamadas do navegador vindas de `FRONT_URL` (padrão:
`http://localhost:4200`, o `ng serve`). Em produção, coloque ali o
endereço onde o front for publicado.

## Pra testar sem o e-mail configurado

Sem SMTP configurado, o código de 6 dígitos aparece no terminal do
backend:

```
[MFA] Código login para maria@exemplo.com: 482913
```

## Vincular o dispositivo de teste

Cada conta tem um dispositivo, e um dispositivo só pode ter uma dona.
Depois de criar a conta pelo portal, vincule o `esp32cam-01` com
`POST /perfil/dispositivo { "id_dispositivo": "esp32cam-01" }`. Se ele já
estiver ligado a uma vítima de teste antiga, desvincule antes:

```sql
UPDATE dispositivo SET id_vitima = NULL WHERE id_dispositivo = 'esp32cam-01';
```
