# Zevem na VPS

O Nginx do host atende `app.zevem.com.br`. O frontend escuta em
`127.0.0.1:3201` e a API em `127.0.0.1:3202`. O volume Docker
`zevem_zevem-data` guarda o SQLite, os uploads e os arquivos da integração Google.

1. Aponte o registro A de `app.zevem.com.br` para a VPS. Confira se as portas
   locais estão livres com `ss -ltn '( sport = :3201 or sport = :3202 )'`.
2. Na VPS, use uma chave com acesso de leitura ao Zevem para clonar o repositório
   em `/opt/zevem`. Se já houver um checkout, atualize-o com
   `git fetch origin main && git merge --ff-only origin/main`.
3. Crie o arquivo de produção uma vez. Guarde o `DADOS_KEY` junto da
   documentação de recuperação em um gerenciador de senhas. Essa chave é
   necessária para ler os dados pessoais criptografados após uma restauração.

```bash
cd /opt/zevem
(
  umask 077
  set -o noclobber
  printf 'FRONTEND_URL=https://app.zevem.com.br\nJWT_SECRET=%s\nDADOS_KEY=%s\nMASTER_EMAILS=\n' \
    "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" > .env.production
)
```

Preencha `MASTER_EMAILS` com os endereços autorizados, separados por vírgula.
As demais integrações estão em `backend/.env.example`.

4. Instale o vhost HTTP e emita o certificado usando o webroot que já existe na VPS.

```bash
install -m 644 /opt/zevem/deploy/nginx-host/zevem-http.conf /etc/nginx/sites-available/zevem-http.conf
ln -sfn ../sites-available/zevem-http.conf /etc/nginx/sites-enabled/zevem-http.conf
nginx -t && systemctl reload nginx
certbot certonly --webroot -w /opt/monserrat/www -d app.zevem.com.br
```

5. Ative HTTPS após a emissão do certificado.

```bash
install -m 644 /opt/zevem/deploy/nginx-host/zevem-https.conf /etc/nginx/sites-available/zevem-https.conf
ln -sfn ../sites-available/zevem-https.conf /etc/nginx/sites-enabled/zevem-https.conf
nginx -t && systemctl reload nginx
```

6. No GitHub, configure o secret `DEPLOY_SSH_KEY` com a chave privada usada
   pelo runner para autenticar na VPS. Configure as variáveis do repositório
   `DEPLOY_HOST`, `DEPLOY_PORT`, `DEPLOY_USER` e `DEPLOY_KNOWN_HOSTS`.
   Na VPS, a chave que o Git usa para buscar o repositório precisa ter acesso ao Zevem.
   Com tudo pronto, faça um push na `main` ou execute manualmente
   **Validar e publicar Zevem** na `main`. A publicação roda após a validação.

Para receber o resultado no Telegram, configure os secrets `TELEGRAM_BOT_TOKEN`
e `TELEGRAM_CHAT_ID` no GitHub.

```bash
curl -fsS https://app.zevem.com.br/api/health
curl -fsS https://app.zevem.com.br/login
```

O deploy valida os dois endereços e restaura os containers da versão anterior
se houver falha. O volume de dados continua no lugar; alterações de esquema
exigem uma cópia do banco para que os dados também possam ser revertidos.

## Envio de e-mail e primeira conta master

O Zevem envia os e-mails (confirmação de cadastro, nova senha e convites) pela caixa da
Hostinger, por SMTP.

1. Na VPS, acrescente ao `/opt/zevem/.env.production` o endereço e a senha da caixa
   de e-mail do Zevem (a mesma senha do webmail da Hostinger):

```bash
SMTP_HOST=smtp.hostinger.com
SMTP_PORT=465
SMTP_USER=contato@zevem.com.br
SMTP_PASS=senha-da-caixa
EMAIL_NOME=Zevem
```

   Troque `contato@zevem.com.br` pelo endereço real. Depois recrie o backend para
   ler as variáveis novas: `cd /opt/zevem && docker compose up -d backend`.
   Sem essas variáveis, o app cria os convites, mas avisa que o e-mail não saiu.
   (Alternativa antiga: Gmail conectado pelo master em `/api/auth/google`, com
   `/data/google_credentials.json`; só vale quando o SMTP não está configurado.)

2. Cadastre no site o endereço que você incluiu em `MASTER_EMAILS` e confirme pelo
   e-mail recebido.

3. Se o e-mail não chegar, gere na VPS um link novo de confirmação. O banco guarda só o
   hash do token, então o link antigo não pode ser recuperado: este comando cria outro.
   Troque `master@exemplo.com` pelo endereço cadastrado e abra o link no navegador.
   O link é de uso único e deve ficar com o titular da conta.

```bash
cd /opt/zevem
docker compose exec -T backend node -e '
  const { join } = require("node:path");
  const crypto = require("node:crypto");
  const Database = require("better-sqlite3");
  const email = process.argv[1].trim().toLowerCase();
  const masters = (process.env.MASTER_EMAILS || "").toLowerCase().split(",").map(e => e.trim());
  if (!masters.includes(email)) throw new Error("Endereço ausente em MASTER_EMAILS");
  const db = new Database(join(process.env.DATA_DIR, "apple-green.db"));
  const token = crypto.randomBytes(24).toString("hex");
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  const r = db.prepare("UPDATE usuarios SET token_confirmacao = ? WHERE lower(trim(email)) = ? AND confirmado = 0").run(hash, email);
  if (!r.changes) throw new Error("Conta pendente não encontrada");
  const url = new URL("/confirmar-email", process.env.FRONTEND_URL);
  url.searchParams.set("email", email);
  url.searchParams.set("token", token);
  console.log(url.href);
' master@exemplo.com
```

## Backup local e Cloudflare R2

O timer roda às 03:40 no horário de São Paulo. O arquivo local mais recente
fica em `/var/backups/zevem/zevem.tar` e contém o SQLite e a pasta `uploads`.
O systemd executa `deploy/backup.sh` e, se a cópia local passar, executa
`deploy/r2-backup.sh`. Para gerar só a cópia local na VPS, rode
`bash /opt/zevem/deploy/backup.sh`.
O Restic guarda cópias criptografadas em um bucket exclusivo do Zevem, com
retenção de 3 snapshots diários, 2 semanais e 3 mensais.

Crie o bucket privado `zevem-backups` no R2 e uma credencial **Object Read & Write**
restrita a ele. Selecione o endpoint S3 mostrado no próprio bucket. Na VPS,
confirme `restic version` e prepare os arquivos com acesso exclusivo do root:

```bash
install -d -m 700 /etc/zevem-backup
(
  umask 077
  set -o noclobber
  openssl rand -hex 32 > /etc/zevem-backup/restic-password
)
umask 077
nano /etc/zevem-backup/r2.env
```

Preencha o `r2.env` com os valores do R2, usando o ID da conta no endpoint:

```bash
RESTIC_REPOSITORY='s3:https://ACCOUNT_ID.r2.cloudflarestorage.com/zevem-backups'
RESTIC_PASSWORD_FILE='/etc/zevem-backup/restic-password'
AWS_ACCESS_KEY_ID='ACCESS_KEY_ID_DO_ZEVEM'
AWS_SECRET_ACCESS_KEY='SECRET_ACCESS_KEY_DO_ZEVEM'
AWS_DEFAULT_REGION='auto'
```

Guarde a senha do Restic e a `DADOS_KEY` no gerenciador de senhas. Para uma
recuperação completa, guarde também a configuração de produção e, se o Gmail
estiver configurado, as credenciais do OAuth. O arquivo de backup contém o
SQLite e os uploads.

Inicialize o bucket vazio uma vez, rode o primeiro backup e só então ligue o timer:

```bash
cd /opt/zevem
chmod 600 /etc/zevem-backup/r2.env /etc/zevem-backup/restic-password
(
  set -a
  source /etc/zevem-backup/r2.env
  set +a
  restic init
)
install -m 644 deploy/systemd/zevem-backup.{service,timer} /etc/systemd/system/
systemctl daemon-reload
systemctl start zevem-backup.service &&
systemctl enable --now zevem-backup.timer
journalctl -u zevem-backup.service -n 40 --no-pager
systemctl list-timers zevem-backup.timer
```

Para validar uma restauração em uma pasta temporária:

```bash
(
  set -eu
  set -a
  source /etc/zevem-backup/r2.env
  set +a
  restic check
  restore_dir="$(mktemp -d)"
  restic restore latest --tag zevem --target "$restore_dir"
  tar -tf "$restore_dir/var/backups/zevem/zevem.tar"
  echo "Arquivo restaurado em $restore_dir"
)
```
