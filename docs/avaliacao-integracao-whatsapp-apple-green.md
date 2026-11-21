# Avaliação: integração WhatsApp do Zevem (Apple Green)

Data da avaliação: 21/11/2026. Base: PDF "Apple Green — Integração WhatsApp" (21/10/2026, 15 páginas, também versionado em `docs/Apple Green - Integracao WhatsApp.pdf`) e o código do worktree na branch `glauco-pacto/avaliacao-integracao-whatsapp-zevem` (commit `1ecf05c`).

Convenções: referências no formato `caminho/arquivo:linha`. Complexidade: **P** (até 1 dia), **M** (2 a 4 dias), **G** (1 semana ou mais). Tudo que não está no PDF nem no código está marcado como **suposição**. Nada foi executado: a análise é por leitura de código.

## 1. Resumo executivo

- O Zevem **é** o Apple Green (rebrand registrado em `CHANGELOG.md:24`). O lado "Apple Green" do contrato do PDF **já está implementado**: as quatro rotas `/integracao/whatsapp/*`, a interpretação por IA, a fila de avisos, o agendador, o simulador e a tela de Alertas estão em `backend/whatsapp.js` e `backend/server.js`.
- O que **não existe em lugar nenhum do repositório** é o lado "Integrador": receber o webhook da Meta/BSP, baixar e transcrever áudio, enviar a resposta, buscar a fila a cada minuto, enviar templates e confirmar o envio. Esse é o grosso do trabalho.
- Também faltam itens de produto e operação no próprio Zevem: o menu Alertas hoje só aparece para o master, não há termo de consentimento (opt-in), a variável `WHATSAPP_NUMERO` não está documentada, não há testes de backend e não há monitoramento de `/saude`.
- A leitura do código encontrou **dois defeitos prováveis** que afetam o aceite: lançamento duplicado em chamadas concorrentes com a mesma `mensagem_id` e data errada no atalho sem IA entre 21h e 0h (servidor em UTC).
- Há **divergências entre o PDF e o código** que o integrador precisa conhecer: o telefone só vale depois de confirmado com "ZEVEM <código>", existem valores de `acao` fora da lista do PDF e a URL real em produção tem o prefixo `/api`.
- **Tamanho estimado:** 2 a 3 semanas de um desenvolvedor (cerca de 10 a 15 dias úteis) para integrador, ajustes no Zevem, infra e testes. Fora dessa conta fica o prazo externo de verificação do negócio e aprovação dos 7 templates na Meta, que não depende de código.
- **Bloqueios externos:** escolha entre Meta Cloud API direta e BSP, número do WhatsApp Business, acesso à conta Meta, chave do provedor de transcrição e chave da Anthropic.

## 2. O que o PDF pede

### 2.1 Divisão de responsabilidades (páginas 1 e 2)

| Responsabilidade | Integrador | Apple Green (Zevem) |
|---|---|---|
| Número WhatsApp Business e webhook da Meta/BSP | Sim | |
| Baixar e transcrever áudios | Sim | |
| Enviar a resposta de cada mensagem recebida | Sim | |
| Buscar a fila de avisos e enviá-los como template | Sim | |
| Cadastrar e aprovar os templates na Meta | Sim | Define textos e variáveis |
| Identificar a pessoa pelo telefone | | Sim |
| Entender a mensagem, classificar, lançar, responder | | Sim |
| Decidir quais alertas gerar, quando e para quem | | Sim |
| Guardar histórico, custos de IA e status de envio | | Sim |

### 2.2 Contrato das quatro rotas (páginas 3 a 6)

| Rota | Quando chamar | Pontos principais |
|---|---|---|
| `POST /integracao/whatsapp/mensagens` | A cada mensagem recebida | Corpo: `mensagem_id` (wamid), `telefone`, `tipo` (`texto` ou `audio`), `texto`, `recebida_em`. Resposta síncrona em 2 a 6 s com `resposta` a enviar exatamente como veio. Repetição devolve `repetida: true` |
| `GET /integracao/whatsapp/saida` | A cada 1 minuto (sugestão) | Devolve avisos e os reserva por 10 min; `?limite=50` (máx. 100); telefone só com dígitos, normalmente sem 55 |
| `POST /integracao/whatsapp/saida/:id/status` | Depois de cada tentativa | `enviado` (com `mensagem_id_provedor`) ou `falhou` (com `erro`); confirmação repetida devolve 404 |
| `GET /integracao/whatsapp/saude` | Monitoramento | `ok`, `ia`, `modelo`, `hora` |

Autenticação: `Authorization: Bearer <WHATSAPP_INTEGRACAO_TOKEN>`; 401 se errado, 503 se a variável não existe. Erros de validação: 400 com `{"erro": "..."}`.

### 2.3 Regras que recaem sobre o integrador

- Timeout de 30 s em `/mensagens`; em erro de rede ou 5xx, repetir com a mesma `mensagem_id`; nunca reenviar ao usuário uma resposta já entregue.
- Áudio: baixar a mídia, transcrever em pt-BR e enviar o texto com `tipo: "audio"`; texto vazio significa "não consegui entender".
- Fila: buscar, enviar, confirmar. Fora da janela de 24h, enviar o template (`template` + `variaveis`, na ordem da tabela); dentro, pode enviar o texto de `mensagem`. Acrescentar o código do país ao telefone.
- Sete templates categoria Utility, idioma `pt_BR`: `ag_conta_vencendo`, `ag_fatura_fecha`, `ag_melhor_dia_compra`, `ag_fatura_vence`, `ag_meta_atingida`, `ag_limite_programado`, `ag_lancamento_outra_pessoa`.
- Checklist de go-live (páginas 14 e 15): HTTPS, token, chave da Anthropic, número verificado, transcrição funcionando, 7 templates aprovados, busca da fila a cada minuto, telefones cadastrados, cenários de aceite, monitoramento de `/saude` e da taxa de erros, termo de uso e opt-in.

### 2.4 Implantação descrita no PDF (páginas 12 a 14)

Frontend Angular estático e backend Node.js com SQLite em uma única instância, com disco persistente e backup diário. Essa parte já está resolvida de outra forma no repositório (Docker Compose em VPS, ver seção 3.4).

## 3. Estado atual do Zevem

### 3.1 Stack e arquitetura

- Frontend Angular 22 e TypeScript 6 (`package.json`), servido por Nginx em container (`Dockerfile`, `deploy/frontend.conf`).
- Backend Node.js 24, Express 5, better-sqlite3, SDK da Anthropic, googleapis para envio de e-mail (`backend/package.json`). Um único processo; agendadores com `setInterval` dentro do processo (`backend/server.js:2647-2648`).
- Banco SQLite em arquivo (`apple-green.db` em `DATA_DIR`). Não há migrations: as tabelas são criadas com `CREATE TABLE IF NOT EXISTS` e as colunas com `ALTER TABLE` dentro de `try/catch` na subida (ex.: `backend/whatsapp.js:141-182`).
- Multi-conta por `usuario_id`; cada conta tem até 2 pessoas (`backend/server.js:637`). Não há fila, cache ou broker externos.
- Dados pessoais (CPF, e-mail, telefone) cifrados com AES-256-GCM e índice HMAC para busca por telefone (`backend/cripto.js`).

### 3.2 O que já existe da integração WhatsApp

| Tema | Onde está | Observação |
|---|---|---|
| Autenticação por token, 401 e 503 | `backend/whatsapp.js:692-699` | Comparação em tempo constante |
| `GET /saude` | `backend/whatsapp.js:701-703` | Igual ao PDF |
| `POST /mensagens` | `backend/whatsapp.js:705-734` | Idempotência por `mensagem_id` em `:710-713`, índice único em `:171` |
| Identificação por telefone (DDD + 8 dígitos) | `backend/whatsapp.js:125-130`, `:195-200` | Exige `telefone_verificado = 1` |
| Confirmação do número ("ZEVEM 123456") | `backend/server.js:680-692`, `backend/whatsapp.js:715-720`, `:736-746` | Não descrita no PDF |
| Telefone único entre contas | `backend/server.js:626-631` | 409 no cadastro |
| Atalho sem IA (termos aprendidos) | `backend/whatsapp.js:557-564`, `backend/server.js:1318-1345` | |
| Interpretação por IA, cache, custo por mensagem | `backend/whatsapp.js:382-412` | Modelo por `WHATSAPP_MODELO_IA` |
| Lançamento, parcelas, suspenso | `backend/whatsapp.js:418-479` | |
| Consultas (saldo e total gasto) | `backend/whatsapp.js:482-545`, `:251-267` | |
| Histórico de mensagens, tokens e custo | `backend/whatsapp.js:151-172`, `:601-609` | Tabela `whatsapp_mensagens` |
| Tipos de alerta e nomes dos 7 templates | `backend/whatsapp.js:44-87` | Nomes iguais aos do PDF |
| Agendador de hora em hora a partir das 8h | `backend/server.js:2547-2648` | Fuso de Brasília |
| Alertas configuráveis (meta, limite programado) | `backend/whatsapp.js:642-689` | |
| Aviso para a outra pessoa | `backend/whatsapp.js:470-476` | |
| Variáveis de template sem vazio e sem quebra de linha | `backend/whatsapp.js:620-623` | Vazio vira "—" |
| `GET /saida` com reserva de 10 min e expiração de 24h | `backend/whatsapp.js:749-762` | |
| `POST /saida/:id/status` | `backend/whatsapp.js:764-771` | 404 em repetição |
| Configuração dos alertas por usuário | `backend/whatsapp.js:774-801`, tabela `alertas_config` em `:142-150` | |
| Simulador "Testar conversa" | `backend/whatsapp.js:804-814`, `src/app/pages/alertas/alertas.html:186-222` | Lança de verdade |
| Histórico de avisos na tela | `backend/server.js:2651-2655`, `src/app/pages/alertas/alertas.html:224-246` | |
| Textos de alerta editáveis pelo master | `backend/admin.js:290-310` | |
| Simulação do agendador (só local) | `backend/server.js:2658-2669` | `DEV_SEM_LOGIN=1` |
| Botão "Confirmar WhatsApp" | `src/app/pages/configuracoes/configuracoes.html:58-65` | Usa `WHATSAPP_NUMERO` para o link `wa.me` |
| Exportar e excluir conta (LGPD) inclui mensagens e avisos | `backend/server.js:468-496` | Qualquer tabela com `usuario_id` |
| Variáveis de ambiente | `backend/.env.example` | Falta `WHATSAPP_NUMERO` |

Conferência dos parâmetros dos 7 templates: os nomes das variáveis gerados pelo código batem com a tabela do PDF em todos os tipos (`backend/server.js:2559-2620`, `backend/whatsapp.js:474`, `:660`, `:684`). O código envia chaves extras (`quando`, `lista`) que o integrador deve ignorar.

### 3.3 O que não existe

- Nenhum código que fale com a Meta ou com um BSP: não há webhook de entrada, cliente da Graph API, download de mídia, transcrição, envio de mensagem nem leitor da fila. A busca por `graph.facebook`, `whisper`, `openai` e afins no repositório não retorna nada.
- Nenhum teste de backend. O único teste é `src/app/app.spec.ts`. O CI roda `npm test` do frontend e sobe os containers para checar `/health` (`.github/workflows/deploy.yml`).
- Nenhum termo de uso ou consentimento no cadastro ou em Configurações (busca por termo, consentimento e opt-in no `src/` sem resultado relacionado a WhatsApp).
- Nenhum painel de custos de IA ou de taxa de falha de envio para o master. Os dados são gravados, mas `backend/admin.js:342` só usa a contagem de mensagens no índice de utilização.

### 3.4 Infra e deploy

- VPS com Docker Compose: `frontend` em `127.0.0.1:3201` e `backend` em `127.0.0.1:3202`, volume `zevem-data` em `/data` (`compose.yaml`).
- Nginx do host atende `app.zevem.com.br` e encaminha `/api/` para o backend removendo o prefixo (`deploy/nginx-host/zevem-https.conf:22-28`). Portanto, a URL pública das rotas é `https://app.zevem.com.br/api/integracao/whatsapp/*`.
- Variáveis de produção em `/opt/zevem/.env.production`, lidas por `env_file` no serviço `backend`. O passo 3 de `deploy/README.md` cria o arquivo só com `FRONTEND_URL`, `JWT_SECRET`, `DADOS_KEY` e `MASTER_EMAILS`.
- Deploy por GitHub Actions via SSH com rollback de containers (`deploy/deploy.sh`), notificação no Telegram e backup diário local e no R2 (`deploy/backup.sh`, `deploy/r2-backup.sh`).
- O item "Pendente" do changelog confirma o que falta: "templates do WhatsApp na Meta" (`CHANGELOG.md:27`).

## 4. Gap analysis

### 4.1 Lado do integrador (não existe)

| # | Requisito do PDF | Existe? | O que fazer | Compl. |
|---|---|---|---|---|
| I1 | Número WhatsApp Business e conta na Meta ou BSP | Não | Definir provedor, criar app e WABA, verificar o negócio, registrar o número, gerar token permanente | M (externo) |
| I2 | Webhook de entrada | Não | Endpoint público com verificação do desafio (GET) e validação da assinatura (POST); responder rápido e processar em segundo plano | M |
| I3 | Repassar texto para `/mensagens` | Não | Cliente HTTP com Bearer, timeout de 30 s, repetição com a mesma `mensagem_id` em erro de rede ou 5xx | P |
| I4 | Enviar `resposta` como mensagem de sessão | Não | Envio de texto livre pela API do provedor, preservando quebras de linha e emojis | P |
| I5 | Não reenviar resposta já entregue | Não | Estado local por `wamid` (recebida, respondida) no integrador | P |
| I6 | Baixar e transcrever áudio em pt-BR | Não | Download da mídia, chamada ao provedor de transcrição, envio com `tipo: "audio"`; transcrição vazia em caso de falha | M |
| I7 | Buscar a fila a cada 1 min | Não | Laço de busca em `/saida` sem sobreposição de execuções | P |
| I8 | Enviar aviso como template com parâmetros na ordem | Não | Mapa fixo template → lista ordenada de variáveis; idioma `pt_BR`; acrescentar 55 ao telefone | M |
| I9 | Texto livre dentro da janela de 24h | Não | Guardar o horário da última mensagem recebida por telefone; opcional na primeira versão | P |
| I10 | Confirmar `enviado` ou `falhou` | Não | `POST /saida/:id/status` com o `wamid` ou o erro do provedor | P |
| I11 | Cadastrar e aprovar os 7 templates | Não | Submeter na Meta com os textos sugeridos; ajustar se houver recusa e alinhar com o dono do produto | M (externo) |
| I12 | Monitorar `/saude` e taxa de erros de envio | Não | Verificação periódica e alerta; dá para reaproveitar o bot do Telegram do deploy | P |
| I13 | Tipos de mensagem fora do contrato (imagem, documento, figurinha, localização) | Não previsto no PDF | Definir resposta padrão do integrador; ver dúvida D7 | P |

### 4.2 Lado do Zevem (existe, com lacunas)

| # | Requisito do PDF | Situação | O que fazer | Compl. |
|---|---|---|---|---|
| Z1 | Quatro rotas e autenticação | Implementado (`backend/whatsapp.js:692-771`) | Nada; validar com os cenários de aceite | - |
| Z2 | Idempotência por `mensagem_id` | Implementado, com falha em concorrência (ver 4.3, A1) | Reservar a `mensagem_id` antes de processar | P |
| Z3 | Identificação por telefone cadastrado | Implementado com regra mais rígida: exige confirmação do número (`backend/whatsapp.js:198`) | Decidir se a regra fica e atualizar a documentação (ver D3) | P |
| Z4 | Duas pessoas por conta, alerta por pessoa | Implementado (`backend/server.js:637`, `backend/whatsapp.js:218-222`) | Nada | - |
| Z5 | "O usuário escolhe quais no menu Alertas" | Tela pronta, mas restrita ao master (`src/app/app.routes.ts:40`, `src/app/shared/sidebar/sidebar.html:121-169`) | Liberar a rota e o item de menu para clientes; esconder a edição de textos, que é do master | P |
| Z6 | Simulador "Testar conversa" | Implementado, dentro da tela restrita ao master | Sai junto com Z5 | - |
| Z7 | Agendador, reserva, expiração, chave única | Implementado (`backend/server.js:2628-2648`, `backend/whatsapp.js:749-762`) | Tratar avisos criados com a integração desligada (ver A4) | P |
| Z8 | Aviso para a outra pessoa | Implementado (`backend/whatsapp.js:470-476`) | Nada | - |
| Z9 | Histórico, tokens e custo por mensagem | Gravado (`backend/whatsapp.js:601-609`); sem tela de consulta para o master | Opcional: painel de custo e falhas no master | M |
| Z10 | Variáveis `WHATSAPP_INTEGRACAO_TOKEN`, `ANTHROPIC_API_KEY`, `WHATSAPP_MODELO_IA` | Documentadas em `backend/.env.example`; ausentes do `.env.production` | Preencher em produção; documentar `WHATSAPP_NUMERO` (`backend/server.js:689`) | P |
| Z11 | Backend público com HTTPS | Atendido em `https://app.zevem.com.br/api/` | Informar a URL com `/api` ao integrador; se o integrador rodar na mesma VPS, usar a rede interna | - |
| Z12 | Termo de uso e opt-in (checklist de go-live) | Não existe | Texto de consentimento no fluxo "Confirmar WhatsApp" com data do aceite gravada; forma de sair (ver D8) | M |
| Z13 | Cenários de aceite | Sem testes automatizados de backend | Testes de API cobrindo os 10 cenários da página 10 | M |
| Z14 | Backup diário de `DATA_DIR` | Atendido (`deploy/backup.sh`, `deploy/r2-backup.sh`) | Se o integrador tiver estado próprio, incluir no backup ou aceitar perda | P |
| Z15 | Uma única instância, reinício automático | Atendido (`compose.yaml`, `restart: unless-stopped`) | Nada | - |

### 4.3 Achados da leitura do código

Itens que não são requisitos novos, mas que afetam o aceite ou a operação. Nenhum foi reproduzido em execução.

| # | Achado | Evidência | Impacto | Correção | Compl. |
|---|---|---|---|---|---|
| A1 | Lançamento duplicado em chamadas concorrentes com a mesma `mensagem_id` | A checagem (`backend/whatsapp.js:710-713`) ocorre antes do `await` da IA (`:731`); o registro só é gravado depois (`:732`). Duas chamadas simultâneas passam pela checagem, as duas lançam e a segunda falha no índice único (`:171`) com erro 500 | Reentrega do webhook ou nova tentativa por timeout enquanto a primeira ainda roda pode duplicar o gasto. Quebra o cenário de aceite de idempotência | Inserir o registro (reserva) antes de processar e atualizar ao final; no integrador, processar em série por `mensagem_id` | P |
| A2 | Data do atalho sem IA usa o relógio do servidor | `interpretarMensagem` usa `new Date()` local (`backend/server.js:1327`); o container não define fuso (`compose.yaml`), logo roda em UTC | Entre 21h e 0h de Brasília, "almoço 45" pelo atalho de termos aprendidos é lançado com a data do dia seguinte. Contradiz "o fuso do servidor não importa" | Usar `agoraBrasilia()` na função ou definir `TZ=America/Sao_Paulo` no serviço | P |
| A3 | Valores de `acao` fora da lista do PDF | `telefone_confirmado`, `codigo_invalido` (`backend/whatsapp.js:740-745`) e `vazia` (`:552`) | Só métricas e logs do integrador; ele deve aceitar valores desconhecidos | Atualizar a documentação | P |
| A4 | Avisos gerados com a integração desligada nunca entram na fila | Status inicial `sem_canal` (`backend/whatsapp.js:615-618`); a fila só lê `pendente` e `reservado` (`:754-755`) | Esperado para avisos antigos. Atenção na ordem do go-live: ligar o token antes da primeira rodada do dia | Documentar; nenhuma mudança obrigatória | - |
| A5 | Texto acima de 5.000 caracteres devolve 413, não 400 | Middleware global (`backend/server.js:89-94`) | Transcrição de áudio muito longa é recusada com código fora do contrato | Integrador limita a duração do áudio ou corta o texto | P |
| A6 | Rotas da integração sem limite de requisições e sem limite de IA por usuário | `iaLimiter` só é aplicado ao simulador (`backend/whatsapp.js:804`); `/mensagens` não tem limitador | Um número confirmado pode gerar custo de IA sem teto | Limite por telefone no integrador ou no backend | P |
| A7 | Falha de entrega posterior não pode ser registrada | Depois de `enviado`, novo status devolve 404 (`backend/whatsapp.js:767-769`) | O provedor costuma informar falha de entrega depois de aceitar a mensagem (**suposição**, a confirmar na documentação do provedor); o histórico mostraria "Enviado" | Combinar com o dono do produto se o contrato aceita `falhou` depois de `enviado` (ver D6) | P |
| A8 | Chave do aviso "a outra pessoa lançou" usa o horário | `lanc:${g.id}:${Date.now()}` (`backend/whatsapp.js:473`) | Diverge da regra "tipo + item + data + pessoa" do PDF; na prática é intencional, pois cada lançamento gera um aviso. Somado a A1, pode duplicar o aviso | Resolvido junto com A1 | - |
| A9 | Mensagens e avisos valem para qualquer conta, com ou sem assinatura | `/mensagens` não consulta assinatura; o agendador percorre todos os usuários (`backend/server.js:2629`) | Custo de IA e de template para contas sem pagamento | Decisão de produto (ver D9) | P |
| A10 | Parâmetros da API de IA e identificadores de modelo | `backend/whatsapp.js:24-32`, `:387-399` | Não foram validados nesta avaliação | Validar em homologação com `/saude` e o simulador antes do go-live | P |

## 5. Mudanças técnicas propostas

### 5.1 Onde colocar o integrador

| Opção | Descrição | Prós | Contras |
|---|---|---|---|
| A (recomendada) | Serviço separado no mesmo repositório (`integrador/`), terceiro serviço do `compose.yaml`, chamando `http://backend:3200/integracao/whatsapp/*` pela rede interna do Docker | Respeita o contrato do PDF sem mexer no backend; segredos da Meta isolados; `/integracao/*` não precisa de acesso externo; deploy e rollback já existentes | Um container a mais; estado próprio pequeno |
| B | Módulo dentro do backend (`backend/whatsapp-canal.js`) | Menos peças | Mistura o canal com o produto, que tem outro responsável segundo o PDF; exige corpo bruto para validar a assinatura, e hoje `express.json()` é global (`backend/server.js:81`) |
| C | BSP com automação pronta ou ferramenta de fluxo | Menos código | Custo mensal, dependência do fornecedor, idempotência e repetição difíceis de garantir |

A recomendação é uma **suposição de arquitetura**, a confirmar com quem decide o provedor (ver D1). As seções seguintes consideram a opção A.

### 5.2 Serviço integrador

Componentes (nomes sugeridos):

- `GET /webhook`: verificação do desafio do provedor com um token de verificação.
- `POST /webhook`: valida a assinatura sobre o corpo bruto, grava o evento e responde 200 de imediato; o processamento segue em segundo plano.
- Processador de entrada: para texto, chama `/mensagens`; para áudio, baixa a mídia, transcreve e chama `/mensagens` com `tipo: "audio"`; para outros tipos, responde um texto padrão. Depois envia `resposta` e marca o evento como respondido.
- Laço da fila: a cada 60 s chama `GET /saida?limite=50`, envia cada aviso (template ou texto conforme a janela) e chama `POST /saida/:id/status`.
- Verificador de saúde: chama `/saude` periodicamente e alerta em caso de falha ou de `ia: false`.

Mapa de templates (ordem dos parâmetros, página 7 e 8 do PDF):

| Template | Parâmetros em ordem |
|---|---|
| `ag_conta_vencendo` | nome, conta, vencimento, valor |
| `ag_fatura_fecha` | nome, cartao, fechamento |
| `ag_melhor_dia_compra` | nome, cartao, pagamento |
| `ag_fatura_vence` | nome, cartao, vencimento |
| `ag_meta_atingida` | nome, item, percentual, realizado, meta, disponivel |
| `ag_limite_programado` | nome, total, por_dia, mes |
| `ag_lancamento_outra_pessoa` | nome, pessoa, valor, item, saldo |

Cuidados de implementação:

- Telefone de saída: a fila entrega só dígitos como cadastrado. Acrescentar 55 quando vier com 10 ou 11 dígitos. Guardar o identificador do WhatsApp recebido na última mensagem de cada número e preferi-lo no envio, por causa do nono dígito (**suposição** sobre o comportamento do provedor).
- Valores das variáveis não devem ser reformatados. O valor pode vir como "não informado" (`backend/server.js:2562`) e o saldo negativo vem com sinal tipográfico (`backend/whatsapp.js:289`).
- Aviso sem confirmação volta à fila em 10 min: confirmar sempre, mesmo em falha, para não reenviar.
- Aviso com `falhou` não volta sozinho. Definir política de nova tentativa (sugestão: até 2 tentativas para erros temporários, nenhuma para número inválido).

### 5.3 Modelo de dados

No Zevem, nenhuma tabela nova é obrigatória. Alterações sugeridas, seguindo o padrão do projeto (`ALTER TABLE` em `try/catch` na subida):

| Tabela | Mudança | Motivo |
|---|---|---|
| `whatsapp_mensagens` | Permitir registro em andamento (`acao` nula ou `processando`) inserido antes da IA | Correção de A1 |
| `pessoas` | `whatsapp_optin_em` (data e hora) e `whatsapp_optin_versao` | Z12, prova do consentimento |
| `pessoas` | `whatsapp_optout_em` | Saída a pedido do usuário, se adotada (D8) |

No integrador (SQLite próprio em volume do serviço, **suposição**):

| Tabela | Campos | Uso |
|---|---|---|
| `entrada` | `wamid` (chave), telefone, tipo, estado (recebida, processada, respondida, falhou), resposta, tentativas, horários | Não perder mensagem em reinício e nunca reenviar resposta entregue |
| `contatos` | chave do telefone, identificador do WhatsApp, última mensagem recebida | Janela de 24h e número de envio |
| `envios` | id do aviso, tentativa, resultado, erro | Métrica de taxa de erro |

### 5.4 Endpoints

| Onde | Endpoint | Situação |
|---|---|---|
| Zevem | As quatro rotas `/integracao/whatsapp/*` | Existem; só a correção de A1 |
| Zevem | `POST /pessoas/:id/telefone/codigo` | Existe; acrescentar o registro do aceite do termo (Z12) |
| Integrador | `GET` e `POST /webhook` | Criar |
| Integrador | `GET /health` | Criar, para o healthcheck do Compose |

### 5.5 Frontend

- Liberar `/alertas` para clientes: tirar `masterGuard` de `src/app/app.routes.ts:40` e mover o item de menu para fora do grupo Master em `src/app/shared/sidebar/sidebar.html:162`. Manter a edição de textos restrita ao master (as rotas `/admin/textos-alertas` já exigem master em `backend/admin.js:293-301`).
- Termo de consentimento no fluxo "Confirmar WhatsApp" de `src/app/pages/configuracoes/configuracoes.html:58-65`.
- Opcional: painel master com custo de IA por período e taxa de falha de envio.

### 5.6 Configuração e segredos

Backend (`/opt/zevem/.env.production`):

| Variável | Situação |
|---|---|
| `WHATSAPP_INTEGRACAO_TOKEN` | Gerar com `openssl rand -hex 32` |
| `ANTHROPIC_API_KEY` | Fornecida pelo dono do produto (página 12 do PDF) |
| `WHATSAPP_MODELO_IA` | Opcional; decidir o modelo (D10) |
| `WHATSAPP_NUMERO` | Número do Zevem com DDI; usada no link `wa.me` da confirmação (`backend/server.js:689`). Acrescentar a `backend/.env.example` |

Integrador (nomes sugeridos, **suposição**): URL interna do backend, o mesmo `WHATSAPP_INTEGRACAO_TOKEN`, identificador do número e da conta no provedor, token de acesso, segredo do app para a assinatura, token de verificação do webhook, chave do provedor de transcrição e intervalo da fila.

### 5.7 Infra e deploy

- Novo serviço `integrador` em `compose.yaml`, com porta em `127.0.0.1` e healthcheck.
- Nova `location` em `deploy/nginx-host/zevem-https.conf` apontando o caminho do webhook para o integrador. Avaliar bloquear `/api/integracao/` externamente se o integrador ficar na rede interna.
- Atualizar `deploy/README.md` (variáveis e passos do provedor), `deploy/deploy.sh` (checagem de saúde do integrador) e o job de validação em `.github/workflows/deploy.yml`.
- Backup: incluir o banco do integrador em `deploy/backup.sh` ou registrar que ele pode ser perdido.

### 5.8 Testes

- Backend: testes de API para os 10 cenários de aceite da página 10 do PDF, com a IA simulada. Hoje não há estrutura de testes no backend; o executor nativo do Node 24 evita dependência nova.
- Integrador: testes com o provedor e o Zevem simulados para assinatura do webhook, repetição com a mesma `mensagem_id`, não reenvio de resposta, ordem dos parâmetros dos 7 templates e reserva da fila.
- Homologação: número de teste do provedor, as duas pessoas de uma conta e um áudio real em português.

## 6. Plano em fases

| Fase | Tarefa | Compl. | Depende de |
|---|---|---|---|
| 0. Decisões e acessos | Escolher provedor (D1), obter número, acessos e chaves | M (externo) | Cliente |
| 0 | Submeter os 7 templates para aprovação | M (externo) | Provedor definido |
| 1. Zevem pronto para o canal | Corrigir A1 (idempotência concorrente) | P | - |
| 1 | Corrigir A2 (fuso no atalho sem IA) | P | - |
| 1 | Documentar `WHATSAPP_NUMERO` e preencher variáveis de produção | P | Fase 0 |
| 1 | Testes de API dos cenários de aceite | M | - |
| 2. Integrador: conversa | Esqueleto do serviço, webhook com verificação e assinatura, estado local | M | Fase 0 |
| 2 | Fluxo de texto: repasse, resposta, repetição e não reenvio | P | - |
| 2 | Fluxo de áudio: download e transcrição | M | Chave de transcrição |
| 2 | Resposta padrão para tipos não suportados | P | D7 |
| 3. Integrador: avisos | Laço da fila, envio de template, confirmação de status | M | Templates aprovados |
| 3 | Janela de 24h com texto livre (otimização de custo) | P | - |
| 3 | Política de nova tentativa para `falhou` | P | - |
| 4. Produto | Liberar menu Alertas para clientes (Z5) | P | Decisão do cliente |
| 4 | Termo de consentimento e registro do aceite (Z12) | M | Texto jurídico do cliente |
| 4 | Saída a pedido do usuário, se adotada (D8) | P | Decisão do cliente |
| 5. Infra e operação | Serviço no Compose, Nginx, deploy, CI | M | Fase 2 |
| 5 | Monitoramento de `/saude` e taxa de erro com alerta | P | - |
| 5 | Limite de mensagens por telefone (A6) | P | - |
| 6. Aceite e go-live | Rodar os 10 cenários em homologação e o checklist das páginas 14 e 15 | M | Tudo acima |
| Opcional | Painel master de custo de IA e falhas de envio (Z9) | M | - |

Total estimado: cerca de 10 a 15 dias úteis de um desenvolvedor, sem os itens opcionais e sem o prazo de aprovação da Meta. As fases 1 e 4 podem andar em paralelo com a fase 0.

## 7. Dúvidas em aberto

Para o cliente Apple Green (dono do produto):

| # | Dúvida |
|---|---|
| D1 | Meta Cloud API direta ou BSP? Qual? O PDF cita os dois sem decidir (páginas 1, 11 e 12). Quem é o titular da conta e quem paga? |
| D2 | O número do WhatsApp Business já existe e está verificado? É um número novo ou um que já é usado em aplicativo? |
| D3 | O PDF diz que basta o telefone cadastrado em Configurações; o código exige a confirmação "ZEVEM <código>". Qual é a regra oficial? A documentação será atualizada? |
| D4 | O menu Alertas será liberado para clientes já no go-live? Hoje é só do master. |
| D5 | Quem mantém o backend daqui em diante? As correções A1 e A2 podem ser feitas por quem fizer o integrador? |
| D6 | O contrato pode aceitar `falhou` depois de `enviado` e, eventualmente, estados de entregue e lido? |
| D7 | O que responder a imagem, documento, figurinha, localização e contato? Foto de comprovante é uma demanda futura? |
| D8 | Qual é o texto do termo de uso e do opt-in? Haverá palavra de saída (ex.: "SAIR")? Hoje ela cairia na IA como "outro". |
| D9 | WhatsApp vale para qualquer conta ou só para assinatura ativa? E no período de teste? |
| D10 | Qual modelo usar em produção? O PDF recomenda testar o mais barato com mensagens reais antes de trocar. Existe orçamento mensal de IA? |
| D11 | Qual provedor de transcrição? O PDF lista alternativas sem escolher (página 11). Há restrição de enviar áudio de usuários a esse fornecedor (LGPD)? |
| D12 | Os avisos devem ter horário limite de envio à noite? O agendador roda de hora em hora a partir das 8h e não tem teto de horário, exceto o alerta programado (8h a 22h, `backend/whatsapp.js:236`). |
| D13 | Nome de exibição e perfil do número (marca Zevem ou Apple Green)? Os templates usam o prefixo `ag_`. |
| D14 | Ambiente de homologação: haverá um segundo backend e um número de teste, ou os testes serão em produção com contas de teste? |

Para o provedor WhatsApp (Meta ou BSP):

| # | Dúvida |
|---|---|
| P1 | Preço atual de template Utility no Brasil e regra de cobrança de respostas dentro da janela. O PDF avisa que os valores vieram de terceiros e pede confirmação na tabela oficial (página 11). |
| P2 | Os 7 textos passam como Utility? Risco maior em `ag_melhor_dia_compra` e `ag_limite_programado`, que podem ser lidos como promocionais (**suposição**). |
| P3 | Limite diário de conversas iniciadas para número novo e como ele sobe. |
| P4 | Formato do webhook, forma de validar a assinatura, política de reentrega e prazo para responder. |
| P5 | Formato e validade do link de mídia de áudio e tamanho máximo. |
| P6 | Formato do número brasileiro no envio e no recebimento (nono dígito). |
| P7 | Taxa do BSP, se houver: por mensagem ou mensalidade (o PDF deixa fora da conta, página 11). |

## 8. Riscos e dependências

| Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|
| Prazo de verificação do negócio e aprovação de templates na Meta | Média | Atrasa o go-live dos avisos | Iniciar a fase 0 já; a conversa (fase 2) não depende de template |
| Template recusado ou reclassificado como Marketing | Média | Custo maior ou retrabalho de texto e de código | Submeter cedo; manter os mesmos parâmetros; avisar o dono do produto se mudar ordem |
| Lançamento duplicado (A1) | Média | Erro financeiro visível ao usuário | Corrigir antes do go-live; integrador processa em série por mensagem |
| Data errada à noite (A2) | Alta para quem usa termos aprendidos | Gasto no dia errado | Corrigir na fase 1 |
| Custo de IA sem teto (A6, A9) | Baixa a média | Gasto inesperado | Limite por telefone; decisão sobre assinatura; alerta de custo |
| Resposta da IA acima de 30 s ou indisponibilidade | Baixa | Usuário sem resposta | O backend já responde com mensagem de erro ou suspenso (`backend/whatsapp.js:580-588`); integrador repete com a mesma `mensagem_id` |
| Backend único com SQLite | Baixa | Indisponibilidade derruba conversa e avisos | Reinício automático já existe; avisos não confirmados voltam à fila; avisos com mais de 24h expiram |
| Token único e sem rotação | Baixa | Vazamento dá acesso a lançar gastos em qualquer conta com número confirmado | Manter `/integracao/*` só na rede interna; trocar o token em caso de suspeita |
| LGPD: áudio e texto financeiro enviados a terceiros (transcrição e IA) | Média | Exigência legal | Termo de consentimento claro (Z12); o texto das mensagens fica em claro em `whatsapp_mensagens.texto`, só o telefone é cifrado (`backend/whatsapp.js:605`) |
| Qualidade do número cai por bloqueios de usuários | Baixa | Limite de envio reduzido | Opt-in explícito, forma de sair, alertas configuráveis por pessoa |
| Ausência de testes de backend | Alta | Regressão silenciosa em regras financeiras | Fase 1: testes de API dos cenários de aceite |

Dependências externas: decisão de provedor, número e conta Meta, chave da Anthropic com cobrança ativa, chave do provedor de transcrição, texto jurídico do opt-in e aprovação dos templates.
