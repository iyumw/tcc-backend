# Publicando o backend na AWS (EC2 + HTTPS)

Arquitetura final, tudo na região **sa-east-1 (São Paulo)**:

```
ESP32-CAM ──HTTPS──┐
Portal (front) ────┼──> Caddy (443, certificado Let's Encrypt) ──> backend Node (8080)   [EC2]
Serviço de IA ─────┘                                                 │        │
                                                                     ▼        ▼
                                                                  RDS (PG)   S3 (vídeos)
```

- **EC2:** uma máquina Linux que roda o backend o tempo todo.
- **Elastic IP:** um IP fixo para a máquina (não muda quando ela reinicia).
- **DuckDNS:** um nome gratuito (ex.: `seunome.duckdns.org`) apontando para o
  IP fixo. O HTTPS precisa de um nome, não funciona só com IP.
- **Caddy:** recebe as conexões HTTPS e repassa para o backend. Gera e renova
  o certificado sozinho.
- **IAM role:** dá à máquina acesso ao S3 sem precisar colocar chaves no `.env`.

> 💰 **Custo:** a EC2, o disco e o IP fixo são cobrados por hora enquanto
> existirem. Confira se a conta tem nível gratuito ou créditos e crie um
> alerta em **Billing → Budgets** (ex.: avisar ao passar de US$ 5). Depois da
> apresentação, dá para **parar** a instância (para de cobrar a máquina) ou
> **encerrar** tudo.

---

## 1. Criar a máquina (EC2)

No console da AWS, confira no canto superior direito que a região é
**América do Sul (São Paulo)**. Depois, **EC2 → Instâncias → Executar
instâncias**:

| Campo | Valor |
| --- | --- |
| Nome | `safe-evidence-backend` |
| Imagem (AMI) | **Ubuntu Server 24.04 LTS** |
| Tipo | **t3.micro** (se aparecer "qualificado para nível gratuito", melhor) |
| Par de chaves | **Criar novo par de chaves** → nome `safe-evidence`, tipo RSA, formato `.pem`. Guarde o arquivo baixado: é a "senha" para entrar na máquina e não dá para baixar de novo. |
| Armazenamento | 20 GiB, gp3 |

Em **Configurações de rede → Editar**:

- **Atribuir IP público automaticamente:** Habilitar.
- **Criar grupo de segurança** com o nome `safe-evidence-web` e três regras:

| Tipo | Porta | Origem | Pra quê |
| --- | --- | --- | --- |
| SSH | 22 | **Meu IP** | você entrar na máquina |
| HTTP | 80 | Qualquer lugar (0.0.0.0/0) | o Let's Encrypt validar o domínio |
| HTTPS | 443 | Qualquer lugar (0.0.0.0/0) | câmera, portal e IA |

Clique em **Executar instância**.

## 2. IP fixo (Elastic IP)

**EC2 → IPs elásticos → Alocar endereço IP elástico → Alocar**. Selecione o
IP criado → **Ações → Associar endereço IP elástico** → escolha a instância
`safe-evidence-backend` → **Associar**. Anote esse IP.

## 3. Nome para o HTTPS (DuckDNS)

1. Entre em **duckdns.org** (login com Google ou GitHub).
2. Crie um subdomínio (ex.: `seunome` → `seunome.duckdns.org`). Evite um nome
   que identifique o produto, pela discrição do projeto.
3. No campo **current ip**, coloque o **IP elástico** e clique em
   **update ip**.

## 4. Liberar o RDS para a máquina

**RDS → safe-evidence-db → Conectividade e segurança →** clique no grupo de
segurança → **Editar regras de entrada → Adicionar regra**:

- Tipo **PostgreSQL**, porta 5432, origem: **o grupo `safe-evidence-web`**
  (comece a digitar `sg-` ou o nome e selecione o grupo).

Assim só a máquina do backend (e o seu IP, se a regra antiga continuar)
conecta no banco.

## 5. Acesso ao S3 sem chaves (IAM role)

1. **IAM → Funções (Roles) → Criar função**.
2. Entidade confiável: **Serviço da AWS → EC2** → Próximo.
3. Pule a tela de políticas (Próximo), dê o nome `safe-evidence-backend-ec2`
   e crie.
4. Abra a função criada → **Adicionar permissões → Criar política em linha**
   → aba **JSON** → cole a política da seção 2 do `docs/aws-setup.md` (troque
   o nome do bucket) → nome `acesso-videos` → Criar.
5. **EC2 → Instâncias →** selecione a instância → **Ações → Segurança →
   Modificar função do IAM** → escolha `safe-evidence-backend-ec2` → Atualizar.

> Se a sua conta não tiver permissão para criar funções no IAM, pule este
> passo e coloque `AWS_ACCESS_KEY_ID` e `AWS_SECRET_ACCESS_KEY` no `.env` do
> servidor (passo 7), como no seu PC.

## 6. Entrar na máquina e instalar tudo

No Git Bash do seu PC (troque o caminho do `.pem` e o IP):

```bash
chmod 400 ~/Downloads/safe-evidence.pem
ssh -i ~/Downloads/safe-evidence.pem ubuntu@SEU_IP_ELASTICO
```

Na primeira vez ele pergunta se confia na máquina: digite `yes`. Se der erro
de permissão do `.pem` (`UNPROTECTED PRIVATE KEY FILE`), mova o arquivo para
`~/.ssh/` e tente de novo.

Já dentro do servidor (o terminal mostra `ubuntu@ip-...`), rode em ordem:

```bash
# Atualiza o sistema
sudo apt update && sudo apt upgrade -y

# 1 GB de memória extra (swap): a t3.micro tem só 1 GB
sudo fallocate -l 1G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# Node.js 22, git e Caddy
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs git caddy
node -v   # deve mostrar v22...

# Código do backend
git clone https://github.com/iyumw/tcc-backend.git
cd tcc-backend
npm ci --omit=dev
curl -o global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
```

> Se o repositório for **privado**, o `git clone` pede usuário e senha. A
> senha é um **token** do GitHub: **GitHub → Settings → Developer settings →
> Personal access tokens → Tokens (classic) → Generate new token**, com a
> permissão `repo`.

## 7. Configurar o `.env` do servidor

Ainda na pasta `tcc-backend`:

```bash
nano .env
```

Cole o conteúdo abaixo, com os seus valores (clique com o botão direito para
colar no Git Bash). Salve com **Ctrl+O**, **Enter**, e saia com **Ctrl+X**.

```dotenv
PORT=8080
NODE_ENV=production

DB_HOST=safe-evidence-db.c7eakmooc07m.sa-east-1.rds.amazonaws.com
DB_PORT=5432
DB_NAME=safe_evidence
DB_USER=postgres
DB_PASSWORD=...
DB_SSL=true
DB_SSL_CA=./global-bundle.pem

S3_BUCKET=...
AWS_REGION=sa-east-1
# Só se NÃO usou a IAM role do passo 5:
# AWS_ACCESS_KEY_ID=...
# AWS_SECRET_ACCESS_KEY=...

URL_VALIDADE_MINUTOS=15
URL_SIGNING_SECRET=...
PUBLIC_BASE_URL=https://SEU-SUBDOMINIO.duckdns.org

IA_SERVICE_URL=
IA_TOKEN=
IA_CALLBACK_TOKEN=...
IA_MAX_TENTATIVAS=5
IA_TIMEOUT_MINUTOS=30

FRONT_URL=http://localhost:4200
JWT_SECRET=...
SESSAO_INATIVIDADE_MINUTOS=15
SESSAO_MAX_HORAS=8

SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=...
SMTP_PASS=...
EMAIL_FROM=...
```

- Os segredos (`URL_SIGNING_SECRET`, `IA_CALLBACK_TOKEN`, `JWT_SECRET`) podem
  ser os mesmos do seu PC ou novos. Com `JWT_SECRET` diferente, um login feito
  no backend do PC não vale no do servidor, e vice-versa.
- `IA_SERVICE_URL` vazio: as análises ficam "Pendente" até a IA ser publicada.
  Quando a Danielle tiver o endereço do serviço, é só preencher e reiniciar.
- `FRONT_URL`: com `http://localhost:4200`, a Amanda consegue testar o front
  rodando no PC dela contra o backend na nuvem. Quando o front for
  publicado, acrescente o endereço dele separado por vírgula.

## 8. Ligar o backend e o HTTPS

```bash
# Backend como serviço (sobe sozinho quando a máquina liga)
sudo cp deploy/safe-evidence.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now safe-evidence
curl http://127.0.0.1:8080/health     # deve responder {"status":"ok"}

# HTTPS: troque SEU-SUBDOMINIO no arquivo e ative
nano deploy/Caddyfile
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Espere uns 30 s (o Caddy pede o certificado) e abra no navegador:
**`https://SEU-SUBDOMINIO.duckdns.org/health`**. Deve aparecer
`{"status":"ok"}` com o cadeado.

Para ver os logs do backend (o que antes aparecia no terminal do VS Code):

```bash
journalctl -u safe-evidence -f      # Ctrl+C para sair
```

## 9. Apontar a câmera e o Postman para a nuvem

- **Chave da câmera:** rode a migração `005_chave_dispositivo.sql` no RDS
  (como as outras). Depois, no servidor, na pasta `tcc-backend`, rode
  `npm run chave-dispositivo -- esp32cam-01` e copie a linha
  `#define DEVICE_KEY "..."` que aparecer.
- **Câmera:** no `esp32cam.ino`, troque o domínio em `SERVER_BASE` (já está
  com HTTPS), cole a `DEVICE_KEY` e grave o firmware de novo.
- **Postman:** troque a variável `base_url` da coleção para
  `https://SEU-SUBDOMINIO.duckdns.org/api`.

A câmera agora funciona em qualquer Wi-Fi com internet, sem depender do IP
do seu PC.

## 10. Atualizar o backend depois

Depois de dar `git push` com mudanças, no servidor:

```bash
cd ~/tcc-backend
bash deploy/atualizar.sh
```

Se mudar o `.env`, reinicie com `sudo systemctl restart safe-evidence`.

---

## Problemas comuns

| Sintoma | Causa provável |
| --- | --- |
| `ssh` fica parado até dar timeout | Seu IP mudou: atualize a regra SSH (Meu IP) no grupo `safe-evidence-web` |
| `/health` no HTTPS não abre | Portas 80/443 fechadas no grupo, ou o DuckDNS não aponta para o IP elástico. Veja `journalctl -u caddy -n 50` |
| `journalctl` mostra erro de conexão com o banco | Passo 4 (regra do RDS para o grupo `safe-evidence-web`) |
| Upload no S3 dá `AccessDenied` / `Could not load credentials` | Passo 5 (IAM role) ou nome do bucket errado |
| Câmera mostra código HTTP `-1` | Domínio errado no firmware, ou o `/health` pelo navegador não abre |
| Câmera mostra código HTTP `401` | `DEVICE_KEY` do firmware diferente da última chave gerada, ou migração 005 não rodada |
