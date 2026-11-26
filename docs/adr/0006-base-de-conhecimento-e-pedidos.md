# ADR 0006: Base de conhecimento e pedidos no assistente

- Status: aceito
- Data: 2026-11-26

## Contexto

O gateway do ADR 0004 só podia repetir a FAQ. O prompt proibia confirmar pedido, reserva, agendamento e orçamento, e o atendimento desviava essas frases para uma pessoa antes do modelo. Isso impede o assistente de entender o que o cliente quer e de montar um pedido. A integração com aplicativos de restaurante fica para depois; o que falta agora é um lugar por empresa para os fatos e um pedido cujo preço não dependa do modelo.

## Decisão

Cada empresa ganha uma base além da FAQ: perfil (endereço, área, horário, entrega, retirada, taxa, pagamento, políticas e tom) e catálogo (item, preço em centavos, categoria, disponibilidade e grupos de opção com acréscimo). A FAQ continua no mesmo objeto e no mesmo `PUT` de configuração. Quem já gravava só a FAQ não precisa enviar os campos novos; a API preserva o que já estava.

O prompt trata essa base como fonte dos fatos. O modelo pode interpretar mensagem solta, perguntar o que falta e sugerir item do cardápio. Não pode inventar preço nem item. Texto do cliente, FAQ e cardápio continuam sendo dados, não instruções.

Com `orderingEnabled` e ao menos um item disponível, intenção de pedido vai para o assistente. Reserva, agendamento e orçamento seguem para uma pessoa, assim como pedido explícito de atendente e falha do modelo. A pizzaria de demonstração nasce com cardápio e pedidos ligados. A barbearia não.

O modelo recebe ferramentas: consultar e buscar o cardápio, incluir, alterar e remover linha num rascunho da conversa, definir entrega ou retirada, mostrar o resumo e confirmar. `confirm_order` só fecha o pedido se o resumo já foi apresentado e a mensagem atual do cliente é uma confirmação explícita, por exemplo `sim`. Quantidade, id e opção são validados. Preço e total são recalculados no servidor a partir do catálogo. Um preço enviado pelo modelo é ignorado.

Se o servidor recusar ferramentas, o caminho do ADR 0004 se mantém: uma chamada sem ferramentas. Em pedido, o texto é lido como JSON de ações; se não houver JSON, nomes do cardápio encontrados na mensagem entram no rascunho. Um valor em reais que não exista no cardápio nem no total oficial não é enviado ao cliente. Modelos pequenos, como `qwen2.5:1.5b`, degradam por esse caminho. Um modelo de OpenRouter usa as ferramentas com mais estabilidade. A resposta continua saindo pela fila do canal, com os limites já existentes.

O pedido fica em `draft`, `awaiting_confirmation`, `confirmed`, `sent_to_integration` ou `cancelled`. SQLite local guarda o pedido no snapshot de atendimento. O PostgreSQL de produção ganha `customer_orders` na migração `002`, no mesmo estilo das tabelas já existentes. O worker de conversa em PostgreSQL continua fora deste passo.

Na confirmação a API chama um `OrderSink`. A implementação padrão só registra o pedido e, se a empresa configurou uma URL, faz POST com HMAC SHA-256 no cabeçalho `X-Order-Signature`. Sem URL, o status fica `confirmed`. Com HTTP de sucesso, vai para `sent_to_integration`. Falha de rede deixa `confirmed` e grava o erro. iFood, Anota AI, Goomer, Saipos ou um PDV entram como outra implementação dessa interface, não como código neste momento.

O painel deixa de abrir como página institucional. A navegação é a operação: início com fila e pedidos do dia, conversas, pedidos, catálogo, base, WhatsApp e configuração da empresa.

## Consequências

Um modelo fraco pode montar o pedido certo e ainda assim escrever mal. O total exibido depois das ferramentas é o do servidor. Sem modelo nenhum, o pedido volta para a pessoa. O webhook é genérico e idempotente pelo id do pedido; um adaptador de marketplace ainda precisa traduzir o JSON para a API daquele sistema.
