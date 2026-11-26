# Integração de pedidos

O assistente confirma o pedido dentro da plataforma. O sistema do restaurante, o PDV ou o marketplace entra depois, por uma interface só.

## O que já acontece

1. O rascunho vive na conversa. Preço, opção e total saem do catálogo da empresa.
2. O cliente confirma o resumo. O status passa a `confirmed`.
3. `OrderSink.deliver` recebe o pedido e o destino configurado na empresa.
4. A implementação padrão (`createWebhookOrderSink`) não chama terceiros se não houver URL. O pedido fica `confirmed`, com referência `local`.
5. Com `orderIntegration.webhookUrl`, ela faz `POST` e, em resposta 2xx, marca `sent_to_integration`. Erro HTTP ou de rede mantém `confirmed` e preenche `integrationError`. Uma pessoa pode cancelar ou marcar como enviado no painel.

O corpo é o pedido público: id, empresa, conversa, linhas, opções, entrega, subtotal, taxa e total em centavos. Não vai chave de IA nem segredo do webhook.

Cabeçalhos:

- `Content-Type: application/json`
- `X-Order-Id`: id do pedido, estável entre tentativas
- `X-Order-Signature: sha256=<hex>` quando há segredo. O HMAC-SHA256 é do corpo exato, em UTF-8, com o segredo da empresa.

O segredo é gravado na configuração da empresa e não volta no `GET`.

## Como plugar outro sistema

Implemente `OrderSink` em `apps/api/src/ordering/sink.ts`:

```ts
interface OrderSink {
  deliver(order: CustomerOrder, target: { webhookUrl?: string; webhookSecret?: string }): Promise<{
    delivered: boolean;
    reference?: string;
    error?: string;
  }>;
}
```

Passe a instância em `LocalAttendanceService` pela opção `orderSink`. O restante do atendimento não muda.

Um adaptador de iFood, Anota AI, Goomer, Saipos ou PDV faz três coisas:

1. Traduz `CustomerOrder` para o pedido daquele sistema (item externo, forma de entrega, pagamento).
2. Chama a API do parceiro com a credencial da empresa. Credencial não entra no prompt nem na resposta do painel.
3. Devolve `delivered: true` e a referência externa, ou `delivered: false` e um código curto de erro.

O webhook genérico continua útil como saída temporária: o sistema do restaurante recebe o JSON, confere a assinatura e grava o pedido. Não é necessário implementar esses marketplaces agora.

Repetir a confirmação do mesmo id deve ser idempotente do lado de quem recebe. A plataforma manda o mesmo `X-Order-Id` se o envio for tentado de novo.
