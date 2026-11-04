# Desenvolvimento no Windows

## Requisitos

- Windows 10 ou 11 de 64 bits.
- Node.js 22.13 ou superior e npm 10 ou superior.
- Dependências instaladas para `apps/api` e `apps/web`.

O atendimento local usa `node:sqlite`, API experimental do Node. Este modo é destinado ao desenvolvimento em loopback e não substitui uma instalação de produção.

## Iniciar o ambiente

Na raiz do projeto:

```powershell
npm run install:all
npm run dev:local
```

O painel fica em `http://127.0.0.1:5173` e a API em `http://127.0.0.1:3000`. O launcher inicia ambos em loopback, habilita a demonstração e usa `.data/attendance.sqlite`. Os dados sobrevivem a reinícios; o arquivo e a pasta `.data/` são ignorados pelo Git.

Para rodar sem persistência:

```powershell
npm run dev:memory
```

Encerre os serviços com `Ctrl+C` no terminal do launcher.

## Verificações locais

```powershell
npm run check
npm run test:local
npm run test:sqlite
```

Os smoke tests iniciam temporariamente a API e o Vite nas portas `3000` e `5173`. Encerre uma sessão `dev:local` antes de executá-los. `test:sqlite` usa um banco temporário e não altera `.data/attendance.sqlite`.

## PostgreSQL

O projeto inclui um esquema PostgreSQL e armazenamento de eventos de webhook. As rotas locais de atendimento e o worker conversacional ainda não estão integrados a esse caminho. SQLite, contas de demonstração e o compose atual não devem ser tratados como configuração de produção. Consulte a [especificação técnica](especificacao-tecnica-plataforma-atendimento-whatsapp.md) antes de planejar uma implantação.
