import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { AlertCircle, Bot, Check, CheckCheck, Clock, Headset, Search, Send, UserRound } from "lucide-react";
import {
  ApiError,
  apiRequest,
  formatApiError,
  tenantPath,
  type ContactConsent,
  type Conversation,
  type ConversationDetail,
  type ConversationState,
  type CustomerOrder,
  type Message,
  type Session
} from "./api";
import {
  avatarColor,
  deliveryTick,
  formatClock,
  formatDayLabel,
  formatListTime,
  formatPhoneBR,
  initials,
  isCompletePhoneBR,
  phoneForApi
} from "./format";
import { useToast } from "./feedback";
import { PhoneField } from "./fields";
import { Badge, Button, EmptyState, Skeleton } from "./ui";

const filters: Array<{ id: "ALL" | ConversationState; label: string }> = [
  { id: "ALL", label: "Todas" },
  { id: "BOT_ACTIVE", label: "Bot" },
  { id: "WAITING_HUMAN", label: "Aguardando" },
  { id: "HUMAN_ACTIVE", label: "Em atendimento" },
  { id: "CLOSED", label: "Encerradas" }
];

const stateLabels: Record<ConversationState, string> = {
  BOT_ACTIVE: "Bot",
  WAITING_HUMAN: "Aguardando humano",
  HUMAN_ACTIVE: "Em atendimento",
  CLOSED: "Encerrada"
};

const tones: Record<ConversationState, "info" | "wait" | "ok" | "neutral"> = {
  BOT_ACTIVE: "info",
  WAITING_HUMAN: "wait",
  HUMAN_ACTIVE: "ok",
  CLOSED: "neutral"
};

const defaultReplies = [
  "Olá! Já estou vendo sua mensagem.",
  "Pode confirmar o endereço de entrega?",
  "Seu pedido foi confirmado. Obrigado!",
  "Um momento, por favor."
];

export function InboxView({
  tenantId,
  session,
  revision,
  onSessionExpired
}: {
  tenantId: string;
  session: Session;
  revision: number;
  onSessionExpired: () => void;
}) {
  const toast = useToast();
  const [conversations, setConversations] = useState<Conversation[] | null>(null);
  const [filter, setFilter] = useState<(typeof filters)[number]["id"]>("ALL");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [error, setError] = useState("");
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [contactOpen, setContactOpen] = useState(false);
  const [orders, setOrders] = useState<CustomerOrder[]>([]);
  const [consent, setConsent] = useState<ContactConsent | null>(null);
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [replies, setReplies] = useState<string[]>(defaultReplies);
  const [customReply, setCustomReply] = useState("");
  const [simulateOpen, setSimulateOpen] = useState(false);
  const [simName, setSimName] = useState("Cliente");
  const [simPhone, setSimPhone] = useState("11999990000");
  const [simText, setSimText] = useState("");
  const seen = useRef<Record<string, string>>({});
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const openedId = useRef("");

  useEffect(() => {
    try {
      const stored = localStorage.getItem(`atende:replies:${tenantId}`);
      if (stored) {
        const parsed = JSON.parse(stored) as unknown;
        if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) setReplies(parsed);
      }
    } catch {
      setReplies(defaultReplies);
    }
  }, [tenantId]);

  useEffect(() => {
    let cancelled = false;
    apiRequest<{ conversations: Conversation[] }>(tenantPath(tenantId, "conversations")).then((result) => {
      if (cancelled) return;
      setConversations(result.conversations);
      setUnread((current) => {
        const next = { ...current };
        for (const item of result.conversations) {
          const stamp = `${item.updatedAt}|${item.lastMessagePreview}`;
          const previous = seen.current[item.id];
          if (previous && previous !== stamp && item.id !== selectedId) next[item.id] = (next[item.id] ?? 0) + 1;
          if (item.id === selectedId) next[item.id] = 0;
          seen.current[item.id] = stamp;
        }
        return next;
      });
    }).catch((reason: unknown) => {
      if (reason instanceof ApiError && reason.status === 401) onSessionExpired();
    });
    return () => { cancelled = true; };
  }, [tenantId, revision, selectedId, onSessionExpired]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return undefined;
    }
    let cancelled = false;
    apiRequest<ConversationDetail>(tenantPath(tenantId, `conversations/${encodeURIComponent(selectedId)}`)).then((result) => {
      if (!cancelled) setDetail(result);
    }).catch((reason: unknown) => {
      if (reason instanceof ApiError && reason.status === 401) onSessionExpired();
      else if (!cancelled) setError(formatApiError(reason));
    });
    apiRequest<{ orders: CustomerOrder[] }>(tenantPath(tenantId, "orders")).then((result) => {
      if (!cancelled) setOrders(result.orders);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [tenantId, selectedId, revision, onSessionExpired]);

  useEffect(() => {
    const phone = detail?.conversation.customerPhone ?? "";
    const digits = phone.replace(/\D/g, "");
    if (!/^[1-9]\d{7,14}$/.test(digits)) {
      setConsent(null);
      return undefined;
    }
    let cancelled = false;
    apiRequest<ContactConsent>(tenantPath(tenantId, `whatsapp/contacts/${digits}`)).then((result) => {
      if (!cancelled) setConsent(result);
    }).catch(() => {
      if (!cancelled) setConsent(null);
    });
    return () => { cancelled = true; };
  }, [tenantId, detail?.conversation.customerPhone, revision]);

  useEffect(() => {
    const element = scroller.current;
    if (!element || !detail) return;
    if (openedId.current !== detail.conversation.id) {
      openedId.current = detail.conversation.id;
      stick.current = true;
    }
    if (stick.current) element.scrollTop = element.scrollHeight;
  }, [detail]);

  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("pt-BR");
    return (conversations ?? []).filter((item) => {
      if (filter !== "ALL" && item.state !== filter) return false;
      if (!needle) return true;
      return `${item.customerName} ${item.customerPhone} ${item.lastMessagePreview}`.toLocaleLowerCase("pt-BR").includes(needle);
    });
  }, [conversations, filter, query]);

  function select(id: string) {
    setSelectedId(id);
    setUnread((current) => ({ ...current, [id]: 0 }));
    setError("");
  }

  async function act(action: "handoff" | "claim" | "close" | "resume") {
    if (!detail) return;
    setBusy(true);
    setError("");
    try {
      await apiRequest(tenantPath(tenantId, `conversations/${encodeURIComponent(detail.conversation.id)}/${action}`), {
        method: "POST",
        csrfToken: session.csrfToken
      });
      toast(action === "claim" ? "Conversa assumida." : action === "resume" ? "Conversa devolvida ao bot." : action === "close" ? "Conversa encerrada." : "Conversa na fila humana.");
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) onSessionExpired();
      else {
        const message = formatApiError(reason);
        setError(message);
        toast(message, "err");
      }
    } finally {
      setBusy(false);
    }
  }

  async function sendReply() {
    if (!detail || !reply.trim() || busy) return;
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
      else {
        const message = formatApiError(reason);
        setError(message);
        toast(message, "err");
      }
    } finally {
      setBusy(false);
    }
  }

  function onComposerKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendReply();
    }
  }

  async function retry(messageId: string) {
    if (!detail) return;
    setBusy(true);
    try {
      await apiRequest(tenantPath(tenantId, `conversations/${encodeURIComponent(detail.conversation.id)}/messages/${encodeURIComponent(messageId)}/retry`), {
        method: "POST",
        csrfToken: session.csrfToken
      });
      toast("Reenvio pedido.");
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) onSessionExpired();
      else toast(formatApiError(reason), "err");
    } finally {
      setBusy(false);
    }
  }

  async function simulate(event: FormEvent) {
    event.preventDefault();
    if (!isCompletePhoneBR(simPhone)) return;
    setBusy(true);
    setError("");
    try {
      await apiRequest(tenantPath(tenantId, "simulate"), {
        method: "POST",
        csrfToken: session.csrfToken,
        body: {
          customerName: simName.trim(),
          customerPhone: phoneForApi(simPhone),
          text: simText.trim(),
          clientMessageId: crypto.randomUUID()
        }
      });
      setSimText("");
      toast("Mensagem enfileirada.");
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) onSessionExpired();
      else toast(formatApiError(reason), "err");
    } finally {
      setBusy(false);
    }
  }

  function storeReplies(next: string[]) {
    setReplies(next);
    try {
      localStorage.setItem(`atende:replies:${tenantId}`, JSON.stringify(next));
    } catch {
      // As respostas continuam nesta sessão.
    }
  }

  const conversation = detail?.conversation;
  const owns = conversation?.assignedUserId === session.user.id;
  const contactOrders = orders.filter((order) => order.conversationId === conversation?.id);
  const phoneLabel = conversation ? presentPhone(conversation.customerPhone) : "";

  return (
    <section className={`inbox ${selectedId ? "has-thread" : ""} ${contactOpen ? "has-contact" : ""}`}>
      <div className="inbox-list">
        <div className="inbox-tools">
          <label className="search">
            <Search size={15} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar nome, telefone ou mensagem" aria-label="Buscar conversas" />
          </label>
          <div className="tabs" role="tablist" aria-label="Filtrar por status">
            {filters.map((item) => {
              const count = item.id === "ALL" ? conversations?.length ?? 0 : (conversations ?? []).filter((conversationItem) => conversationItem.state === item.id).length;
              return (
                <button key={item.id} type="button" role="tab" aria-selected={filter === item.id} className={filter === item.id ? "active" : ""} onClick={() => setFilter(item.id)}>
                  {item.label}<em>{count}</em>
                </button>
              );
            })}
          </div>
        </div>
        <div className="inbox-rows">
          {conversations === null && <ListSkeleton />}
          {conversations !== null && visible.length === 0 && (
            <EmptyState icon={<Headset size={18} />} title="Nenhuma conversa" body={query || filter !== "ALL" ? "Nada encontrado com esse filtro." : "Quando um cliente escrever, a conversa aparece aqui."} />
          )}
          {visible.map((item) => (
            <button key={item.id} type="button" className={`conv ${item.id === selectedId ? "selected" : ""}`} onClick={() => select(item.id)}>
              <span className="avatar" style={{ background: avatarColor(item.customerName) }}>{initials(item.customerName)}</span>
              <span className="conv-copy">
                <span className="conv-top">
                  <strong>{item.customerName}</strong>
                  <time>{formatListTime(item.updatedAt)}</time>
                </span>
                <span className="preview">{item.lastMessagePreview || "Sem mensagens"}</span>
                <Badge tone={tones[item.state]}>{stateLabels[item.state]}</Badge>
              </span>
              {(unread[item.id] ?? 0) > 0 && <span className="unread">{unread[item.id]}</span>}
            </button>
          ))}
        </div>
        <div className="simulate">
          <button type="button" className="text-link" onClick={() => setSimulateOpen((open) => !open)}>{simulateOpen ? "Fechar simulação" : "Simular cliente"}</button>
          {simulateOpen && (
            <form onSubmit={(event) => void simulate(event)}>
              <label className="field"><span>Nome</span><input value={simName} onChange={(event) => setSimName(event.target.value)} required maxLength={120} /></label>
              <PhoneField id="sim-phone" label="Telefone" digits={simPhone} onDigits={setSimPhone} required />
              <label className="field"><span>Mensagem</span><textarea rows={2} value={simText} onChange={(event) => setSimText(event.target.value)} required maxLength={4000} /></label>
              <Button variant="secondary" size="sm" type="submit" disabled={busy || !isCompletePhoneBR(simPhone) || !simText.trim()}>Enfileirar</Button>
            </form>
          )}
        </div>
      </div>
      <div className="inbox-thread">
        {!conversation && (
          <EmptyState icon={<Headset size={18} />} title="Selecione uma conversa" body="A fila fica à esquerda. Assumir e devolver ao bot aparecem no topo da conversa." />
        )}
        {conversation && detail && (
          <>
            <header className="thread-head">
              <button type="button" className="back-link" onClick={() => setSelectedId("")}>Conversas</button>
              <span className="avatar" style={{ background: avatarColor(conversation.customerName) }}>{initials(conversation.customerName)}</span>
              <div>
                <strong>{conversation.customerName}</strong>
                <span>{phoneLabel}</span>
              </div>
              <Badge tone={tones[conversation.state]}>{stateLabels[conversation.state]}</Badge>
              <div className="thread-actions">
                {conversation.state === "BOT_ACTIVE" && <Button variant="secondary" size="sm" disabled={busy} onClick={() => void act("handoff")}>Passar para pessoa</Button>}
                {conversation.state === "WAITING_HUMAN" && <Button size="sm" disabled={busy} onClick={() => void act("claim")}>Assumir</Button>}
                {(conversation.state === "WAITING_HUMAN" || (conversation.state === "HUMAN_ACTIVE" && owns)) && (
                  <Button variant="secondary" size="sm" disabled={busy} onClick={() => void act("resume")}><Bot size={14} /> Devolver ao bot</Button>
                )}
                {conversation.state === "HUMAN_ACTIVE" && owns && (
                  <Button variant="quiet" size="sm" disabled={busy} onClick={() => void act("close")}><Check size={14} /> Encerrar</Button>
                )}
                <Button variant="quiet" size="sm" aria-pressed={contactOpen} onClick={() => setContactOpen((open) => !open)}><UserRound size={14} /> Contato</Button>
              </div>
            </header>
            {error && <div className="banner bad" role="alert">{error}</div>}
            {conversation.state === "WAITING_HUMAN" && <div className="banner wait">Esta conversa aguarda um atendente.</div>}
            {conversation.state === "HUMAN_ACTIVE" && !owns && <div className="banner">Outro atendente está com esta conversa. Você pode ler, sem responder.</div>}
            <div
              className="transcript"
              ref={scroller}
              onScroll={() => {
                const element = scroller.current;
                if (!element) return;
                stick.current = element.scrollHeight - element.scrollTop - element.clientHeight < 96;
              }}
            >
              {groupMessages(detail.messages).map((group) => (
                <div key={group.label} className="day-group">
                  <span className="day-sep">{group.label}</span>
                  {group.items.map((message) => (
                    <Bubble key={message.id} message={message} busy={busy} onRetry={message.role === "CUSTOMER" ? undefined : () => void retry(message.id)} />
                  ))}
                </div>
              ))}
            </div>
            {conversation.state === "HUMAN_ACTIVE" && owns && (
              <form className="composer" onSubmit={(event) => { event.preventDefault(); void sendReply(); }}>
                <div className="quick-replies">
                  {replies.map((item) => (
                    <button key={item} type="button" className="chip" onClick={() => setReply((current) => current ? `${current} ${item}` : item)}>{item}</button>
                  ))}
                  <input aria-label="Nova resposta rápida" value={customReply} placeholder="Nova resposta rápida" onChange={(event) => setCustomReply(event.target.value)} onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      const text = customReply.trim();
                      if (!text) return;
                      storeReplies([...replies, text].slice(-12));
                      setCustomReply("");
                    }
                  }} />
                </div>
                <div className="composer-row">
                  <textarea
                    aria-label="Mensagem"
                    rows={2}
                    value={reply}
                    placeholder="Escreva uma mensagem"
                    onChange={(event) => setReply(event.target.value)}
                    onKeyDown={onComposerKey}
                  />
                  <Button type="submit" disabled={busy || !reply.trim()} aria-label="Enviar"><Send size={16} /></Button>
                </div>
                <p className="composer-hint">Enter envia · Shift+Enter quebra a linha</p>
              </form>
            )}
          </>
        )}
      </div>
      {contactOpen && conversation && (
        <aside className="contact-panel">
          <h2>Contato</h2>
          <span className="avatar lg" style={{ background: avatarColor(conversation.customerName) }}>{initials(conversation.customerName)}</span>
          <strong>{conversation.customerName}</strong>
          <p>{phoneLabel}</p>
          <Badge tone={tones[conversation.state]}>{stateLabels[conversation.state]}</Badge>
          <h3>Opt-out</h3>
          <p>{consentText(conversation.customerPhone, consent)}</p>
          <h3>Pedidos</h3>
          {contactOrders.length === 0 && <p className="muted">Nenhum pedido desta conversa.</p>}
          <ul className="plain-list">
            {contactOrders.map((order) => (
              <li key={order.id}>
                <b>{order.lines.map((line) => `${line.quantity}× ${line.name}`).join(", ") || "Sem itens"}</b>
                <span>{orderStatus(order.status)} · {new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(order.totalCents / 100)}</span>
              </li>
            ))}
          </ul>
        </aside>
      )}
    </section>
  );
}

function presentPhone(phone: string): string {
  if (phone.startsWith("lid:")) return `Contato interno •••${phone.slice(-4)}`;
  const formatted = formatPhoneBR(phone);
  return formatted || phone;
}

function consentText(phone: string, consent: ContactConsent | null): string {
  if (phone.startsWith("lid:")) return "Identificador interno do WhatsApp. O opt-out não aparece para este contato.";
  if (!consent) return "Consultando o status de mensagens automáticas…";
  if (!consent.available) return "O canal WhatsApp está desligado neste servidor.";
  if (!consent.known) return "Este número ainda não tem registro de opt-out.";
  if (consent.optedOut) return "Pediu para parar as mensagens automáticas.";
  if (consent.optedIn) return "Autorizou avisos. Não pediu para sair.";
  return "Recebe respostas. Não pediu para sair.";
}

function orderStatus(status: CustomerOrder["status"]): string {
  if (status === "draft") return "Rascunho";
  if (status === "awaiting_confirmation") return "Aguardando confirmação";
  if (status === "confirmed") return "Confirmado";
  if (status === "sent_to_integration") return "Enviado";
  return "Cancelado";
}

function groupMessages(messages: Message[]): Array<{ label: string; items: Message[] }> {
  const groups: Array<{ label: string; items: Message[] }> = [];
  for (const message of messages) {
    const label = formatDayLabel(message.createdAt) || "Mensagens";
    const last = groups[groups.length - 1];
    if (!last || last.label !== label) groups.push({ label, items: [message] });
    else last.items.push(message);
  }
  return groups;
}

function Bubble({ message, busy, onRetry }: { message: Message; busy: boolean; onRetry?: () => void }) {
  const outgoing = message.role !== "CUSTOMER";
  const mark = outgoing ? deliveryTick(message.deliveryStatus, message.deliveryDetail) : null;
  const who = message.role === "CUSTOMER" ? "Cliente" : message.role === "BOT" ? "Assistente" : message.authorName ?? "Atendente";
  return (
    <article className={`bubble ${outgoing ? "out" : "in"}`}>
      <small>{who}</small>
      <p>{message.text}</p>
      <span className={`tick ${mark?.tick ?? ""}`}>
        <time>{formatClock(message.createdAt)}</time>
        {mark?.tick === "fila" && <Clock size={13} />}
        {mark?.tick === "enviada" && <Check size={13} />}
        {(mark?.tick === "entregue" || mark?.tick === "lida") && <CheckCheck size={13} />}
        {mark?.tick === "falha" && <AlertCircle size={13} />}
        {mark ? <span>{mark.label}</span> : null}
        {mark?.tick === "falha" && onRetry && <button type="button" onClick={onRetry} disabled={busy}>Reenviar</button>}
      </span>
    </article>
  );
}

function ListSkeleton() {
  return (
    <div className="skeleton-list" aria-hidden="true">
      {Array.from({ length: 5 }, (_, index) => <Skeleton key={index} className="row" />)}
    </div>
  );
}
