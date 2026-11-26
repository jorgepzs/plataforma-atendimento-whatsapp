import { useEffect, useState } from "react";
import { Headset, ShoppingBag, Wifi } from "lucide-react";
import { ApiError, apiRequest, formatApiError, tenantPath, type Conversation, type CustomerOrder, type Session } from "./api";
import { isToday } from "./format";
import type { WhatsAppChannelView } from "./WhatsAppView";
import { Badge } from "./ui";

type ViewId = "inicio" | "conversas" | "pedidos" | "catalogo" | "conhecimento" | "whatsapp" | "configuracoes";

export function DashboardView({
  tenantId,
  session,
  revision,
  onOpen,
  onSessionExpired
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
  const confirmed = today.filter((order) => order.status === "confirmed").length;
  const halted = Boolean(whatsapp?.halted || whatsapp?.status === "banned" || whatsapp?.status === "restricted");
  void session;

  return (
    <div className="stack">
      {error && <div className="banner bad" role="alert">{error}</div>}
      {halted && <div className="banner bad">WhatsApp com restrição{whatsapp?.haltReason ? `: ${whatsapp.haltReason}` : ""}. Não force o envio neste número.</div>}
      <section className="metric-grid">
        <button type="button" className="metric" onClick={() => onOpen("conversas")}>
          <Headset size={16} />
          <span>Fila humana</span>
          <strong>{waiting}</strong>
        </button>
        <button type="button" className="metric" onClick={() => onOpen("pedidos")}>
          <ShoppingBag size={16} />
          <span>Pedidos hoje</span>
          <strong>{today.length}</strong>
          <small>{confirmed} confirmados</small>
        </button>
        <button type="button" className="metric" onClick={() => onOpen("whatsapp")}>
          <Wifi size={16} />
          <span>WhatsApp</span>
          <strong>{whatsappLabel(whatsapp)}</strong>
          <small>{whatsapp?.phoneMasked ?? "Sem número"}</small>
        </button>
      </section>
      <section className="section-card">
        <h2>Agora</h2>
        {waiting === 0 && !halted && <p className="muted">Nada urgente nesta empresa.</p>}
        {waiting > 0 && <p><button type="button" className="text-link" onClick={() => onOpen("conversas")}>{waiting} conversa(s) aguardando uma pessoa</button></p>}
        {today.some((order) => order.integrationError) && <Badge tone="bad">Há pedido de hoje com falha de integração</Badge>}
      </section>
    </div>
  );
}

function whatsappLabel(view: WhatsAppChannelView | null): string {
  if (!view || view.enabled === false) return "Desligado";
  if (view.halted || view.status === "banned" || view.status === "restricted") return "Restrito";
  if (view.status === "connected") return "Conectado";
  if (view.status === "qr_pending") return "Aguardando QR";
  return "Sem sessão";
}
