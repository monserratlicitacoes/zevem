# Integrador WhatsApp

Faz a ponte entre o WhatsApp e as rotas `/integracao/whatsapp/*` do backend (contrato em
`docs/Apple Green - Integracao WhatsApp.pdf`). Não depende de pacotes externos: Node 22.13+ com
`fetch`, `node:http` e `node:sqlite`.

```
WhatsApp ──webhook──▶ integrador ──POST /mensagens──▶ backend (IA, lançamento)
         ◀──resposta──            ◀──── resposta ────
         ◀─template/texto── integrador ◀─GET /saida── backend (avisos do agendador)
                                       ──POST /saida/:id/status──▶
```

## O que ele faz

- **Mensagens recebidas** (`POST /webhook`): valida a assinatura, grava no SQLite local e responde 200
  na hora. Em seguida, em série: marca como lida, transcreve o áudio (se houver), chama
  `/mensagens` e envia a resposta. Imagem, documento e outros tipos recebem uma resposta padrão sem
  passar pelo Zevem; reações e eventos de sistema são ignorados.
- **Repetição segura**: falha no Zevem (rede, timeout, 5xx, ou 409 quando a mesma mensagem ainda está em processamento) ou no envio tenta de novo até 6 vezes
  (2 s, 10 s, 30 s, 1 min, 2 min) com a mesma `mensagem_id`. A resposta já entregue nunca é reenviada
  e a mesma mensagem reentregue pelo provedor é ignorada. Se desistir antes de o Zevem responder, o
  usuário recebe "tive um problema, tente de novo".
- **Fila de avisos** (a cada `FILA_INTERVALO_MS`): busca `/saida`, envia e confirma. Se o usuário
  escreveu nas últimas 23h30, o aviso sai como texto livre (sem custo de template); fora disso, como
  template com os parâmetros na ordem de `src/templates.js`. Se a Meta recusar o texto por janela
  fechada, cai para o template. O número de envio é o mesmo que escreveu por último (resolve o nono
  dígito); sem histórico, usa o cadastrado com 55.
- **Falhas de aviso**: erro definitivo (número sem WhatsApp, template inválido) confirma `falhou`.
  Erro temporário não confirma: a reserva vence em 10 min e o Zevem entrega o aviso de novo (até 3
  tentativas). Se o envio saiu mas a confirmação se perdeu, a próxima rodada só confirma, sem reenviar.
- **Status de entrega** da Meta (entregue, lido, falhou) ficam na tabela `envios` local. O contrato do
  Zevem ainda não recebe falha depois de `enviado`.
- **Saúde**: `GET /health` (usado pelo Compose) e checagem do `/saude` do Zevem a cada 5 min no log.

O estado local (`integrador.db`) guarda mensagens por 7 dias e envios por 30. Perder esse arquivo não
perde dados do Zevem; só reabre a chance de reenviar algo que estava em andamento.

## Provedores

O provedor ativo é escolhido por `WHATSAPP_PROVEDOR`. A interface está descrita em
`src/provedores/index.js`.

| Provedor | Uso |
|---|---|
| `meta` | WhatsApp Cloud API oficial (Graph API) |
| `simulado` | Desenvolvimento: não envia nada; `GET /simulado/enviadas` mostra o que sairia |

Para um provedor de backup: crie `src/provedores/<nome>.js` com a mesma interface, registre em
`PROVEDORES` e troque `WHATSAPP_PROVEDOR`. Se o provedor não tiver templates, defina
`suportaTemplates: false` e os avisos saem com o texto pronto (`mensagem`) da fila.

Transcrição: `TRANSCRICAO_PROVEDOR=openai` aceita qualquer API compatível com
`/audio/transcriptions` (OpenAI, Groq e outras, trocando `TRANSCRICAO_URL` e `TRANSCRICAO_MODELO`).
Com `nenhuma`, o áudio chega vazio e o Zevem pede para mandar por texto.

## Rodar local

```bash
cd integrador
cp .env.example .env    # WHATSAPP_PROVEDOR=simulado e o mesmo token do backend
node --env-file=.env server.js

# mensagem simulada
curl -X POST localhost:3300/webhook -d '{"telefone":"5511987654321","texto":"almoço 45"}'
curl localhost:3300/simulado/enviadas
```

Testes: `npm test` (Meta, Zevem e transcrição simulados, sem rede externa).

## Configurar a Meta

1. No [Meta for Developers](https://developers.facebook.com/), crie um app do tipo Business com o
   produto WhatsApp e vincule a conta WhatsApp Business (WABA) da empresa.
2. Adicione e verifique o número. Anote o **Phone number ID** (`META_PHONE_NUMBER_ID`).
3. No Business Manager, crie um usuário do sistema com acesso ao app e à WABA e gere um token
   permanente com `whatsapp_business_messaging` e `whatsapp_business_management` (`META_TOKEN`).
4. Em Configurações do app > Básico, copie a chave secreta (`META_APP_SECRET`).
5. Em WhatsApp > Configuração, cadastre o webhook:
   URL `https://app.zevem.com.br/whatsapp/webhook`, token de verificação = `META_VERIFY_TOKEN`.
   Assine o campo **messages**.
6. Submeta os 7 templates (categoria Utility, idioma `pt_BR`) com os parâmetros na ordem de
   `src/templates.js`.
7. Preencha as variáveis em `/opt/zevem/.env.production` e faça o deploy (ver `deploy/README.md`).
