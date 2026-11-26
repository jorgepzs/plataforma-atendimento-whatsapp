import { useEffect, useState, type FormEvent } from "react";
import type { Session } from "./api";
import { isCompleteCep, lookupCep } from "./format";
import { useToast } from "./feedback";
import { CepField, HoursFields, Section } from "./fields";
import { useTenantConfig } from "./use-config";
import { Button, Skeleton } from "./ui";

const tones = [
  { id: "balcao", label: "Balcão", text: "Fale como o balcão: curto, simpático e sem texto de anúncio." },
  { id: "formal", label: "Formal", text: "Fale de forma educada e direta, sem gírias." },
  { id: "leve", label: "Descontraído", text: "Fale de um jeito leve e próximo, ainda assim claro sobre preço e prazo." }
];

export function KnowledgeView({
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
  const toast = useToast();
  const { config, setConfig, error, busy, save, dirty } = useTenantConfig(tenantId, session, onSessionExpired);
  const [cep, setCep] = useState("");
  const [cepError, setCepError] = useState("");
  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);

  if (!config) {
    return error ? <div className="banner bad" role="alert">{error}</div> : <Skeleton className="card" />;
  }
  const disabled = !canEdit || busy;
  const faqError = config.knowledge.some((item) => (item.question.trim() && !item.answer.trim()) || (!item.question.trim() && item.answer.trim()));
  const invalid = faqError || config.profile.address.length > 200 || config.profile.persona.length > 1000;

  async function fillCep() {
    setCepError("");
    const result = await lookupCep(cep);
    if (!result.ok) {
      setCepError(result.error);
      return;
    }
    setConfig({ ...config!, profile: { ...config!.profile, address: result.address.slice(0, 200) } });
    toast("Endereço preenchido pelo CEP.");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (invalid) return;
    const knowledge = config!.knowledge.map((item) => ({ question: item.question.trim(), answer: item.answer.trim() })).filter((item) => item.question && item.answer);
    await save({ ...config!, knowledge });
  }

  return (
    <form className="settings-grid" onSubmit={(event) => void submit(event)}>
      {error && <div className="banner bad" role="alert">{error}</div>}
      <Section title="Endereço e área">
        <CepField id="cep" value={cep} onValue={setCep} disabled={disabled} onLookup={() => void fillCep()} />
        {cepError && <small className="field-error" role="alert">{cepError}</small>}
        <label className="field">
          <span>Endereço</span>
          <input maxLength={200} disabled={disabled} value={config.profile.address} onChange={(event) => setConfig({ ...config, profile: { ...config.profile, address: event.target.value } })} />
        </label>
        <label className="field">
          <span>Área de atendimento</span>
          <input maxLength={200} disabled={disabled} value={config.profile.serviceArea} onChange={(event) => setConfig({ ...config, profile: { ...config.profile, serviceArea: event.target.value } })} />
        </label>
      </Section>
      <Section title="Horário da semana">
        <HoursFields value={config.profile.hours} disabled={disabled} onChange={(hours) => setConfig({ ...config, profile: { ...config.profile, hours } })} />
      </Section>
      <Section title="Tom de voz">
        <div className="chip-list">
          {tones.map((tone) => (
            <button key={tone.id} type="button" className={`chip ${config.profile.persona === tone.text ? "on" : ""}`} disabled={disabled} onClick={() => setConfig({ ...config, profile: { ...config.profile, persona: tone.text } })}>
              {tone.label}
            </button>
          ))}
        </div>
        <label className="field">
          <span>Como o assistente fala</span>
          <textarea rows={3} maxLength={1000} disabled={disabled} value={config.profile.persona} onChange={(event) => setConfig({ ...config, profile: { ...config.profile, persona: event.target.value } })} />
        </label>
        <label className="field">
          <span>Políticas</span>
          <textarea rows={3} maxLength={1000} disabled={disabled} value={config.profile.policies} onChange={(event) => setConfig({ ...config, profile: { ...config.profile, policies: event.target.value } })} />
        </label>
      </Section>
      <Section title="Perguntas de referência">
        {config.knowledge.map((item, index) => (
          <div className="faq-row" key={`faq-${index}`}>
            <label className="field">
              <span>Pergunta {index + 1}</span>
              <input disabled={disabled} value={item.question} maxLength={300} onChange={(event) => {
                const knowledge = config.knowledge.map((entry, entryIndex) => entryIndex === index ? { ...entry, question: event.target.value } : entry);
                setConfig({ ...config, knowledge });
              }} />
            </label>
            <label className="field">
              <span>Resposta</span>
              <textarea rows={2} disabled={disabled} value={item.answer} maxLength={1000} onChange={(event) => {
                const knowledge = config.knowledge.map((entry, entryIndex) => entryIndex === index ? { ...entry, answer: event.target.value } : entry);
                setConfig({ ...config, knowledge });
              }} />
            </label>
            {canEdit && <Button type="button" variant="quiet" size="sm" onClick={() => setConfig({ ...config, knowledge: config.knowledge.filter((_, entryIndex) => entryIndex !== index) })}>Remover</Button>}
          </div>
        ))}
        {faqError && <small className="field-error" role="alert">Preencha a pergunta e a resposta, ou remova a linha.</small>}
        {canEdit && <Button type="button" variant="secondary" size="sm" onClick={() => setConfig({ ...config, knowledge: [...config.knowledge, { question: "", answer: "" }] })}>Pergunta</Button>}
      </Section>
      {canEdit && <Button type="submit" disabled={busy || invalid || (cep.length > 0 && !isCompleteCep(cep))}>Salvar base</Button>}
      {!canEdit && <p className="muted">Somente a administração altera a base.</p>}
    </form>
  );
}
