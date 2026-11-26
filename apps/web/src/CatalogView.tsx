import { useEffect, useMemo, useState, type FormEvent } from "react";
import { ImageOff, Plus, Search, Trash2, UtensilsCrossed } from "lucide-react";
import { type CatalogChoice, type CatalogItem, type CatalogOptionGroup, type Session } from "./api";
import { avatarColor, blankItem, centsFromTyping, formatCents, initials, uniqueId } from "./format";
import { useToast } from "./feedback";
import { MoneyField } from "./fields";
import { useTenantConfig } from "./use-config";
import { Badge, Button, ConfirmDialog, Drawer, EmptyState, Skeleton, Switch } from "./ui";

export function CatalogView({
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
  const { config, error, busy, save } = useTenantConfig(tenantId, session, onSessionExpired);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("todas");
  const [layout, setLayout] = useState<"grade" | "tabela">("grade");
  const [draft, setDraft] = useState<CatalogItem | null>(null);
  const [removeId, setRemoveId] = useState("");
  const items = config?.catalog ?? [];
  const categories = useMemo(() => ["todas", ...new Set(items.map((item) => item.category || "Sem categoria"))], [items]);
  const visible = items.filter((item) => {
    if (category !== "todas" && (item.category || "Sem categoria") !== category) return false;
    const needle = query.trim().toLocaleLowerCase("pt-BR");
    if (!needle) return true;
    return `${item.name} ${item.category} ${item.description}`.toLocaleLowerCase("pt-BR").includes(needle);
  });

  useEffect(() => {
    onDirtyChange(draft !== null);
    return () => onDirtyChange(false);
  }, [draft, onDirtyChange]);

  async function toggle(item: CatalogItem) {
    if (!config) return;
    const catalog = config.catalog.map((current) => current.id === item.id ? { ...current, available: !current.available } : current);
    const saved = await save({ ...config, catalog });
    if (saved) toast(item.available ? `${item.name} indisponível.` : `${item.name} disponível.`);
  }

  async function remove(id: string) {
    if (!config) return;
    const saved = await save({ ...config, catalog: config.catalog.filter((item) => item.id !== id) });
    if (saved) {
      setRemoveId("");
      setDraft(null);
    }
  }

  return (
    <div className="stack">
      <div className="toolbar">
        <label className="search">
          <Search size={15} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar item" aria-label="Buscar no catálogo" />
        </label>
        <select aria-label="Categoria" value={category} onChange={(event) => setCategory(event.target.value)}>
          {categories.map((item) => <option key={item} value={item}>{item === "todas" ? "Todas as categorias" : item}</option>)}
        </select>
        <div className="tabs" role="tablist" aria-label="Visualização">
          <button type="button" role="tab" aria-selected={layout === "grade"} className={layout === "grade" ? "active" : ""} onClick={() => setLayout("grade")}>Grade</button>
          <button type="button" role="tab" aria-selected={layout === "tabela"} className={layout === "tabela" ? "active" : ""} onClick={() => setLayout("tabela")}>Tabela</button>
        </div>
        {canEdit && <Button onClick={() => config && setDraft(blankItem(config.catalog))}><Plus size={14} /> Item</Button>}
      </div>
      {error && <div className="banner bad" role="alert">{error}</div>}
      {!config && !error && <div className="catalog-grid">{Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="card" />)}</div>}
      {config && visible.length === 0 && (
        <EmptyState icon={<UtensilsCrossed size={18} />} title="Nenhum item" body="Cadastre o que o assistente pode oferecer." action={canEdit ? <Button onClick={() => setDraft(blankItem(config.catalog))}>Novo item</Button> : undefined} />
      )}
      {layout === "grade" && visible.length > 0 && (
        <div className="catalog-grid">
          {visible.map((item) => (
            <article key={item.id} className="catalog-card">
              <div className="photo" style={{ background: avatarColor(item.name) }}>
                <ImageOff size={16} />
                <span>{initials(item.name)}</span>
              </div>
              <div>
                <strong>{item.name}</strong>
                <p>{item.category || "Sem categoria"}</p>
                <b>{formatCents(item.priceCents)}</b>
              </div>
              <div className="card-actions">
                <Switch checked={item.available} disabled={!canEdit || busy} label={item.available ? `${item.name} disponível` : `${item.name} indisponível`} onChange={() => void toggle(item)} />
                {canEdit && <Button variant="secondary" size="sm" onClick={() => setDraft(structuredClone(item))}>Editar</Button>}
              </div>
            </article>
          ))}
        </div>
      )}
      {layout === "tabela" && visible.length > 0 && (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr><th>Item</th><th>Categoria</th><th>Preço</th><th>Disponível</th>{canEdit && <th />}</tr>
            </thead>
            <tbody>
              {visible.map((item) => (
                <tr key={item.id}>
                  <td>{item.name}</td>
                  <td>{item.category || "—"}</td>
                  <td>{formatCents(item.priceCents)}</td>
                  <td><Switch checked={item.available} disabled={!canEdit || busy} label={item.name} onChange={() => void toggle(item)} /></td>
                  {canEdit && <td><Button variant="quiet" size="sm" onClick={() => setDraft(structuredClone(item))}>Editar</Button></td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {draft && (
        <ItemDrawer
          key={draft.id}
          item={draft}
          busy={busy}
          canDelete={config?.catalog.some((item) => item.id === draft.id) ?? false}
          onClose={() => setDraft(null)}
          onDelete={() => setRemoveId(draft.id)}
          onSubmit={async (next) => {
            if (!config) return;
            const exists = config.catalog.some((item) => item.id === draft.id);
            const catalog = exists ? config.catalog.map((item) => item.id === draft.id ? next : item) : [...config.catalog, next];
            const saved = await save({ ...config, catalog });
            if (saved) setDraft(null);
          }}
        />
      )}
      <ConfirmDialog
        open={Boolean(removeId)}
        title="Excluir item"
        body="O item sai do catálogo usado pelo assistente."
        confirmLabel="Excluir"
        danger
        busy={busy}
        onClose={() => setRemoveId("")}
        onConfirm={() => void remove(removeId)}
      />
    </div>
  );
}

function ItemDrawer({
  item,
  busy,
  canDelete,
  onClose,
  onDelete,
  onSubmit
}: {
  item: CatalogItem;
  busy: boolean;
  canDelete: boolean;
  onClose: () => void;
  onDelete: () => void;
  onSubmit: (item: CatalogItem) => Promise<void>;
}) {
  const [draft, setDraft] = useState(item);
  const [price, setPrice] = useState(item.priceCents);
  const nameError = draft.name.trim() ? "" : "Informe o nome.";
  const invalid = Boolean(nameError) || draft.optionGroups.some((group) => {
    const blank = !group.name.trim() && group.choices.every((choice) => !choice.name.trim());
    if (blank) return false;
    return !group.name.trim() || group.choices.some((choice) => !choice.name.trim());
  });

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (invalid) return;
    const optionGroups = draft.optionGroups
      .map((group) => ({
        ...group,
        name: group.name.trim(),
        minSelections: group.required ? 1 : 0,
        maxSelections: Math.max(1, group.maxSelections),
        choices: group.choices.filter((choice) => choice.name.trim()).map((choice) => ({ ...choice, name: choice.name.trim() }))
      }))
      .filter((group) => group.choices.length > 0);
    await onSubmit({ ...draft, name: draft.name.trim(), category: draft.category.trim(), description: draft.description.trim(), priceCents: price, optionGroups });
  }

  return (
    <Drawer open title={canDelete ? "Editar item" : "Novo item"} onClose={onClose}>
      <form className="stack" onSubmit={(event) => void submit(event)}>
        <div className="photo lg" style={{ background: avatarColor(draft.name || "item") }}>
          <ImageOff size={18} />
          <span>Sem foto</span>
        </div>
        <label className={`field ${nameError ? "invalid" : ""}`}>
          <span>Nome</span>
          <input value={draft.name} maxLength={120} onChange={(event) => setDraft({ ...draft, name: event.target.value })} aria-invalid={Boolean(nameError)} />
          {nameError && <small role="alert">{nameError}</small>}
        </label>
        <label className="field">
          <span>Categoria</span>
          <input value={draft.category} maxLength={60} onChange={(event) => setDraft({ ...draft, category: event.target.value })} />
        </label>
        <label className="field">
          <span>Descrição</span>
          <textarea rows={3} maxLength={500} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} />
        </label>
        <MoneyField id="item-price" label="Preço" cents={price} onCents={setPrice} />
        <label className="check-line">
          <input type="checkbox" checked={draft.available} onChange={(event) => setDraft({ ...draft, available: event.target.checked })} />
          Disponível para venda
        </label>
        <OptionEditor item={draft} onChange={setDraft} />
        <div className="dialog-actions">
          <Button type="submit" disabled={busy || invalid}>Salvar item</Button>
          {canDelete && <Button type="button" variant="danger" disabled={busy} onClick={onDelete}><Trash2 size={14} /> Excluir</Button>}
        </div>
      </form>
    </Drawer>
  );
}

function OptionEditor({ item, onChange }: { item: CatalogItem; onChange: (item: CatalogItem) => void }) {
  function updateGroup(index: number, group: CatalogOptionGroup) {
    onChange({ ...item, optionGroups: item.optionGroups.map((current, currentIndex) => currentIndex === index ? group : current) });
  }
  return (
    <div className="stack">
      <div className="split-line">
        <h3>Opções e adicionais</h3>
        <Button type="button" variant="secondary" size="sm" onClick={() => {
          const used = new Set(item.optionGroups.map((group) => group.id));
          onChange({
            ...item,
            optionGroups: [...item.optionGroups, { id: uniqueId("grupo", used), name: "", required: false, minSelections: 0, maxSelections: 1, choices: [] }]
          });
        }}>Grupo</Button>
      </div>
      {item.optionGroups.map((group, index) => (
        <div key={group.id} className="option-card">
          <div className="split-line">
            <label className="field">
              <span>Grupo</span>
              <input aria-label={`Grupo ${index + 1}`} value={group.name} placeholder="Tamanho, borda, adicional" onChange={(event) => updateGroup(index, { ...group, name: event.target.value })} />
            </label>
            <Button type="button" variant="quiet" size="sm" onClick={() => onChange({ ...item, optionGroups: item.optionGroups.filter((current) => current.id !== group.id) })}>Remover grupo</Button>
          </div>
          <div className="split-line">
            <label className="check-line">
              <input type="checkbox" checked={group.required} onChange={(event) => updateGroup(index, { ...group, required: event.target.checked, minSelections: event.target.checked ? 1 : 0 })} />
              Obrigatório
            </label>
            <label className="field compact">
              <span>Máximo</span>
              <input aria-label={`Máximo do grupo ${index + 1}`} type="number" min={1} max={10} value={group.maxSelections} onChange={(event) => updateGroup(index, { ...group, maxSelections: Math.min(10, Math.max(1, Number(event.target.value) || 1)) })} />
            </label>
          </div>
          {group.choices.map((choice, choiceIndex) => (
            <ChoiceRow key={choice.id} choice={choice} index={choiceIndex} onChange={(next) => {
              const choices = group.choices.map((current, currentIndex) => currentIndex === choiceIndex ? next : current);
              updateGroup(index, { ...group, choices });
            }} onRemove={() => updateGroup(index, { ...group, choices: group.choices.filter((current) => current.id !== choice.id) })} />
          ))}
          <Button type="button" variant="quiet" size="sm" onClick={() => {
            const used = new Set(group.choices.map((choice) => choice.id));
            updateGroup(index, { ...group, choices: [...group.choices, { id: uniqueId(group.name || "opcao", used), name: "", priceCents: 0 }] });
          }}>Adicional</Button>
          {group.choices.length === 0 && <Badge tone="wait">Inclua ao menos uma opção</Badge>}
        </div>
      ))}
    </div>
  );
}

function ChoiceRow({ choice, index, onChange, onRemove }: { choice: CatalogChoice; index: number; onChange: (choice: CatalogChoice) => void; onRemove: () => void }) {
  return (
    <div className="choice-row">
      <input aria-label={`Opção ${index + 1}`} value={choice.name} placeholder="Nome" onChange={(event) => onChange({ ...choice, name: event.target.value })} />
      <input
        aria-label={`Preço da opção ${index + 1}`}
        inputMode="numeric"
        value={formatCents(choice.priceCents)}
        onChange={(event) => {
          const cents = centsFromTyping(event.target.value, true);
          if (cents === undefined) return;
          onChange({ ...choice, priceCents: cents });
        }}
      />
      <Button type="button" variant="quiet" size="sm" aria-label={`Remover opção ${index + 1}`} onClick={onRemove}>×</Button>
    </div>
  );
}
