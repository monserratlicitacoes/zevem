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
As demais integrações estão em `backend/.env.example`. Se habilitar o Google,
cadastre `https://app.zevem.com.br/api/auth/google/callback` no OAuth e use o mesmo
endereço como primeiro `redirect_uris` no arquivo `google_credentials.json`.

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
   Com tudo pronto, defina a variável do repositório `DEPLOY_ENABLED=true` e
   execute **Validar e publicar Zevem** na `main`.

```bash
curl -fsS https://app.zevem.com.br/api/health
curl -fsS https://app.zevem.com.br/login
```

O deploy valida os dois endereços e restaura os containers da versão anterior
se houver falha. O volume de dados continua no lugar; alterações de esquema
exigem uma cópia do banco para que os dados também possam ser revertidos.
