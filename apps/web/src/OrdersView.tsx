import { useEffect, useRef, useState } from "react";
import { MapPin, Store } from "lucide-react";
import {
  ApiError,
  apiRequest,
  formatApiError,
  tenantPath,
  type Conversation,
  type CustomerOrder,
  type OrderStatus,
  type Session
} from "./api";
import { formatCents, formatListTime, orderStatusLabels } from "./format";
import { playOrderChime, useToast } from "./feedback";
import { Badge, Button, ConfirmDialog, Drawer, Skeleton } from "./ui";

const columns: OrderStatus[] = ["draft", "awaiting_confirmation", "confirmed", "sent_to_integration", "cancelled"];

const tones: Record<OrderStatus, "neutral" | "wait" | "ok" | "info" | "bad"> = {
  draft: "neutral",
  awaiting_confirmation: "wait",
  confirmed: "ok",
  sent_to_integration: "info",
  cancelled: "bad"
};

export function OrdersView({
  tenantId,
  session,
  revision,
  onSessionExpired,
  onUnseenChange
}: {
  tenantId: string;
  session: Session;
  revision: number;
  onSessionExpired: () => void;
  onUnseenChange: (count: number) => void;
}) {
  const toast = useToast();
  const [orders, setOrders] = useState<CustomerOrder[] | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<CustomerOrder | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [cancelId, setCancelId] = useState("");
  const [fresh, setFresh] = useState<string[]>([]);
  const known = useRef<Set<string> | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      apiRequest<{ orders: CustomerOrder[] }>(tenantPath(tenantId, "orders")),
      apiRequest<{ conversations: Conversation[] }>(tenantPath(tenantId, "conversations"))
    ]).then(([orderList, queue]) => {
      if (cancelled) return;
      setOrders(orderList.orders);
      setNames(Object.fromEntries(queue.conversations.map((item) => [item.id, item.customerName])));
      setError("");
      const confirmed = orderList.orders.filter((order) => order.status === "confirmed").map((order) => order.id);
      if (known.current === null) {
        known.current = new Set(confirmed);
        return;
      }
      const arrived = confirmed.filter((id) => !known.current?.has(id));
      for (const id of confirmed) known.current.add(id);
      if (arrived.length > 0) {
        playOrderChime();
        setFresh((current) => [...new Set([...current, ...arrived])]);
        toast(arrived.length === 1 ? "Novo pedido confirmado." : `${arrived.length} pedidos confirmados.`);
      }
    }).catch((reason: unknown) => {
      if (cancelled) return;
      if (reason instanceof ApiError && reason.status === 401) onSessionExpired();
      else setError(formatApiError(reason));
    });
    return () => { cancelled = true; };
  }, [tenantId, revision, onSessionExpired, toast]);

  useEffect(() => {
    onUnseenChange(fresh.length);
  }, [fresh.length, onUnseenChange]);

  useEffect(() => {
    if (!selected || !orders) return;
    const next = orders.find((order) => order.id === selected.id);
    if (next) setSelected(next);
  }, [orders, selected]);

  async function setStatus(orderId: string, status: "cancelled" | "sent_to_integration") {
    setBusy(true);
    setError("");
    try {
      await apiRequest(tenantPath(tenantId, `orders/${encodeURIComponent(orderId)}/status`), {
        method: "POST",
        csrfToken: session.csrfToken,
        body: { status }
      });
      toast(status === "cancelled" ? "Pedido cancelado." : "Pedido marcado como enviado.");
      setCancelId("");
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

  function open(order: CustomerOrder) {
    setSelected(order);
    setFresh((current) => current.filter((id) => id !== order.id));
  }

  return (
    <div className="orders-screen">
      {error && <div className="banner bad" role="alert">{error}</div>}
      {fresh.length > 0 && <div className="banner wait" role="status">{fresh.length} pedido(s) confirmado(s) novo(s).</div>}
      {orders === null && <div className="kanban">{columns.map((status) => <Skeleton key={status} className="col" />)}</div>}
      {orders !== null && orders.length === 0 && (
        <p className="muted">Nenhum pedido ainda. As colunas enchem quando o assistente confirma um pedido, com aviso sonoro.</p>
      )}
      {orders !== null && (
        <div className="kanban" aria-label="Pedidos por status">
          {columns.map((status) => {
            const items = orders.filter((order) => order.status === status);
            return (
              <section key={status} className="kanban-col" aria-label={orderStatusLabels[status]}>
                <header>
                  <h2>{orderStatusLabels[status]}</h2>
                  <Badge tone={tones[status]}>{items.length}</Badge>
                </header>
                <div className="kanban-cards">
                  {items.length === 0 && <p className="muted">Nenhum</p>}
                  {items.map((order) => (
                    <button key={order.id} type="button" className={`order-card ${fresh.includes(order.id) ? "is-new" : ""}`} onClick={() => open(order)}>
                      <span className="order-top">
                        <strong>{names[order.conversationId] ?? "Cliente"}</strong>
                        <time>{formatListTime(order.updatedAt)}</time>
                      </span>
                      <span className="order-lines">{order.lines.map((line) => `${line.quantity}× ${line.name}`).join(", ") || "Sem itens"}</span>
                      <span className="order-foot">
                        <b>{formatCents(order.totalCents)}</b>
                        <span>{order.fulfillment?.method === "delivery" ? "Entrega" : order.fulfillment ? "Retirada" : "Sem entrega"}</span>
                      </span>
                      {order.fulfillment?.address && <span className="order-address"><MapPin size={12} /> {order.fulfillment.address}</span>}
                      {order.integrationError && <span className="order-error">Falha na integração</span>}
                    </button>
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
      <Drawer open={Boolean(selected)} title="Pedido" onClose={() => setSelected(null)}>
        {selected && (
          <div className="stack">
            <Badge tone={tones[selected.status]}>{orderStatusLabels[selected.status]}</Badge>
            <p className="price">{formatCents(selected.totalCents)}</p>
            <p className="muted">{names[selected.conversationId] ?? "Cliente"} · {formatListTime(selected.createdAt)}</p>
            <ul className="plain-list">
              {selected.lines.map((line) => (
                <li key={line.lineId}>
                  <b>{line.quantity}× {line.name}</b>
                  <span>{line.choices.map((choice) => choice.name).join(", ")}</span>
                  <span>{formatCents(line.lineTotalCents)}</span>
                </li>
              ))}
            </ul>
            <p>Subtotal {formatCents(selected.subtotalCents)}{selected.deliveryFeeCents > 0 ? ` · taxa ${formatCents(selected.deliveryFeeCents)}` : ""}</p>
            <p className="fulfillment">
              {selected.fulfillment?.method === "delivery" ? <MapPin size={14} /> : <Store size={14} />}
              {selected.fulfillment?.method === "delivery"
                ? `Entrega${selected.fulfillment.address ? `: ${selected.fulfillment.address}` : ""}`
                : selected.fulfillment ? "Retirada no balcão" : "Entrega ainda não definida"}
            </p>
            {selected.fulfillment?.notes && <p className="muted">Obs.: {selected.fulfillment.notes}</p>}
            {selected.integrationError && <div className="banner bad">Integração: {selected.integrationError}</div>}
            <div className="dialog-actions">
              {selected.status === "confirmed" && <Button disabled={busy} onClick={() => void setStatus(selected.id, "sent_to_integration")}>Marcar enviado</Button>}
              {selected.status !== "cancelled" && selected.status !== "sent_to_integration" && (
                <Button variant="danger" disabled={busy} onClick={() => setCancelId(selected.id)}>Cancelar pedido</Button>
              )}
            </div>
          </div>
        )}
      </Drawer>
      <ConfirmDialog
        open={Boolean(cancelId)}
        title="Cancelar pedido"
        body="O cliente deixa de ver este pedido como ativo. Esta ação não envia uma mensagem automática."
        confirmLabel="Cancelar pedido"
        danger
        busy={busy}
        onClose={() => setCancelId("")}
        onConfirm={() => void setStatus(cancelId, "cancelled")}
      />
    </div>
  );
}
