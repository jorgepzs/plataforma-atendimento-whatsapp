# ADR 0005: Canal WhatsApp com provedor substituível

- Status: aceito
- Data: 2026-11-26

## Contexto

A plataforma precisa atender de verdade antes de existir CNPJ. A API oficial da Meta fica para quando a empresa (ME) for aberta. Até lá, a rota escolhida é o pareamento por QR do protocolo WhatsApp Web, com o risco de banimento aceito pelo responsável. O webhook e o adaptador de texto da Cloud API já existiam e não podem ser apagados: a migração tem de ser troca de configuração.

Foram consideradas três implementações:

- **Baileys** (`@whiskeysockets/baileys` 6.7.24), biblioteca Node mantida pelo WhiskeySockets, licença MIT. Fala o protocolo multidevice no mesmo processo da API. A sessão (`useMultiFileAuthState`) vai para disco e sobrevive a restart. Expõe QR, presença, recibo de leitura e o código de desconexão (logout, banimento, sessão substituída).
- **Evolution API**, gateway separado. O código segue Apache-2.0, com condições extras de marca no `LICENSE` do repositório, e desde a 2.4.0 a instância precisa ser ativada no servidor da Evolution Foundation antes de servir tráfego. Exige outro serviço, outro banco e uma dependência operacional que este processo Node não tem.
- **WPPConnect**, também Apache-2.0, mas automatiza o WhatsApp Web num navegador. Pede Chromium, pesa mais e é mais fácil de distinguir de um cliente comum.

## Decisão

Adotar Baileys como provedor `unofficial_qr`, dentro da API, sem contêiner extra. A Evolution API fica de fora pela ativação externa, pela licença com condições de marca e por não caber na stack atual. O WPPConnect fica de fora pelo navegador e pelo risco maior de detecção.

`WhatsAppProvider` é a única porta usada pelo restante do sistema. `meta_cloud` reutiliza `CloudApiTextSender` para texto e deixa mídia, presença e recibo como esqueleto explícito. Cada empresa escolhe o provedor. A política anti-ban (fila, jitter, tetos, aquecimento, opt-out, horário silencioso, uma sessão por número) fica na frente dos dois transportes, com tetos que o código não deixa afrouxar além do limite.

O canal só sobe com `WHATSAPP_CHANNEL_ENABLED=true` e SQLite. Sem isso, o comportamento anterior permanece.

## Consequências

A sessão QR é um segredo no volume `WHATSAPP_SESSION_DIR`. Dois processos no mesmo diretório são recusados pelo lock. Banimento interrompe o envio daquela empresa e pode chamar um webhook, sem incluir o texto da conversa. A rota viola os termos do WhatsApp; o número deve ser dedicado. Quando a Meta estiver disponível, a migração é `provider=meta_cloud` mais as credenciais, e o logout da sessão QR.
