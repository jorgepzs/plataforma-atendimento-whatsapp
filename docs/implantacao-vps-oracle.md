# Demonstração em uma VPS Linux sem Docker

Este documento descreve uma topologia possível para demonstração privada. O projeto não está pronto para atender clientes em produção. Não exponha as contas públicas de demonstração nem as rotas de atendimento local à internet.

## Limites atuais

- O atendimento completo usa o modo local em loopback e SQLite.
- O armazenamento PostgreSQL recebe eventos de webhook, mas ainda não implementa o worker conversacional, o painel administrativo e as rotas locais de atendimento.
- As respostas permanecem simuladas por padrão; o adaptador Cloud API local não é um envio multi-tenant para produção.
- A API e o launcher de túnel atuais têm verificações específicas para o ambiente local e para Windows. Uma implantação Linux exige configuração e validação próprias.

## Topologia de demonstração

```text
Navegador -- túnel SSH --> painel e API em 127.0.0.1
                               |
                         SQLite local

Meta --> Cloudflare Tunnel --> gateway webhook em 127.0.0.1:3001
                                     |
                               API em 127.0.0.1:3000
```

Mantenha o painel, a API e o banco acessíveis apenas localmente. Publique pelo túnel somente o gateway de webhook, com uma rota explícita para `webhook.example.com` e uma resposta final `404`. Substitua o hostname pelo seu domínio e valide DNS e origem antes de configurar o callback na Meta.

## Preparação futura

1. Confirmar distribuição, arquitetura, versão do Node e acesso administrativo ao servidor.
2. Criar uma conta de serviço sem privilégios e unidades `systemd` com reinício controlado e logs sem payloads ou segredos.
3. Instalar dependências e gerar builds a partir de um checkout limpo.
4. Configurar segredos fora do repositório e transferir apenas a credencial específica do túnel por um canal seguro.
5. Validar health checks locais, isolamento público, challenge Meta, assinatura e deduplicação com eventos sintéticos.
6. Manter o envio desligado/simulado durante a demonstração.

Uma implantação de produção exige, separadamente, autenticação e RBAC de produção, persistência e worker PostgreSQL, credenciais de canal por tenant, outbox de produção, backups, retenção, observabilidade e revisão de segurança. Não contorne as proteções do modo local para publicar o demo.
