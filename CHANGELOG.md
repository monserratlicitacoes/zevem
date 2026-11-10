# Changelog

Todas as mudanças relevantes do Zevem (antigo Apple Green) ficam registradas aqui.
Versionamento semântico: PATCH = correções e pequenos ajustes; MINOR = novas funcionalidades; MAJOR = mudanças estruturais.

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
