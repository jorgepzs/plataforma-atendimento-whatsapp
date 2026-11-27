import { useEffect, useState, type FormEvent } from "react";
import type { AssistantMode, Session, TenantConfig } from "./api";
import { ChipEditor, HoursFields, MoneyField, Section } from "./fields";
import { useTenantConfig } from "./use-config";
import { Button, Skeleton } from "./ui";

const payments = ["Pix", "Dinheiro", "Cartão de crédito", "Cartão de débito", "Vale-refeição"];

export function SettingsView({
  tenantId,
  session,
  canEdit,
  onSessionExpired,
  onDirtyChange
}: {
  tenantId: string;
  session: Session;
  canEdit: boolean;
  onSessionExpired: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { config, setConfig, error, busy, save, dirty } = useTenantConfig(tenantId, session, onSessionExpired);
  const [keywords, setKeywords] = useState("");
  const [secret, setSecret] = useState("");
  const [fee, setFee] = useState(0);
  const [baseline, setBaseline] = useState("");

  const version = config?.version;

  useEffect(() => {
    if (!config) return;
    setKeywords(config.handoffKeywords.join(", "));
    setFee(config.profile.deliveryFeeCents);
    setSecret("");
    setBaseline(JSON.stringify({ keywords: config.handoffKeywords.join(", "), fee: config.profile.deliveryFeeCents, secret: "" }));
    // A versão salva é o único momento em que os campos locais devem ser reescritos.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  const localDirty = baseline !== "" && JSON.stringify({ keywords, fee, secret }) !== baseline;
  useEffect(() => {
    onDirtyChange(dirty || localDirty);
    return () => onDirtyChange(false);
  }, [dirty, localDirty, onDirtyChange]);

  if (!config) return error ? <div className="banner bad" role="alert">{error}</div> : <Skeleton className="card" />;
  const disabled = !canEdit || busy;
  const webhook = config.orderIntegration?.webhookUrl ?? "";
  const webhookError = webhook && !/^https:\/\/\S+$/.test(webhook) ? "Use um endereço https." : "";
  const secretError = secret && (secret.length < 8 || /\s/.test(secret)) ? "O segredo precisa ter ao menos 8 caracteres, sem espaço." : "";
  const invalid = !config.businessName.trim() || !config.greeting.trim() || Boolean(webhookError || secretError);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!config || invalid) return;
    const deliveryFeeCents = fee;
    const orderIntegration = webhook || secret
      ? {
          ...(webhook ? { webhookUrl: webhook } : {}),
          ...(secret ? { webhookSecret: secret } : {}),
          ...(config.orderIntegration?.webhookSecretConfigured ? { webhookSecretConfigured: true } : {})
        }
      : config.orderIntegration;
    const next: TenantConfig = {
      ...config,
      handoffKeywords: keywords.split(",").map((item) => item.trim()).filter(Boolean),
      profile: { ...config.profile, deliveryFeeCents },
      ...(orderIntegration ? { orderIntegration } : { orderIntegration: undefined })
    };
    const saved = await save(next);
    if (saved) setSecret("");
  }

  return (
    <form className="settings-grid" onSubmit={(event) => void submit(event)}>
      {error && <div className="banner bad" role="alert">{error}</div>}
      <Section title="Empresa">
        <div className="two">
          <label className={`field ${config.businessName.trim() ? "" : "invalid"}`}>
            <span>Nome comercial</span>
            <input disabled={disabled} required value={config.businessName} maxLength={120} onChange={(event) => setConfig({ ...config, businessName: event.target.value })} />
            {!config.businessName.trim() && <small role="alert">Informe o nome.</small>}
          </label>
          <label className="field">
            <span>Segmento</span>
            <select disabled={disabled} value={config.segment} onChange={(event) => setConfig({ ...config, segment: event.target.value as TenantConfig["segment"] })}>
              <option value="pizzaria">Pizzaria</option>
              <option value="barbearia">Barbearia</option>
              <option value="outro">Outro</option>
            </select>
          </label>
        </div>
        <label className={`field ${config.greeting.trim() ? "" : "invalid"}`}>
          <span>Saudação</span>
          <textarea rows={2} disabled={disabled} required maxLength={1000} value={config.greeting} onChange={(event) => setConfig({ ...config, greeting: event.target.value })} />
          {!config.greeting.trim() && <small role="alert">Informe a saudação.</small>}
        </label>
        <label className="field">
          <span>Motor do assistente</span>
          <select
            disabled={disabled}
            value={config.assistantMode}
            onChange={(event) => setConfig({ ...config, assistantMode: event.target.value as AssistantMode })}
          >
            <option value="approved_faq">FAQ aprovada (+ gateway LLM quando configurado)</option>
            <option value="local_ai">Classificador local (Ollama)</option>
          </select>
          <small>Travas de segurança (palavras de handoff, opt-out e fila humana) continuam ativas em todos os modos.</small>
        </label>
        <label className="field">
          <span>Objetivo do bot</span>
          <textarea
            rows={3}
            disabled={disabled}
            maxLength={1000}
            value={config.assistantObjective}
            onChange={(event) => setConfig({ ...config, assistantObjective: event.target.value })}
            placeholder="Ex.: entender a necessidade do cliente e montar o pedido; ou coletar dados para preparar um orçamento."
          />
          <small>Oriente o atendimento. O bot continuará usando os dados cadastrados, guardrails de segurança e encaminhará o que depender de avaliação humana. Até 1000 caracteres.</small>
        </label>
        <label className="check-line">
          <input type="checkbox" checked={config.orderingEnabled} disabled={disabled} onChange={(event) => setConfig({ ...config, orderingEnabled: event.target.checked })} />
          Assistente pode montar pedidos
        </label>
      </Section>

      <Section title="Entrega e pagamento">
        <div className="split-line">
          <label className="check-line">
            <input type="checkbox" checked={config.profile.deliveryEnabled} disabled={disabled} onChange={(event) => setConfig({ ...config, profile: { ...config.profile, deliveryEnabled: event.target.checked } })} />
            Entrega
          </label>
          <label className="check-line">
            <input type="checkbox" checked={config.profile.pickupEnabled} disabled={disabled} onChange={(event) => setConfig({ ...config, profile: { ...config.profile, pickupEnabled: event.target.checked } })} />
            Retirada
          </label>
        </div>
        <MoneyField id="delivery-fee" label="Taxa de entrega" cents={fee} disabled={disabled} onCents={setFee} />
        <ChipEditor
          label="Formas de pagamento"
          values={config.profile.paymentMethods}
          suggestions={payments}
          disabled={disabled}
          placeholder="Outra forma"
          onChange={(paymentMethods) => setConfig({ ...config, profile: { ...config.profile, paymentMethods } })}
        />
      </Section>
      <Section title="Horário de funcionamento">
        <HoursFields value={config.profile.hours} disabled={disabled} onChange={(hours) => setConfig({ ...config, profile: { ...config.profile, hours } })} />
      </Section>
      <Section title="Quando chamar uma pessoa">
        <label className="field">
          <span>Palavras, separadas por vírgula</span>
          <input disabled={disabled} value={keywords} onChange={(event) => setKeywords(event.target.value)} placeholder="atendente, humano" />
        </label>
      </Section>
      <Section title="Webhook de pedido">
        <label className={`field ${webhookError ? "invalid" : ""}`}>
          <span>URL</span>
          <input disabled={disabled} value={webhook} placeholder="https://" onChange={(event) => setConfig({ ...config, orderIntegration: { webhookUrl: event.target.value, webhookSecretConfigured: config.orderIntegration?.webhookSecretConfigured } })} />
          {webhookError && <small role="alert">{webhookError}</small>}
        </label>
        <label className={`field ${secretError ? "invalid" : ""}`}>
          <span>Segredo HMAC</span>
          <input type="password" autoComplete="new-password" disabled={disabled} value={secret} placeholder={config.orderIntegration?.webhookSecretConfigured ? "Segredo gravado. Preencha só para trocar." : "Mínimo de 8 caracteres"} onChange={(event) => setSecret(event.target.value)} />
          {secretError && <small role="alert">{secretError}</small>}
        </label>
      </Section>
      {canEdit && <Button type="submit" disabled={busy || invalid}>Salvar configurações</Button>}
      {!canEdit && <p className="muted">Somente a administração altera a empresa.</p>}
    </form>
  );
}
