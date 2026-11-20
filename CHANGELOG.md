# Changelog

Todas as mudanças relevantes do Zevem (antigo Apple Green) ficam registradas aqui.
Versionamento semântico: PATCH = correções e pequenos ajustes; MINOR = novas funcionalidades; MAJOR = mudanças estruturais.

## [1.6.1] - 2026-11-20

### Corrigido
- **Master › Cupons:** o editor de cupom estava desalinhado. Os rótulos agora ficam na mesma linha, todos os campos têm a mesma altura e o "Vazio: sem prazo" da validade não empurra mais os outros campos.

## [1.6.0] - 2026-11-19

### Adicionado
- **Aba lateral de depoimentos na página de venda**, no mesmo desenho da aba de avaliações da loja da Aurora, nas cores do Zevem.
  - Fica fixa na borda esquerda, com ★ e o total. Em telas até 1200 px, onde cobriria o texto, vira um botão no canto inferior esquerdo.
  - Abre uma gaveta com a nota média, as estrelas e os depoimentos, 8 por vez com "Ver mais". Fecha com ✕, clicando fora ou com Esc.
  - Usa os mesmos depoimentos da seção da página (`depoimentos` em assinar.ts). Campos opcionais novos: estrelas, título, data e "verificado". A aba só aparece com pelo menos um depoimento preenchido.
- **Cupons de desconto no checkout, criados em Master › Cupons.**
  - No admin: código, desconto em % ou em R$ no ano, validade, limite de usos, anotação interna e ativo/inativo. A tela mostra quanto o cliente vai pagar com o cupom, os usos, a receita e a situação (valendo, esgotado ou vencido, desativado).
  - Cupom já usado em vendas não pode ser excluído, só desativado.
  - No checkout, a etapa "Seu plano" ganhou "Tem um cupom de desconto?". Com o cupom, o preço riscado, o desconto e os novos valores aparecem no plano, no cartão e no Pix.
  - O desconto vale só para o 1º ano; a renovação volta ao preço do plano. O total nunca fica abaixo de R$ 5 por parcela (mínimo do Asaas).
  - O cupom é conferido de novo na hora de pagar: se venceu ou esgotou nesse meio-tempo, o pagamento é recusado e o preço volta ao cheio. Trocar o cupom com um Pix já gerado cancela esse Pix.
  - A assinatura guarda o valor pago no ciclo e o cupom usado.

## [1.5.1] - 2026-11-18

### Alterado
- **MEVEM® na página de venda.** A marca registrada ganhou o ® nas quatro vezes em que aparece: no topo, na legenda da foto, no bloco do fundador e no rodapé.
- `.env.example`: em produção (docker compose), a chave do Asaas vai entre aspas simples; sem elas, o "$" do começo da chave é lido como variável e a chave chega cortada.

## [1.5.0] - 2026-11-18

### Adicionado
- **Checkout próprio em `/checkout`, pelo Asaas: o cliente paga e entra na hora, sem sair do Zevem.**
  - Tela dividida: à esquerda, as etapas e a garantia; à direita, a etapa atual. No celular, as etapas viram uma faixa no topo.
  - As 4 etapas: Quem é você (nome, e-mail, WhatsApp, CPF) → Seu plano (anual, 12x de R$ 27,90) → Pagamento (cartão em 12x ou Pix à vista, aqui mesmo) → Ativação (cria a senha e entra direto no app).
  - Cartão: compra parcelada aprovada na hora. Recusa mostra o motivo do Asaas. Os dados do cartão não são gravados nem vão para o log; o Asaas guarda o cartão e devolve um token para a renovação.
  - Pix: QR Code e copia-e-cola. A tela consulta a cada 4 segundos e avança sozinha quando o pagamento cai, pelo webhook ou pela consulta. Trocar do Pix para o cartão apaga o Pix em aberto.
  - Com o pagamento confirmado, a conta nasce confirmada, com CPF e WhatsApp no titular, e a assinatura nasce paga no plano "Zevem Anual" (o preço pode ser mudado em Master › Planos). Um e-mail de boas-vindas leva para "criar senha" se o cliente fechar a página antes da etapa 4.
  - Se recarregar a página no meio da compra, ela continua de onde parou (só o id do checkout fica no navegador). E-mail que já tem conta é mandado para o login.
- **Asaas como provedor das assinaturas** (`backend/asaas.js`):
  - Renovação anual no mesmo cartão (12x). Sem cartão guardado, ou com o cartão recusado, gera uma cobrança com link de pagamento.
  - Aviso por e-mail 7 dias antes da renovação.
  - Webhook em `/pagamentos/webhook/asaas`, validado pelo token.
  - Estorno pelo master (garantia de 30 dias): `POST /admin/assinaturas/:id/estornar` devolve o ano no Asaas e cancela a assinatura na hora.
  - Configuração no `.env`: `ASAAS_API_KEY`, `ASAAS_AMBIENTE` (sandbox | producao) e `ASAAS_WEBHOOK_TOKEN`. Sem a chave, o checkout avisa que o pagamento está indisponível.

### Alterado
- **Página `/assinar` em primeira pessoa, com o João como planejador.** Abertura com a frase "Você não precisa entender sobre dinheiro. Eu serei seu planejador." e espaço para a foto e o vídeo do João (`public/lp/joao-abertura.webp` (terno) na abertura e `public/lp/joao-fundador.webp` (suéter) em "Quem te acompanha"; o vídeo entra em `public/lp/`). Os números ganharam "+100 planejadores formados".
- **Novas seções:**
  - Zevem × outros apps.
  - Lançamentos pelo WhatsApp e orçamento a dois com o cônjuge.
  - Comparativo de preço: R$ 15 mil/ano com um planejador contra R$ 27,90/mês no Zevem. O cartão do Zevem abre o pagamento.
  - Seis depoimentos, por enquanto em branco.
  - Orientação no WhatsApp: ilustração de um celular recebendo a mensagem "Esse final de semana você pode gastar R$ 400 com bares e restaurantes.", com a notificação chegando por cima.
  - "O que é o Zevem": Curso de Planejamento Financeiro + Sistema de gestão de orçamento pessoal + Inteligência artificial para te orientar sobre gastos.
  - Três pontos fortes logo após a abertura: proteja a qualidade de vida no presente, garanta a do futuro e acabe com a falta de clareza.
  - FAQ com 13 perguntas, incluindo "Você vai me atender pessoalmente?". A resposta sobre o celular diz que o Zevem é feito para o computador e que, pelo celular, o cliente usa o WhatsApp.
- **Assinatura sem formulário na página de venda.** Todos os botões de assinar abrem o checkout (`/checkout`). O endpoint `/assinar` do backend continua existindo, mas a página não o usa mais. No FAQ, "Como recebo o acesso?" e "Como funciona o pagamento?" agora dizem que o acesso sai na hora.
- **Ícone do Zevem.** A maçã com o Z aparece no topo, no contraste e no rodapé. As cores seguem as da MEVEM.
- **Garantia de 30 dias ou o dinheiro de volta.** No contraste, uma linha em destaque compara com os 7 dias que a lei exige dos outros. A garantia aparece num selo sobre a foto da abertura, no plano, no cartão de assinar, num selo grande depois do plano e no FAQ ("E se eu não gostar?"). O plano é anual, em 12x de R$ 27,90 no cartão, dito de forma discreta abaixo do preço e no FAQ ("Como funciona o pagamento?"). Saíram "Cancele quando quiser" e "Não tem fidelidade".
- No contraste, o lado dos outros apps traz sempre "Você fica anotando gastos.", e as frases do Zevem ficaram mais curtas.

## [1.4.0] - 2026-11-17

### Funcionalidades
- **Página pública de venda `/assinar`.** Página comercial com a identidade da MEVEM (lima sobre quase-preto) e um plano só, R$ 27,90/mês. Mostra: abertura com uma prévia ilustrativa do app, os números (10 anos, +1.400 clientes, 99,8% de aprovação), "Como funciona" em 3 passos, 6 recursos, depoimento do fundador, plano com formulário e perguntas frequentes. Funciona sem login e se adapta ao celular.
- **Pedido de assinatura.** O formulário (nome, e-mail, CPF, telefone e aceite dos termos) grava o pedido na nova tabela `pedidos_assinatura` (CPF e telefone cifrados) e manda um e-mail para os masters. Se o e-mail já tem conta, ele avisa. Tem limite de envios e uma armadilha para robôs. Enquanto não há gateway de pagamento, o master libera o acesso por Master › Enviar convite.

## [1.3.1] - 2026-11-17

### Alterado
- Import de fatura em PDF e sugestão de item usam o **Claude Sonnet 5.5** (antes, Claude Opus 5.5): leitura mais rápida e mais barata, com a mesma saída em JSON e o mesmo fallback da Anthropic.

## [1.3.0] - 2026-11-17

### Funcionalidades
- **Quitação Antecipada** (nova aba do Simulador de Dívidas). O cliente escolhe uma dívida da tabela, informa o aporte e a modalidade e vê o antes e depois de: saldo devedor, parcela, prazo e juros a pagar, mais a economia. Modalidades: antecipar parcelas (pagando as últimas), pagar as próximas parcelas, amortizar o saldo reduzindo a parcela, amortizar o saldo reduzindo o prazo e quitação total. Embaixo, um comparativo das cinco com o selo "maior economia". É só simulação: a dívida não muda. Dívida em SAC é simulada como parcela fixa, com aviso de valor aproximado.
- **Financiamento simulado vai para a tabela de Dívidas.** Depois de calcular, o botão "+ Adicionar à tabela de Dívidas" grava a dívida com descrição, guia e data de início. As parcelas que já venceram até hoje saem das restantes.
- **M.I.M. em todos os simuladores de Sonhos.** As seis abas (Aposentadoria, Imóvel, Carro, Viagem, Novo Filho, Faculdade) mostram o mesmo resultado: o cartão do total e o do "Investimento mensal necessário", com prazo, mês final e rentabilidade, mais o botão "+ Adicionar à tabela de Sonhos".
- **Cartão de cada gasto.** Quem tem mais de um cartão escolhe, na linha do gasto pago no cartão, em qual cartão ele cai, e o aviso de vencimento usa o dia da fatura desse cartão. O campo mostra o dia de vencimento da fatura, só o número e centralizado, como nas outras linhas, e a lista aberta mostra o nome e o dia de cada cartão. Sem cartão escolhido, ou com um cartão sem dia de vencimento cadastrado, o campo fica tracejado em âmbar ("cartão?" ou "?"). Com um cartão só, nada muda.
- **Titular no cadastro de pessoas.** Quem cria a conta já aparece em Configurações › Usuários, com nome e e-mail. Contas antigas sem nenhuma pessoa recebem o titular ao subir o servidor; planejadores ficam de fora.

### Alterado
- Gastos: a descrição ocupa no máximo duas linhas, então todas as linhas da tabela ficam com a mesma altura. O texto que não cabe termina esmaecido e aparece inteiro ao passar o mouse. Durante a edição, o texto rola dentro das duas linhas.

### Corrigido
- **Versão noturna:**
  - Textos vermelhos, rosas e âmbar ficaram mais claros, no mesmo tom. Antes ficavam escuros demais sobre o fundo verde.
  - Os rótulos "Elevado" e "Ruim" dos medidores do Dashboard usam o rosa claro.
  - Botões verde-limão sem cor de texto própria (ex.: "Enviar convite" e "Criar assinatura" na área master) voltaram a ter letra escura.
- **Import de fatura em PDF na produção:**
  - Faltava a chave da Anthropic no servidor; ela já foi configurada.
  - O nginx da VPS cortava a leitura depois de 60 s (resposta "Não foi possível importar a fatura"). Agora espera até 5 min (`proxy_read_timeout` em `deploy/nginx-host/zevem-https.conf`; aplicar na VPS).
  - Se o tempo ainda estourar, a tela diz que a leitura demorou.

### Técnico
- Coluna `gastos.cartao_id`. Ao excluir um cartão, os gastos dele voltam a "sem cartão".
- As contas da quitação ficam em `src/app/pages/dividas/quitacao.ts`, separadas do componente.

## [1.2.0] - 2026-11-16

### Funcionalidades
- **E-mail pela caixa da Hostinger.** Confirmação de cadastro, nova senha e convites saem por SMTP (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_REMETENTE`, `EMAIL_NOME`; padrão smtp.hostinger.com:465 com SSL). Sem SMTP configurado, vale o Gmail conectado pelo master, como antes. Quando o e-mail não sai, o aviso diz o motivo (senha recusada, servidor indisponível ou envio não configurado).

### Técnico
- Dependência `nodemailer` no backend. `deploy/README.md`: passo a passo do SMTP; o comando que gerava o link de confirmação do master passou a criar um token novo (desde a 1.1.0 o banco guarda só o hash, e o link antigo não pode ser recuperado).

## [1.1.1] - 2026-11-15

### Corrigido
- Versão publicada com a fonte igual à do localhost (o menu aparecia em negrito). O build de produção embutia a Montserrat no CSS com um arquivo de fonte diferente do que o navegador recebe do Google; agora a produção carrega a fonte do Google como no localhost (`optimization.fonts: false` no angular.json).

### Técnico
- Deploy na VPS (app.zevem.com.br): backend em `/api` no mesmo domínio (padrão do `environment.prod.ts`, trocável por `API_URL` no build) e pasta `scripts/` incluída no build do container do front.

## [1.1.0] - 2026-11-10

### Funcionalidades
- **Fechamento do mês.** Na virada do mês, cada item "Mensal Comprometido" com valor estimado que não teve nenhum gasto lançado no mês que acabou vai para Em suspenso com o valor estimado pelo cliente (data no último dia do mês, selo "Fechamento do mês"), só para ele confirmar, ajustar ou excluir. Roda uma vez por cliente e por mês, só para meses que o cliente viveu inteiros; não entra item que já tem gasto em suspenso naquele mês e a confirmação não ensina termos ao app.
- **Planejadores financeiros associados.** Novo menu master "Planejadores": pelo botão "Enviar convite" no topo (abre um modal), o master convida o planejador (nome completo, e-mail, CPF e telefone), copia ou reenvia o link, vê os clientes de cada um e remove ou devolve o acesso do planejador.
- **Área do planejador ("Meus clientes").** O planejador convida clientes pelo botão "Enviar convite" no topo (abre um modal), vê a lista de clientes ativos e os convites em aberto, e remove ou devolve o acesso dos seus clientes. O cliente que se cadastra pelo link fica vinculado ao planejador.
- **Clientes (master):** colunas Planejador e Acesso, filtros por planejador e por situação do acesso, troca do planejador de qualquer cliente (inclusive quem já tinha conta).
- **Enviar convite (master):** coluna "Convidado por" (Zevem ou o planejador).
- Cadastro pelo convite de planejador pede CPF e telefone (já preenchidos); o planejador entra direto em "Meus clientes" e não vê o vídeo de boas-vindas nem o anúncio "Contrate um planejador".
- Cliente que já tem planejador (cadastrado pelo convite dele ou vinculado pelo master) não vê o botão "Contrate um planejador": o anúncio chega desligado para ele pelo servidor e o app também confere o vínculo (`/auth/papel`), no menu e na janela do anúncio. Se o master tirar o planejador do cliente, o botão volta no próximo carregamento.
- **Acessar o Zevem do cliente.** Clicar no nome do cliente (master em Clientes e em Planejadores; planejador em "Meus clientes") abre o Zevem dele, com edição. Uma faixa no topo mostra de quem é a conta e o botão "Voltar para minha conta".
- Painel de vídeos só nas telas do menu do cliente: some nas áreas Master e Planejador e nunca aparece para o planejador.
- Telas de entrada (login, cadastro, confirmação de e-mail, redefinir senha) sem menu nem vídeos mesmo com alguém logado no navegador, com painel off-white e detalhes verde-lima e verde escuro; nova foto da tela de entrada.

### Alterado
- Painel de vídeos da direita: com todos os vídeos da página assistidos, ele entra recolhido; volta a abrir sozinho numa página com vídeo por ver (o recolher manual do usuário é respeitado).
- Menu lateral sem negrito.
- Padronização visual: fundo escurecido igual em todos os modais, título de modal em 18px, vermelho de erro e verde de sucesso únicos, verdes fora da paleta trocados no Sonhos, régua dos títulos em verde-limão, título e margens de Configurações iguais às outras telas, botão principal de Minha assinatura e de Configurações no verde-limão.
- Import de fatura e extrato: data no fim da descrição ("PADARIA 05/10") não vira mais parcela; parcela já lançada por fatura anterior (mesmo com centavos de diferença) e reimportação do mesmo arquivo contam como "já lançados" em vez de irem para suspenso; OFX de conta corrente não troca entradas por gastos; linhas de saldo do extrato ficam de fora; sinal "D/C" e "−" lidos; descrição certa no CSV do Inter e coluna de parcela do C6/Inter; datas inexistentes descartadas; valor acima de R$ 1 milhão vai para suspenso com aviso; só lança sozinho o que o usuário já ensinou com a mesma descrição (nome parecido com o item vira sugestão); PDF sem leitura configurada avisa antes de pedir a senha; IA com tempo limite de 2 min.
- Clientes (master): a coluna "Último gasto" mostra só os dias desde o último gasto lançado ("21d"), sem valor, data nem categoria.
- Clientes (master): tabela mais compacta, sem rolagem lateral a partir de uma tela de 1280px e com o nome do cliente numa linha só. Utilização mostra só a nota (sem a barra), Planejador virou um ícone redondo com as iniciais ("JC"; o nome aparece ao passar o mouse) que abre um modal para trocar o planejador do cliente ou deixá-lo sem planejador, valores em reais em formato contábil (R$ à esquerda, número à direita) e os demais números centralizados, Acesso e Jarro viraram só ícone (texto no título), cabeçalhos quebram em duas linhas, o e-mail quebra no "@" e as células têm letra e recuos menores.
- Se uma tela não carregar (versão nova publicada com o app aberto, ou servidor fora do ar), o app recarrega a página sozinho já na tela pedida, no máximo uma vez a cada 30 segundos.
- Vídeos sem o link de teste: os vídeos das páginas mostram "Vídeo em breve" até o master colar os links em Master → Vídeos. O vídeo de boas-vindas começa sem link e desligado.
- Parcelas de compra feita no fim do mês seguem o dia da compra: compra em 31/01 com a parcela atual em 28/02 continua em 31/03, 30/04… (antes ficava presa no dia 28). Se o usuário troca a data ao confirmar, vale a dele.
- Fatura em PDF: compra com mais de 12 parcelas sai com o ano certo. A IA lê também a data de fechamento, e a parcela atual tem de cair no mês da fatura; se cair um ano longe, o ano da compra é corrigido.

### Segurança
- Servidor fora do localhost (FRONTEND_URL que não é localhost) vale como produção mesmo sem NODE_ENV: não sobe sem JWT_SECRET e DADOS_KEY próprios e não liga o login sem senha.
- Sessão de suporte: a trava não era contornada só por maiúsculas ou barra final no endereço (ex.: /PESSOAS/1/TELEFONE/CODIGO); também bloqueia exportar os dados do cliente, cancelar a assinatura e trocar o celular de uma pessoa (que desligaria o WhatsApp verificado).
- Cadastro e confirmação de e-mail não revelam mais se um e-mail tem conta (sem id na resposta, mesmo tempo de resposta, "já confirmado" só com o link certo).
- Planejador não cancela convite em aberto do master ou de outro planejador.
- WhatsApp: conta com acesso removido não confirma número e seus avisos pendentes não saem.
- Log de pedido lento sem query string nem token de convite.
- "Remover acesso" bloqueia o login, derruba as sessões abertas e para os alertas e o reconhecimento pelo WhatsApp; os dados ficam guardados. O planejador só devolve o acesso que ele mesmo removeu; o master devolve qualquer um.
- Planejador sem acesso: os convites dele em aberto deixam de valer. Os clientes dele continuam com acesso.
- CPF e telefone do planejador cifrados com AES-GCM (mesma chave `DADOS_KEY`).
- Cadastro por convite só com o e-mail do convite; link de convite inválido não vira cadastro avulso e a tela do convite não oferece "Entrar" com outra conta.
- Acesso à conta do cliente: sessão própria de 4 horas presa às duas contas (cai se o cliente perder o acesso, se o planejador perder o acesso ou o vínculo, ou se qualquer um trocar a senha). Dentro dela não dá para trocar a senha, excluir a conta, derrubar as sessões nem mexer no WhatsApp verificado do cliente, e o último acesso do cliente não é alterado. Cada entrada fica registrada (`acessos_cliente`).
- Token de confirmação de e-mail guardado só como hash (SHA-256), como o de troca de senha. Os tokens antigos viram hash ao subir o servidor e o link já enviado continua valendo.
- O token de login só vai para o nosso backend: antes ia também para a API externa de cotação do dólar usada no Sonhos.

### Técnico
- Removidas as rotas sem uso `GET /fipe/buscar` e `POST /ia/valor-carro` (nenhuma tela chamava; a segunda gastava IA). As rotas FIPE do Sonhos (marcas, modelos, anos, preço) continuam.
- Todas as telas, menos o login, carregam sob demanda: pacote inicial de produção de 1,16 MB para 458 kB, e o `ng build` de produção volta a passar (ficam avisos de tamanho de estilo em gestao-gastos, sonhos e dashboard).
- Backend no horário de Brasília (`TZ=America/Sao_Paulo`); erro não tratado responde JSON; índices novos (e-mail normalizado, suspensos, lançamentos por item e data, fila de avisos); cadastro por convite e exclusão de item em transação; mensagem do WhatsApp reenviada durante o processamento não lança de novo.
- Front: falha de rede ao consultar o papel não tranca o master fora da área dele; vídeos assistidos acompanham a troca de usuário; vídeo de boas-vindas não cria player depois de fechado; removido `etapa.service.ts` (só gravava, ninguém lia).
- Fechamento do mês: `fecharMesesPendentes()` em `backend/server.js` (ao subir e a cada hora), tabela `meses_fechados (usuario_id, mes, suspensos)`, origem `fechamento` nos gastos em suspenso e nos lançamentos.
- `backend/planejadores.js` (rotas `/admin/planejadores`, `/admin/usuarios/:id/*`, `/planejador/*`); colunas `usuarios.bloqueado_em`, `bloqueado_por`, `planejador_id`; tabela `planejadores`; colunas `convites.tipo`, `planejador_id`, `cpf`, `telefone`.
- As duas telas novas carregam sob demanda (lazy).
- Rotas `POST /admin/usuarios/:id/acessar` e `POST /planejador/clientes/:id/acessar`; `/auth/papel` informa `suporte` quando a sessão é de acesso à conta do cliente e `tem_planejador` quando o cliente está vinculado a um planejador (`AuthService.temPlanejador`).
- Estilo: `src/styles/_tokens.scss` é a fonte única de cores e formas (paleta, neutros, estados, raios, sombras, overlay); as 32 folhas de estilo usam `@use 'tokens' as *` (caminho em `stylePreprocessorOptions` do angular.json) no lugar das 11 cópias da paleta, e as variáveis `--ag-*` de `styles.scss` saem dele.
- Lista de clientes do master (`/admin/clientes`): número fixo de consultas (GROUP BY para todos os clientes de uma vez) em vez de ~30 por cliente. `somasOrcamento()` em `server.js` alimenta GC, nível de saúde e a lista; resposta idêntica à anterior.
- Coluna `gastos_suspensos.data_compra`; `lancarComParcelas` recebe `data_compra` e `somarMeses(data, n, dia)` aceita o dia desejado. `corrigirAnoDasParcelas()` ajusta o ano das parcelas lidas do PDF.
- Build de produção: `API_URL=https://endereco-do-backend npm run build` (`scripts/build.mjs` passa o endereço por `--define`). Sem `API_URL` o build avisa e o app chama o backend no mesmo endereço do site; endereço de exemplo ou inválido interrompe o build. `environment.prod.ts` não tem mais o `SEU-BACKEND.onrender.com`.

## [1.0.0] - 2026-11-10

Versão base. Reúne tudo o que o app tem até esta data.

### Funcionalidades
- Cadastro, login e confirmação de e-mail; fluxo de senha (esqueci, redefinir, trocar).
- Dashboard com a Base de Plena Liquidez (BPL).
- Recebimentos, gastos e gestão de gastos (importação de CSV/OFX e leitura de faturas em PDF por IA), dívidas, ativos e passivos, sonhos.
- Alertas e infraestrutura do WhatsApp: rotas `/integracao/whatsapp/*`, interpretação de mensagens por IA, fila de avisos, confirmação do número ("ZEVEM <código>").
- Área master: clientes, anúncios e avisos, convites, vídeos, financeiro (planos, assinaturas anuais em 12x, cobranças, pedidos de cancelamento) e indicadores (MRR, ARPU, churn, LTV).
- Exportar e excluir conta (LGPD).

### Segurança
- Sessão JWT com versão de sessão, limitadores de requisição separados e limite de IA por usuário.
- CPF, e-mail e telefone das pessoas cifrados com AES-GCM.
- Validação de campos e OAuth do Gmail restrito ao master.

### Marca
- Rebrand de Apple Green para Zevem (paleta, logo e favicon). Pasta, banco e identificadores internos continuam com o nome antigo.

### Pendente
- Endereço do backend de produção, gateway de pagamento, templates do WhatsApp na Meta.
