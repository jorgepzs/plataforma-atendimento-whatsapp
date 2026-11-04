# Envio WhatsApp de teste local

## Estado e limites

O sender Cloud API está integrado somente ao modo de demonstração local com outbox SQLite. `WHATSAPP_OUTBOUND_ENABLED=false` por padrão, e as respostas permanecem `SIMULATED`. Essa integração não provisiona credenciais por tenant e não deve ser usada para atender clientes em produção.

O sender local de teste exige loopback, SQLite, canal explicitamente configurado e allowlist de destinatários. O número autorizado na allowlist é o destinatário de teste; ele não representa o canal comercial de uma empresa.

## Política de envio

- Somente texto em resposta a uma mensagem inbound da Meta validada, dentro da janela de serviço de 24 horas.
- Bloqueio para simulador local, canal divergente, número inválido ou fora da allowlist, timestamp inválido/futuro e janela expirada.
- Sem templates, campanhas ou mensagens proativas.
- Endpoint HTTPS fixo `graph.facebook.com`, token apenas no header e redirecionamentos bloqueados.
- Timeout limitado, sem retry automático e sem registrar corpo ou credencial.
- Uma tentativa persistida por mensagem no modo de teste. Estado `SENDING` após reinício é recuperado como `INDETERMINATE` para evitar duplicidade.

`ACCEPTED` significa que o provedor aceitou a solicitação; não confirma entrega ao destinatário. Falhas HTTP têm classificação sanitizada. Timeout, erro de rede ou resposta inválida após HTTP 2xx produzem resultado indeterminado.

## Configuração

O adaptador só pode ser habilitado explicitamente em uma demonstração local não produtiva. A configuração requer versão da Graph API, Phone Number ID, token privado e números de teste permitidos. Nunca inclua credenciais em commits, logs, URLs ou mensagens de chat.

Antes de qualquer envio real, valide a conta e as permissões na Meta, confirme que o destinatário pertence ao operador e obtenha autorização específica para o teste. Os testes automatizados usam transporte falso e não enviam requisições à Meta.
