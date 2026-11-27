import { useState, type KeyboardEvent, type ReactNode } from "react";
import {
  centsFromTyping,
  defaultWeek,
  documentError,
  formatCents,
  formatPhoneBR,
  hoursError,
  isCompleteCep,
  isCompletePhoneBR,
  maskCep,
  maskDocument,
  maskPercent,
  maskTime,
  normalizePhoneDigits,
  parseHours,
  parsePercent,
  serializeHours,
  weekdays,
  type DaySchedule
} from "./format";
import { Field } from "./ui";

function described(id: string, error?: string): { "aria-invalid"?: boolean; "aria-describedby"?: string } {
  if (!error) return {};
  return { "aria-invalid": true, "aria-describedby": `${id}-error` };
}

export function PhoneField({
  id,
  label,
  digits,
  onDigits,
  disabled,
  required
}: {
  id: string;
  label: string;
  digits: string;
  onDigits: (digits: string) => void;
  disabled?: boolean;
  required?: boolean;
}) {
  const error = !digits && !required
    ? ""
    : !digits
      ? "Informe o telefone."
      : isCompletePhoneBR(digits)
        ? ""
        : "Use DDD e número. Ex.: +55 (11) 91234-5678.";
  return (
    <Field id={id} label={label} error={error || undefined}>
      <input
        id={id}
        inputMode="tel"
        autoComplete="tel"
        placeholder="+55 (11) 91234-5678"
        disabled={disabled}
        required={required}
        value={formatPhoneBR(digits)}
        onChange={(event) => onDigits(normalizePhoneDigits(event.target.value))}
        {...described(id, error || undefined)}
      />
    </Field>
  );
}

export function CepField({
  id,
  value,
  onValue,
  onLookup,
  disabled
}: {
  id: string;
  value: string;
  onValue: (value: string) => void;
  onLookup?: () => void;
  disabled?: boolean;
}) {
  const digits = value.replace(/\D/g, "");
  const error = digits.length > 0 && digits.length < 8 ? "CEP deve ter 8 dígitos." : "";
  return (
    <Field id={id} label="CEP" error={error || undefined} hint="Opcional. Busca o logradouro no ViaCEP.">
      <div className="inline-field">
        <input
          id={id}
          inputMode="numeric"
          autoComplete="postal-code"
          placeholder="00000-000"
          disabled={disabled}
          value={maskCep(value)}
          onChange={(event) => onValue(maskCep(event.target.value))}
          {...described(id, error || undefined)}
        />
        {onLookup && (
          <button className="btn secondary sm" type="button" disabled={disabled || !isCompleteCep(value)} onClick={onLookup}>
            Buscar
          </button>
        )}
      </div>
    </Field>
  );
}

export function MoneyField({
  id,
  label,
  cents,
  onCents,
  disabled,
  signed,
  hint
}: {
  id: string;
  label: string;
  cents: number;
  onCents: (cents: number) => void;
  disabled?: boolean;
  signed?: boolean;
  hint?: string;
}) {
  const [invalid, setInvalid] = useState(false);
  return (
    <Field id={id} label={label} hint={hint} error={invalid ? "Informe um valor em reais." : undefined}>
      <input
        id={id}
        inputMode="numeric"
        disabled={disabled}
        value={formatCents(cents)}
        onChange={(event) => {
          const next = centsFromTyping(event.target.value, signed);
          if (next === undefined) {
            setInvalid(true);
            return;
          }
          setInvalid(false);
          onCents(next);
        }}
        {...described(id, invalid ? "Informe um valor em reais." : undefined)}
      />
    </Field>
  );
}

export function TimeField({
  id,
  label,
  value,
  onValue,
  disabled
}: {
  id: string;
  label: string;
  value: string;
  onValue: (value: string) => void;
  disabled?: boolean;
}) {
  const error = value.length > 0 && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value) && value.length >= 5
    ? "Horário inválido. Use HH:MM."
    : value.length > 0 && value.length < 5
      ? "Horário incompleto."
      : "";
  return (
    <Field id={id} label={label} error={error || undefined}>
      <input
        id={id}
        inputMode="numeric"
        placeholder="18:00"
        disabled={disabled}
        value={value}
        onChange={(event) => onValue(maskTime(event.target.value))}
        {...described(id, error || undefined)}
      />
    </Field>
  );
}

export function PercentField({
  id,
  label,
  value,
  onValue,
  disabled
}: {
  id: string;
  label: string;
  value: string;
  onValue: (value: string) => void;
  disabled?: boolean;
}) {
  const parsed = value.trim() ? parsePercent(value) : undefined;
  const error = value.trim() && parsed === undefined ? "Informe um percentual de 0 a 100." : "";
  return (
    <Field id={id} label={label} error={error || undefined}>
      <input
        id={id}
        inputMode="decimal"
        disabled={disabled}
        value={value}
        placeholder="0"
        onChange={(event) => onValue(maskPercent(event.target.value))}
        {...described(id, error || undefined)}
      />
    </Field>
  );
}

export function DocumentField({
  id,
  label,
  value,
  onValue,
  disabled,
  required
}: {
  id: string;
  label: string;
  value: string;
  onValue: (value: string) => void;
  disabled?: boolean;
  required?: boolean;
}) {
  const error = !value && required ? "Informe o CPF ou CNPJ." : documentError(value);
  return (
    <Field id={id} label={label} error={error || undefined}>
      <input
        id={id}
        inputMode="numeric"
        disabled={disabled}
        value={maskDocument(value)}
        placeholder="000.000.000-00"
        onChange={(event) => onValue(event.target.value.replace(/\D/g, "").slice(0, 14))}
        {...described(id, error || undefined)}
      />
    </Field>
  );
}

export function ChipEditor({
  label,
  values,
  suggestions = [],
  onChange,
  disabled,
  placeholder
}: {
  label: string;
  values: string[];
  suggestions?: string[];
  onChange: (values: string[]) => void;
  disabled?: boolean;
  placeholder: string;
}) {
  const [draft, setDraft] = useState("");
  function add(value: string) {
    const next = value.trim();
    if (!next) return;
    if (values.some((item) => item.toLocaleLowerCase("pt-BR") === next.toLocaleLowerCase("pt-BR"))) {
      setDraft("");
      return;
    }
    onChange([...values, next].slice(0, 12));
    setDraft("");
  }
  function submitOnEnter(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    add(draft);
  }
  return (
    <div className="chips">
      <span className="field-label">{label}</span>
      <div className="chip-list">
        {suggestions.map((item) => {
          const active = values.some((value) => value.toLocaleLowerCase("pt-BR") === item.toLocaleLowerCase("pt-BR"));
          return (
            <button
              key={item}
              type="button"
              className={`chip ${active ? "on" : ""}`}
              aria-pressed={active}
              disabled={disabled}
              onClick={() => onChange(active ? values.filter((value) => value.toLocaleLowerCase("pt-BR") !== item.toLocaleLowerCase("pt-BR")) : [...values, item])}
            >
              {item}
            </button>
          );
        })}
        {values.filter((value) => !suggestions.some((item) => item.toLocaleLowerCase("pt-BR") === value.toLocaleLowerCase("pt-BR"))).map((value) => (
          <button key={value} type="button" className="chip on" disabled={disabled} onClick={() => onChange(values.filter((item) => item !== value))}>
            {value} <span aria-hidden="true">×</span>
          </button>
        ))}
      </div>
      <div className="inline-field">
        <input
          aria-label={label}
          value={draft}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={submitOnEnter}
          maxLength={40}
        />
        <button className="btn secondary sm" type="button" disabled={disabled || !draft.trim()} onClick={() => add(draft)}>
          Adicionar
        </button>
      </div>
    </div>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="section-card">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

export function HoursFields({
  value,
  disabled,
  onChange
}: {
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const parsed = parseHours(value);
  const [days, setDays] = useState<DaySchedule[] | null>(parsed.structured ? parsed.days : null);
  const error = days ? hoursError(days) : "";
  function update(next: DaySchedule[]) {
    setDays(next);
    if (!hoursError(next)) onChange(serializeHours(next));
  }
  if (!days) {
    return (
      <div className="stack">
        <label className="field">
          <span>Horário em texto</span>
          <textarea rows={2} maxLength={300} disabled={disabled} value={value} onChange={(event) => onChange(event.target.value)} />
          <small className="hint">Este texto não está na grade semanal. Você pode continuar com ele ou trocar.</small>
        </label>
        <button className="btn secondary sm" type="button" disabled={disabled} onClick={() => update(defaultWeek())}>Usar grade da semana</button>
      </div>
    );
  }
  return (
    <div className="hours">
      {days.map((day, index) => {
        const label = weekdays.find((item) => item.key === day.key)?.label ?? day.key;
        return (
          <div key={day.key} className="hour-row">
            <strong>{label}</strong>
            <label className="check-line">
              <input type="checkbox" checked={day.closed} disabled={disabled} onChange={(event) => {
                const next = days.map((item, itemIndex) => itemIndex === index ? { ...item, closed: event.target.checked } : item);
                update(next);
              }} />
              Fechado
            </label>
            <TimeField id={`open-${day.key}`} label="Abre" value={day.open} disabled={disabled || day.closed} onValue={(open) => update(days.map((item, itemIndex) => itemIndex === index ? { ...item, open } : item))} />
            <TimeField id={`close-${day.key}`} label="Fecha" value={day.close} disabled={disabled || day.closed} onValue={(close) => update(days.map((item, itemIndex) => itemIndex === index ? { ...item, close } : item))} />
          </div>
        );
      })}
      {error && <small className="field-error" role="alert">{error}</small>}
      <button className="btn quiet sm" type="button" disabled={disabled} onClick={() => { setDays(null); onChange(value); }}>Voltar para texto livre</button>
    </div>
  );
}
