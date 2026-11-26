import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  BookOpen,
  Bot,
  Check,
  Headset,
  LayoutDashboard,
  LogOut,
  MessageCircle,
  Plus,
  Send,
  Settings2,
  ShoppingBag,
  UtensilsCrossed,
  Wifi,
  X
} from "lucide-react";
import { WhatsAppChannelPanel, type WhatsAppChannelView } from "./WhatsAppChannelPanel";
import {
  ApiError,
  apiRequest,
  formatApiError,
  tenantPath,
  type CatalogItem,
  type CatalogOptionGroup,
  type Conversation,
  type ConversationDetail,
  type CustomerOrder,
  type Message,
  type Session,
  type Tenant,
  type TenantConfig
} from "./api";
import {
  blankItem,
  centsToInput,
  formatCents,
  inputToCents,
  isToday,
  normalizeConfig,
  orderStatusLabels,
  uniqueId
} from "./format";

type ViewId = "inicio" | "conversas" | "pedidos" | "catalogo" | "conhecimento" | "whatsapp" | "configuracoes";

const views: Array<{ id: ViewId; label: string; icon: ReactNode }> = [
  { id: "inicio", label: "Início", icon: <LayoutDashboard size={15} /> },
  { id: "conversas", label: "Conversas", icon: <Headset size={15} /> },
  { id: "pedidos", label: "Pedidos", icon: <ShoppingBag size={15} /> },
  { id: "catalogo", label: "Catálogo", icon: <UtensilsCrossed size={15} /> },
  { id: "conhecimento", label: "Base de conhecimento", icon: <BookOpen size={15} /> },
  { id: "whatsapp", label: "WhatsApp", icon: <Wifi size={15} /> },
  { id: "configuracoes", label: "Configurações", icon: <Settings2 size={15} /> }
];

const stateLabels: Record<Conversation["state"], string> = {
  BOT_ACTIVE: "Bot",
  WAITING_HUMAN: "Aguardando",
  HUMAN_ACTIVE: "Em atendimento",
  CLOSED: "Encerrada"
};

export function Workspace({
  session,
  tenants,
  activeTenantId,
  onSwitchTenant,
  onLogout,
  onSessionExpired,
  onTenantsChanged,
  storageLabel,
  channelHint
}: {
  session: Session;
  tenants: Tenant[];
  activeTenantId: string;
  onSwitchTenant: (tenantId: string) => void;
  onLogout: () => void;
  onSessionExpired: () => void;
  onTenantsChanged: () => void;
  storageLabel: string;
  channelHint: string;
}) {
  const [view, setView] = useState<ViewId>("inicio");
  const [revision, setRevision] = useState(0);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newSegment, setNewSegment] = useState<Tenant["segment"]>("outro");
  const [createError, setCreateError] = useState("");
  const tenant = tenants.find((item) => item.id === activeTenantId) ?? null;
  const membership = session.user.memberships.find((item) => item.tenantId === activeTenantId);
  const isAdmin = membership?.role === "TENANT_ADMIN" || session.user.platformAdmin;

  useEffect(() => {
    const read = () => {
      const hash = window.location.hash.replace("#", "") as ViewId;
      if (views.some((item) => item.id === hash)) setView(hash);
    };
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);

  useEffect(() => {
    if (!activeTenantId) return undefined;
    const stream = new EventSource(tenantPath(activeTenantId, "events"));
    const refresh = () => setRevision((current) => current + 1);
    stream.addEventListener("attendance.queue.changed.v1", refresh);
    stream.addEventListener("auth.expired.v1", () => {
      stream.close();
      onSessionExpired();
    });
    return () => stream.close();
  }, [activeTenantId, onSessionExpired]);

  function open(next: ViewId) {
    window.location.hash = next;
    setView(next);
  }

  async function createTenant(event: FormEvent) {
    event.preventDefault();
    setCreateError("");
    try {
      const result = await apiRequest<{ tenant: Tenant }>("/api/v1/tenants", {
        method: "POST",
        csrfToken: session.csrfToken,
        body: { displayName: newName.trim(), segment: newSegment }
      });
      setCreating(false);
      setNewName("");
      onTenantsChanged();
      onSwitchTenant(result.tenant.id);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) onSessionExpired();
      else setCreateError(formatApiError(error));
    }
  }

  const title = views.find((item) => item.id === view)?.label ?? "Início";

  return (
    <div className="ops">
      <aside className="ops-side">
        <div className="ops-brand"><span><MessageCircle size={14} /></span> atende</div>
        <label className="ops-tenant">
          <small>Empresa</small>
          <strong>{tenant?.displayName ?? "Sem empresa"}</strong>
          <select aria-label="Trocar empresa" value={activeTenantId} onChange={(event) => onSwitchTenant(event.target.value)}>
            {tenants.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}
          </select>
        </label>
        <nav className="ops-nav" aria-label="Seções">
          {views.map((item) => (
            <button key={item.id} type="button" className={view === item.id ? "active" : ""} onClick={() => open(item.id)}>
              {item.icon}{item.label}
            </button>
          ))}
        </nav>
        {session.user.platformAdmin && (
          creating ? (
            <form className="ops-form" onSubmit={(event) => void createTenant(event)}>
              <input aria-label="Nome da empresa" value={newName} onChange={(event) => setNewName(event.target.value)} required maxLength={120} placeholder="Nome da empresa" />
              <select aria-label="Segmento" value={newSegment} onChange={(event) => setNewSegment(event.target.value as Tenant["segment"])}>
                <option value="pizzaria">Pizzaria</option>
                <option value="barbearia">Barbearia</option>
                <option value="outro">Outro</option>
              </select>
              {createError && <div className="ops-alert bad">{createError}</div>}
              <div className="ops-inline">
                <button className="primary-button compact" type="submit">Criar</button>
                <button className="secondary-button compact" type="button" onClick={() => setCreating(false)}>Cancelar</button>
              </div>
            </form>
          ) : <button className="secondary-button compact" type="button" onClick={() => setCreating(true)}><Plus size={13} /> Empresa</button>
        )}
        <div className="ops-side-foot">
          <div className={`ops-status ${channelHint.includes("ban") ? "warn" : ""}`}><i />{storageLabel} · {channelHint}</div>
          <div className="ops-user">
            <div><strong>{session.user.displayName}</strong><small>{isAdmin ? "Administração" : "Atendimento"}</small></div>
            <button className="icon-button" type="button" aria-label="Sair" onClick={onLogout}><LogOut size={15} /></button>
          </div>
        </div>
      </aside>
      <div className="ops-main">
        <header className="ops-top">
          <h1>{title}</h1>
          <span className="ops-muted">{tenant?.displayName}</span>
        </header>
        <div className="ops-body">
          {tenant && view === "inicio" && <Dashboard tenantId={tenant.id} session={session} revision={revision} onOpen={open} onSessionExpired={onSessionExpired} />}
          {tenant && view === "conversas" && <Inbox tenantId={tenant.id} session={session} revision={revision} onSessionExpired={onSessionExpired} />}
          {tenant && view === "pedidos" && <Orders tenantId={tenant.id} session={session} revision={revision} onSessionExpired={onSessionExpired} />}
          {tenant && view === "catalogo" && <Catalog tenantId={tenant.id} session={session} canEdit={isAdmin} onSessionExpired={onSessionExpired} />}
          {tenant && view === "conhecimento" && <Knowledge tenantId={tenant.id} session={session} canEdit={isAdmin} onSessionExpired={onSessionExpired} />}
          {tenant && view === "whatsapp" && <WhatsAppChannelPanel tenantId={tenant.id} csrfToken={session.csrfToken} isAdmin={isAdmin} />}
          {tenant && view === "configuracoes" && <Settings tenantId={tenant.id} session={session} canEdit={isAdmin} onSessionExpired={onSessionExpired} />}
          {!tenant && <p className="ops-empty">Esta conta não tem empresa vinculada.</p>}
        </div>
      </div>
    </div>
  );
}

function Dashboard({
  tenantId, session, revision, onOpen, onSessionExpired
}: {
  tenantId: string;
  session: Session;
  revision: number;
  onOpen: (view: ViewId) => void;
  onSessionExpired: () => void;
}) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [orders, setOrders] = useState<CustomerOrder[]>([]);
  const [whatsapp, setWhatsapp] = useState<WhatsAppChannelView | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      apiRequest<{ conversations: Conversation[] }>(tenantPath(tenantId, "conversations")),
      apiRequest<{ orders: CustomerOrder[] }>(tenantPath(tenantId, "orders")),
      apiRequest<WhatsAppChannelView>(tenantPath(tenantId, "whatsapp"))
    ]).then(([queue, orderList, channel]) => {
      if (cancelled) return;
      setConversations(queue.conversations);
      setOrders(orderList.orders);
      setWhatsapp(channel);
      setError("");
    }).catch((reason: unknown) => {
      if (cancelled) return;
      if (reason instanceof ApiError && reason.status === 401) onSessionExpired();
      else setError(formatApiError(reason));
    });
    return () => { cancelled = true; };
  }, [tenantId, revision, onSessionExpired]);

  const waiting = conversations.filter((item) => item.state === "WAITING_HUMAN").length;
  const today = orders.filter((order) => isToday(order.createdAt));
  const byStatus = (status: CustomerOrder["status"]) => today.filter((order) => order.status === status).length;
  const halted = Boolean(whatsapp?.halted || whatsapp?.status === "banned" || whatsapp?.status === "restricted");
  const failedOrders = today.filter((order) => order.integrationError);

  return (
    <>
      {error && <div className="ops-alert bad">{error}</div>}
      {halted && <div className="ops-alert bad">WhatsApp com restrição{whatsapp?.haltReason ? `: ${whatsapp.haltReason}` : ""}. Não reforce o envio neste número.</div>}
      {failedOrders.length > 0 && <div className="ops-alert">{failedOrders.length} pedido(s) de hoje com falha ao enviar para o sistema externo.</div>}
      <section className="ops-grid">
        <article className="ops-card"><button className="link" type="button" onClick={() => onOpen("conversas")}><p className="ops-kicker">Fila</p><strong>{waiting}</strong><p>conversas aguardando pessoa</p></button></article>
        <article className="ops-card"><button className="link" type="button" onClick={() => onOpen("pedidos")}><p className="ops-kicker">Pedidos hoje</p><strong>{today.length}</strong><p>{byStatus("awaiting_confirmation")} aguardando confirmação · {byStatus("confirmed")} confirmados</p></button></article>
        <article className="ops-card"><p className="ops-kicker">Enviados hoje</p><strong>{byStatus("sent_to_integration")}</strong><p>{byStatus("draft")} rascunhos · {byStatus("cancelled")} cancelados</p></article>
        <article className="ops-card"><button className="link" type="button" onClick={() => onOpen("whatsapp")}><p className="ops-kicker">WhatsApp</p><strong>{whatsappLabel(whatsapp)}</strong><p>{whatsapp?.phoneMasked ?? "Sem número pareado"}</p></button></article>
      </section>
      <section className="ops-card">
        <h2>Para fazer agora</h2>
        {waiting === 0 && failedOrders.length === 0 && !halted && <p className="ops-muted">Nada pendente nesta empresa.</p>}
        {waiting > 0 && <p><button className="text-button" type="button" onClick={() => onOpen("conversas")}>{waiting} conversa(s) na fila humana</button></p>}
        {session.user.platformAdmin && <p className="ops-muted">Troca de empresa no seletor da barra lateral.</p>}
      </section>
    </>
  );
}

function whatsappLabel(view: WhatsAppChannelView | null): string {
  if (!view || view.enabled === false) return "Desligado";
  if (view.halted || view.status === "banned" || view.status === "restricted") return "Restrito";
  if (view.status === "connected") return "Conectado";
  if (view.status === "qr_pending") return "Aguardando QR";
  return view.status ?? "Sem sessão";
}

function Inbox({
  tenantId, session, revision, onSessionExpired
}: {
  tenantId: string;
  session: Session;
  revision: number;
  onSessionExpired: () => void;
}) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [error, setError] = useState("");
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [simName, setSimName] = useState("Cliente");
  const [simPhone, setSimPhone] = useState("5511999990000");
  const [simText, setSimText] = useState("");
  const owns = detail?.conversation.assignedUserId === session.user.id;

  useEffect(() => {
    let cancelled = false;
    apiRequest<{ conversations: Conversation[] }>(tenantPath(tenantId, "conversations")).then((result) => {
      if (!cancelled) setConversations(result.conversations);
    }).catch((reason: unknown) => {
      if (reason instanceof ApiError && reason.status === 401) onSessionExpired();
    });
    return () => { cancelled = true; };
  }, [tenantId, revision, onSessionExpired]);

  useEffect(() => {
    if (!selectedId) return undefined;
    let cancelled = false;
    apiRequest<ConversationDetail>(tenantPath(tenantId, `conversations/${encodeURIComponent(selectedId)}`)).then((result) => {
      if (!cancelled) setDetail(result);
    }).catch((reason: unknown) => {
      if (reason instanceof ApiError && reason.status === 401) onSessionExpired();
      else if (!cancelled) setError(formatApiError(reason));
    });
    return () => { cancelled = true; };
  }, [tenantId, selectedId, revision, onSessionExpired]);

  async function act(action: "handoff" | "claim" | "close" | "resume") {
    if (!detail) return;
    setBusy(true);
    setError("");
    try {
      await apiRequest(tenantPath(tenantId, `conversations/${encodeURIComponent(detail.conversation.id)}/${action}`), {
        method: "POST",
        csrfToken: session.csrfToken
      });
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) onSessionExpired();
      else setError(formatApiError(reason));
    } finally {
      setBusy(false);
    }
  }

  async function sendReply(event: FormEvent) {
    event.preventDefault();
    if (!detail || !reply.trim()) return;
    setBusy(true);
    setError("");
    try {
      await apiRequest(tenantPath(tenantId, `conversations/${encodeURIComponent(detail.conversation.id)}/reply`), {
        method: "POST",
        csrfToken: session.csrfToken,
        body: { text: reply.trim() }
      });
      setReply("");
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) onSessionExpired();
      else setError(formatApiError(reason));
    } finally {
      setBusy(false);
    }
  }

  async function simulate(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await apiRequest(tenantPath(tenantId, "simulate"), {
        method: "POST",
        csrfToken: session.csrfToken,
        body: { customerName: simName.trim(), customerPhone: simPhone.trim(), text: simText.trim(), clientMessageId: crypto.randomUUID() }
      });
      setSimText("");
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) onSessionExpired();
      else setError(formatApiError(reason));
    } finally {
      setBusy(false);
    }
  }

  const conversation = detail?.conversation;

  return (
    <section className="ops-split">
      <div className="ops-list">
        <header><h2>Conversas</h2><span className="ops-muted">{conversations.length}</span></header>
        {conversations.length === 0 && <p className="ops-empty">Nenhuma conversa.</p>}
        {conversations.map((item) => (
          <button key={item.id} type="button" className={`ops-row ${item.id === selectedId ? "selected" : ""}`} onClick={() => setSelectedId(item.id)}>
            <b>{item.customerName}</b>
            <span>{item.lastMessagePreview || "Sem mensagens"}</span>
            <span className={`ops-pill ${item.state === "WAITING_HUMAN" ? "wait" : ""}`}>{stateLabels[item.state]}</span>
          </button>
        ))}
        <form className="ops-form" style={{ padding: 12 }} onSubmit={(event) => void simulate(event)}>
          <p className="ops-kicker">Simular mensagem</p>
          <input aria-label="Nome" value={simName} onChange={(event) => setSimName(event.target.value)} required />
          <input aria-label="Telefone" value={simPhone} onChange={(event) => setSimPhone(event.target.value)} required />
          <textarea aria-label="Mensagem de teste" rows={2} value={simText} onChange={(event) => setSimText(event.target.value)} required />
          <button className="secondary-button compact" type="submit" disabled={busy}>Enfileirar</button>
        </form>
      </div>
      <div className="ops-thread">
        {!conversation && <p className="ops-empty">Selecione uma conversa.</p>}
        {conversation && detail && (
          <>
            <header>
              <h2>{conversation.customerName}</h2>
              <span className="ops-muted">{conversation.customerPhone}</span>
            </header>
            {error && <div className="ops-alert bad">{error}</div>}
            <div className="ops-messages">
              {detail.messages.map((message) => <Bubble key={message.id} message={message} />)}
            </div>
            <div className="ops-actions">
              {conversation.state === "BOT_ACTIVE" && <button className="secondary-button compact" type="button" disabled={busy} onClick={() => void act("handoff")}>Passar para pessoa</button>}
              {conversation.state === "WAITING_HUMAN" && <button className="primary-button compact" type="button" disabled={busy} onClick={() => void act("claim")}>Assumir</button>}
              {(conversation.state === "WAITING_HUMAN" || (conversation.state === "HUMAN_ACTIVE" && owns)) && <button className="secondary-button compact" type="button" disabled={busy} onClick={() => void act("resume")}><Bot size={13} /> Devolver ao bot</button>}
              {conversation.state === "HUMAN_ACTIVE" && owns && <button className="quiet-action compact" type="button" disabled={busy} onClick={() => void act("close")}><Check size={13} /> Encerrar</button>}
            </div>
            {conversation.state === "HUMAN_ACTIVE" && owns && (
              <form className="ops-reply" onSubmit={(event) => void sendReply(event)}>
                <textarea aria-label="Resposta" value={reply} onChange={(event) => setReply(event.target.value)} placeholder="Resposta" />
                <button className="primary-button" type="submit" disabled={busy || !reply.trim()} aria-label="Enviar"><Send size={14} /></button>
              </form>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function Bubble({ message }: { message: Message }) {
  return (
    <article className={`ops-bubble ${message.role.toLowerCase()}`}>
      <small>{message.role === "CUSTOMER" ? "Cliente" : message.role === "BOT" ? "Assistente" : message.authorName ?? "Atendente"}</small>
      {message.text}
    </article>
  );
}

function Orders({
  tenantId, session, revision, onSessionExpired
}: {
  tenantId: string;
  session: Session;
  revision: number;
  onSessionExpired: () => void;
}) {
  const [orders, setOrders] = useState<CustomerOrder[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const selected = orders.find((order) => order.id === selectedId) ?? null;

  useEffect(() => {
    let cancelled = false;
    apiRequest<{ orders: CustomerOrder[] }>(tenantPath(tenantId, "orders")).then((result) => {
      if (!cancelled) setOrders(result.orders);
    }).catch((reason: unknown) => {
      if (reason instanceof ApiError && reason.status === 401) onSessionExpired();
      else if (!cancelled) setError(formatApiError(reason));
    });
    return () => { cancelled = true; };
  }, [tenantId, revision, onSessionExpired]);

  async function setStatus(orderId: string, status: "cancelled" | "sent_to_integration") {
    setBusy(true);
    setError("");
    try {
      await apiRequest(tenantPath(tenantId, `orders/${encodeURIComponent(orderId)}/status`), {
        method: "POST",
        csrfToken: session.csrfToken,
        body: { status }
      });
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) onSessionExpired();
      else setError(formatApiError(reason));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="ops-split">
      <div className="ops-list">
        <header><h2>Pedidos</h2><span className="ops-muted">{orders.length}</span></header>
        {orders.length === 0 && <p className="ops-empty">Nenhum pedido.</p>}
        {orders.map((order) => (
          <button key={order.id} type="button" className={`ops-row ${order.id === selectedId ? "selected" : ""}`} onClick={() => setSelectedId(order.id)}>
            <b>{formatCents(order.totalCents)}</b>
            <span>{order.lines.map((line) => `${line.quantity}× ${line.name}`).join(", ") || "Sem itens"}</span>
            <span className="ops-pill">{orderStatusLabels[order.status]}</span>
          </button>
        ))}
      </div>
      <div className="ops-thread">
        {!selected && <p className="ops-empty">Selecione um pedido.</p>}
        {selected && (
          <div className="ops-body">
            {error && <div className="ops-alert bad">{error}</div>}
            <p className="ops-kicker">{orderStatusLabels[selected.status]}</p>
            <h2 style={{ margin: "4px 0 8px" }}>{formatCents(selected.totalCents)}</h2>
            <ul>
              {selected.lines.map((line) => (
                <li key={line.lineId}>{line.quantity}× {line.name}{line.choices.length ? ` (${line.choices.map((choice) => choice.name).join(", ")})` : ""} — {formatCents(line.lineTotalCents)}</li>
              ))}
            </ul>
            <p className="ops-muted">
              {selected.fulfillment?.method === "delivery" ? `Entrega${selected.fulfillment.address ? `: ${selected.fulfillment.address}` : ""}` : selected.fulfillment ? "Retirada" : "Sem entrega definida"}
              {selected.deliveryFeeCents > 0 ? ` · taxa ${formatCents(selected.deliveryFeeCents)}` : ""}
            </p>
            {selected.integrationError && <div className="ops-alert bad">Integração: {selected.integrationError}</div>}
            <div className="ops-actions">
              {selected.status === "confirmed" && <button className="primary-button compact" type="button" disabled={busy} onClick={() => void setStatus(selected.id, "sent_to_integration")}>Marcar enviado</button>}
              {selected.status !== "cancelled" && selected.status !== "sent_to_integration" && <button className="secondary-button compact" type="button" disabled={busy} onClick={() => void setStatus(selected.id, "cancelled")}><X size={13} /> Cancelar</button>}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function useConfig(tenantId: string, session: Session, onSessionExpired: () => void) {
  const [config, setConfig] = useState<TenantConfig | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiRequest<{ config: TenantConfig }>(tenantPath(tenantId, "config")).then((result) => {
      if (!cancelled) setConfig(normalizeConfig(result.config));
    }).catch((reason: unknown) => {
      if (reason instanceof ApiError && reason.status === 401) onSessionExpired();
      else if (!cancelled) setError(formatApiError(reason));
    });
    return () => { cancelled = true; };
  }, [tenantId, onSessionExpired]);

  async function save(next: TenantConfig) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await apiRequest<{ config: TenantConfig }>(tenantPath(tenantId, "config"), {
        method: "PUT",
        csrfToken: session.csrfToken,
        body: next
      });
      setConfig(normalizeConfig(result.config));
      setNotice("Salvo.");
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) onSessionExpired();
      else setError(formatApiError(reason));
    } finally {
      setBusy(false);
    }
  }

  return { config, setConfig, error, notice, busy, save };
}

function Catalog({
  tenantId, session, canEdit, onSessionExpired
}: {
  tenantId: string;
  session: Session;
  canEdit: boolean;
  onSessionExpired: () => void;
}) {
  const { config, error, notice, busy, save } = useConfig(tenantId, session, onSessionExpired);
  const [draft, setDraft] = useState<CatalogItem | null>(null);
  const [price, setPrice] = useState("0,00");

  const items = config?.catalog ?? [];

  function edit(item: CatalogItem) {
    setDraft(structuredClone(item));
    setPrice(centsToInput(item.priceCents));
  }

  function add() {
    if (!config) return;
    const item = blankItem(config.catalog);
    setDraft(item);
    setPrice("0,00");
  }

  async function remove(id: string) {
    if (!config) return;
    await save({ ...config, catalog: config.catalog.filter((item) => item.id !== id) });
    setDraft(null);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!config || !draft) return;
    const cents = inputToCents(price);
    if (cents === undefined || cents < 0) return;
    const used = new Set(config.catalog.filter((item) => item.id !== draft.id).map((item) => item.id));
    const id = used.has(draft.id) ? uniqueId(draft.name || draft.id, used) : draft.id || uniqueId(draft.name, used);
    const optionGroups = draft.optionGroups
      .map((group) => ({ ...group, choices: group.choices.filter((choice) => choice.name.trim()) }))
      .filter((group) => group.choices.length > 0)
      .map((group) => ({
        ...group,
        minSelections: group.required ? 1 : 0,
        maxSelections: Math.max(1, group.maxSelections)
      }));
    const nextItem: CatalogItem = { ...draft, id, name: draft.name.trim(), priceCents: cents, optionGroups };
    const exists = config.catalog.some((item) => item.id === draft.id);
    const catalog = exists ? config.catalog.map((item) => item.id === draft.id ? nextItem : item) : [...config.catalog, nextItem];
    await save({ ...config, catalog });
    setDraft(null);
  }

  return (
    <section className="ops-card">
      <header className="ops-inline" style={{ justifyContent: "space-between" }}>
        <h2>Cardápio</h2>
        {canEdit && <button className="secondary-button compact" type="button" onClick={add}><Plus size={13} /> Item</button>}
      </header>
      {error && <div className="ops-alert bad">{error}</div>}
      {notice && <p className="ops-muted">{notice}</p>}
      <div className="ops-items">
        {items.map((item) => (
          <div className="ops-item" key={item.id}>
            <div>
              <b>{item.name}</b>
              <div className="ops-muted">{item.category || "Sem categoria"} · {formatCents(item.priceCents)} · {item.available ? "disponível" : "indisponível"}</div>
            </div>
            {canEdit && <button className="secondary-button compact" type="button" onClick={() => edit(item)}>Editar</button>}
            {canEdit && <button className="quiet-action compact" type="button" onClick={() => void remove(item.id)} disabled={busy}>Excluir</button>}
          </div>
        ))}
        {items.length === 0 && <p className="ops-empty">Nenhum item no catálogo.</p>}
      </div>
      {draft && (
        <form className="ops-form" onSubmit={(event) => void submit(event)}>
          <div className="two">
            <input aria-label="Nome do item" value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} required maxLength={120} placeholder="Nome" />
            <input aria-label="Categoria" value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value })} maxLength={60} placeholder="Categoria" />
          </div>
          <textarea aria-label="Descrição" rows={2} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} maxLength={500} placeholder="Descrição" />
          <div className="two">
            <input aria-label="Preço" value={price} onChange={(event) => setPrice(event.target.value)} required placeholder="48,00" />
            <label className="ops-check"><input type="checkbox" checked={draft.available} onChange={(event) => setDraft({ ...draft, available: event.target.checked })} /> Disponível</label>
          </div>
          <OptionGroups item={draft} onChange={setDraft} />
          <div className="ops-inline">
            <button className="primary-button compact" type="submit" disabled={busy}>Salvar item</button>
            <button className="secondary-button compact" type="button" onClick={() => setDraft(null)}>Fechar</button>
          </div>
        </form>
      )}
    </section>
  );
}

function OptionGroups({ item, onChange }: { item: CatalogItem; onChange: (item: CatalogItem) => void }) {
  function updateGroup(index: number, group: CatalogOptionGroup) {
    onChange({ ...item, optionGroups: item.optionGroups.map((current, currentIndex) => currentIndex === index ? group : current) });
  }

  function addGroup() {
    const used = new Set(item.optionGroups.map((group) => group.id));
    onChange({
      ...item,
      optionGroups: [...item.optionGroups, {
        id: uniqueId("grupo", used),
        name: "",
        required: false,
        minSelections: 0,
        maxSelections: 1,
        choices: []
      }]
    });
  }

  return (
    <div className="ops-form">
      <div className="ops-inline"><span className="ops-kicker">Opções</span><button className="secondary-button compact" type="button" onClick={addGroup}>Grupo</button></div>
      {item.optionGroups.map((group, index) => (
        <div key={group.id} className="ops-card">
          <div className="two">
            <input aria-label={`Grupo ${index + 1}`} value={group.name} onChange={(event) => updateGroup(index, { ...group, name: event.target.value })} placeholder="Tamanho, borda..." required />
            <label className="ops-check"><input type="checkbox" checked={group.required} onChange={(event) => updateGroup(index, { ...group, required: event.target.checked, minSelections: event.target.checked ? 1 : 0 })} /> Obrigatório</label>
          </div>
          {group.choices.map((choice, choiceIndex) => (
            <div className="two" key={choice.id}>
              <input aria-label={`Opção ${choiceIndex + 1}`} value={choice.name} onChange={(event) => {
                const choices = group.choices.map((current, currentIndex) => currentIndex === choiceIndex ? { ...current, name: event.target.value } : current);
                updateGroup(index, { ...group, choices });
              }} placeholder="Nome" required />
              <input aria-label={`Preço da opção ${choiceIndex + 1}`} defaultValue={centsToInput(choice.priceCents)} onBlur={(event) => {
                const cents = inputToCents(event.target.value);
                if (cents === undefined) return;
                const choices = group.choices.map((current, currentIndex) => currentIndex === choiceIndex ? { ...current, priceCents: cents } : current);
                updateGroup(index, { ...group, choices });
              }} />
            </div>
          ))}
          <button className="secondary-button compact" type="button" onClick={() => {
            const used = new Set(group.choices.map((choice) => choice.id));
            updateGroup(index, { ...group, choices: [...group.choices, { id: uniqueId(group.name || "opcao", used), name: "", priceCents: 0 }] });
          }}>Opção</button>
        </div>
      ))}
    </div>
  );
}

function Knowledge({
  tenantId, session, canEdit, onSessionExpired
}: {
  tenantId: string;
  session: Session;
  canEdit: boolean;
  onSessionExpired: () => void;
}) {
  const { config, setConfig, error, notice, busy, save } = useConfig(tenantId, session, onSessionExpired);
  if (!config) return <p className="ops-muted">{error || "Carregando..."}</p>;
  const disabled = !canEdit || busy;

  function updateProfile<K extends keyof TenantConfig["profile"]>(key: K, value: TenantConfig["profile"][K]) {
    setConfig({ ...config!, profile: { ...config!.profile, [key]: value } });
  }

  return (
    <form className="ops-card ops-form" onSubmit={(event) => { event.preventDefault(); void save(config); }}>
      <h2>O que a empresa é</h2>
      {error && <div className="ops-alert bad">{error}</div>}
      {notice && <p className="ops-muted">{notice}</p>}
      <div className="two">
        <input aria-label="Endereço" value={config.profile.address} onChange={(event) => updateProfile("address", event.target.value)} placeholder="Endereço" disabled={disabled} />
        <input aria-label="Área de atendimento" value={config.profile.serviceArea} onChange={(event) => updateProfile("serviceArea", event.target.value)} placeholder="Área de atendimento" disabled={disabled} />
      </div>
      <input aria-label="Horário" value={config.profile.hours} onChange={(event) => updateProfile("hours", event.target.value)} placeholder="Horário" disabled={disabled} />
      <textarea aria-label="Políticas" rows={2} value={config.profile.policies} onChange={(event) => updateProfile("policies", event.target.value)} placeholder="Políticas" disabled={disabled} />
      <textarea aria-label="Tom de voz" rows={2} value={config.profile.persona} onChange={(event) => updateProfile("persona", event.target.value)} placeholder="Como o assistente deve falar" disabled={disabled} />
      <h2>Perguntas de referência</h2>
      {config.knowledge.map((item, index) => (
        <div className="two" key={`faq-${index}`}>
          <input aria-label={`Pergunta ${index + 1}`} value={item.question} disabled={disabled} required onChange={(event) => {
            const knowledge = config.knowledge.map((entry, entryIndex) => entryIndex === index ? { ...entry, question: event.target.value } : entry);
            setConfig({ ...config, knowledge });
          }} />
          <input aria-label={`Resposta ${index + 1}`} value={item.answer} disabled={disabled} required onChange={(event) => {
            const knowledge = config.knowledge.map((entry, entryIndex) => entryIndex === index ? { ...entry, answer: event.target.value } : entry);
            setConfig({ ...config, knowledge });
          }} />
        </div>
      ))}
      {canEdit && <button className="secondary-button compact" type="button" onClick={() => setConfig({ ...config, knowledge: [...config.knowledge, { question: "", answer: "" }] })}>Pergunta</button>}
      {canEdit && <button className="primary-button compact" type="submit" disabled={busy}>Salvar base</button>}
    </form>
  );
}

function Settings({
  tenantId, session, canEdit, onSessionExpired
}: {
  tenantId: string;
  session: Session;
  canEdit: boolean;
  onSessionExpired: () => void;
}) {
  const { config, setConfig, error, notice, busy, save } = useConfig(tenantId, session, onSessionExpired);
  const [keywords, setKeywords] = useState("");
  const [secret, setSecret] = useState("");
  const [fee, setFee] = useState("");
  const version = config?.version;

  useEffect(() => {
    if (!config) return;
    setKeywords(config.handoffKeywords.join(", "));
    setFee(centsToInput(config.profile.deliveryFeeCents));
    setSecret("");
    // Recarrega os campos derivados só quando a versão salva muda.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  if (!config) return <p className="ops-muted">{error || "Carregando..."}</p>;
  const current = config;
  const disabled = !canEdit || busy;

  async function submit(event: FormEvent) {
    event.preventDefault();
    const deliveryFeeCents = inputToCents(fee);
    if (deliveryFeeCents === undefined || deliveryFeeCents < 0) return;
    const webhookUrl = current.orderIntegration?.webhookUrl ?? "";
    const orderIntegration = webhookUrl || secret
      ? { ...(webhookUrl ? { webhookUrl } : {}), ...(secret ? { webhookSecret: secret } : {}) }
      : current.orderIntegration;
    await save({
      ...current,
      handoffKeywords: keywords.split(",").map((item) => item.trim()).filter(Boolean),
      profile: { ...current.profile, deliveryFeeCents },
      ...(orderIntegration ? { orderIntegration } : {})
    });
  }

  return (
    <form className="ops-card ops-form" onSubmit={(event) => void submit(event)}>
      <h2>Empresa</h2>
      {error && <div className="ops-alert bad">{error}</div>}
      {notice && <p className="ops-muted">{notice}</p>}
      <div className="two">
        <input aria-label="Nome comercial" value={current.businessName} disabled={disabled} required onChange={(event) => setConfig({ ...current, businessName: event.target.value })} />
        <select aria-label="Segmento" value={current.segment} disabled={disabled} onChange={(event) => setConfig({ ...current, segment: event.target.value as TenantConfig["segment"] })}>
          <option value="pizzaria">Pizzaria</option>
          <option value="barbearia">Barbearia</option>
          <option value="outro">Outro</option>
        </select>
      </div>
      <textarea aria-label="Saudação" rows={2} value={current.greeting} disabled={disabled} required onChange={(event) => setConfig({ ...current, greeting: event.target.value })} />
      <label className="ops-check"><input type="checkbox" checked={current.orderingEnabled} disabled={disabled} onChange={(event) => setConfig({ ...current, orderingEnabled: event.target.checked })} /> Pedidos pelo assistente</label>
      <div className="ops-inline">
        <label className="ops-check"><input type="checkbox" checked={current.profile.deliveryEnabled} disabled={disabled} onChange={(event) => setConfig({ ...current, profile: { ...current.profile, deliveryEnabled: event.target.checked } })} /> Entrega</label>
        <label className="ops-check"><input type="checkbox" checked={current.profile.pickupEnabled} disabled={disabled} onChange={(event) => setConfig({ ...current, profile: { ...current.profile, pickupEnabled: event.target.checked } })} /> Retirada</label>
      </div>
      <input aria-label="Taxa de entrega" value={fee} disabled={disabled} onChange={(event) => setFee(event.target.value)} placeholder="Taxa de entrega" />
      <input aria-label="Formas de pagamento" value={current.profile.paymentMethods.join(", ")} disabled={disabled} onChange={(event) => setConfig({ ...current, profile: { ...current.profile, paymentMethods: event.target.value.split(",").map((item) => item.trim()).filter(Boolean) } })} placeholder="Pix, cartão, dinheiro" />
      <input aria-label="Palavras para atendente" value={keywords} disabled={disabled} onChange={(event) => setKeywords(event.target.value)} placeholder="atendente, humano" />
      <h2>Webhook de pedido</h2>
      <input aria-label="URL do webhook" value={current.orderIntegration?.webhookUrl ?? ""} disabled={disabled} placeholder="https://..." onChange={(event) => setConfig({ ...current, orderIntegration: { webhookUrl: event.target.value, webhookSecretConfigured: current.orderIntegration?.webhookSecretConfigured } })} />
      <input aria-label="Segredo HMAC" type="password" value={secret} disabled={disabled} placeholder={current.orderIntegration?.webhookSecretConfigured ? "Segredo gravado — preencha só para trocar" : "Segredo HMAC"} onChange={(event) => setSecret(event.target.value)} />
      {canEdit && <button className="primary-button compact" type="submit" disabled={busy}>Salvar</button>}
    </form>
  );
}
