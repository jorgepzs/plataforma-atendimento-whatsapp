import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  BookOpen,
  Headset,
  LayoutDashboard,
  LogOut,
  MessageCircle,
  Moon,
  Plus,
  Settings2,
  ShoppingBag,
  Sun,
  UtensilsCrossed,
  Wifi
} from "lucide-react";
import { ApiError, apiRequest, formatApiError, tenantPath, type Session, type Tenant } from "./api";
import { CatalogView } from "./CatalogView";
import { DashboardView } from "./DashboardView";
import { ToastProvider, unlockAudio, useTheme } from "./feedback";
import { InboxView } from "./InboxView";
import { KnowledgeView } from "./KnowledgeView";
import { OrdersView } from "./OrdersView";
import { SettingsView } from "./SettingsView";
import { Button, ConfirmDialog } from "./ui";
import { WhatsAppView } from "./WhatsAppView";

type ViewId = "inicio" | "conversas" | "pedidos" | "catalogo" | "conhecimento" | "whatsapp" | "configuracoes";

const views: Array<{ id: ViewId; label: string; icon: ReactNode }> = [
  { id: "inicio", label: "Início", icon: <LayoutDashboard size={16} /> },
  { id: "conversas", label: "Conversas", icon: <Headset size={16} /> },
  { id: "pedidos", label: "Pedidos", icon: <ShoppingBag size={16} /> },
  { id: "catalogo", label: "Catálogo", icon: <UtensilsCrossed size={16} /> },
  { id: "conhecimento", label: "Conhecimento", icon: <BookOpen size={16} /> },
  { id: "whatsapp", label: "WhatsApp", icon: <Wifi size={16} /> },
  { id: "configuracoes", label: "Configurações", icon: <Settings2 size={16} /> }
];

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
  const { theme, toggle } = useTheme();
  const [view, setView] = useState<ViewId>("inicio");
  const [revision, setRevision] = useState(0);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newSegment, setNewSegment] = useState<Tenant["segment"]>("outro");
  const [createError, setCreateError] = useState("");
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState<ViewId | null>(null);
  const [unseenOrders, setUnseenOrders] = useState(0);
  const viewRef = useRef(view);
  const dirtyRef = useRef(dirty);
  viewRef.current = view;
  dirtyRef.current = dirty;
  const onUnseenChange = useCallback((count: number) => setUnseenOrders(count), []);
  const onDirtyChange = useCallback((value: boolean) => setDirty(value), []);
  const tenant = tenants.find((item) => item.id === activeTenantId) ?? null;
  const membership = session.user.memberships.find((item) => item.tenantId === activeTenantId);
  const isAdmin = membership?.role === "TENANT_ADMIN" || session.user.platformAdmin;

  useEffect(() => {
    const onPointer = () => unlockAudio();
    window.addEventListener("pointerdown", onPointer, { once: true });
    return () => window.removeEventListener("pointerdown", onPointer);
  }, []);

  useEffect(() => {
    const read = () => {
      const hash = window.location.hash.replace("#", "") as ViewId;
      if (!views.some((item) => item.id === hash) || hash === viewRef.current) return;
      if (dirtyRef.current) {
        setPending(hash);
        window.location.hash = viewRef.current;
        return;
      }
      setView(hash);
      if (hash === "pedidos") setUnseenOrders(0);
    };
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);

  useEffect(() => {
    if (!dirty) return undefined;
    const onLeave = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onLeave);
    return () => window.removeEventListener("beforeunload", onLeave);
  }, [dirty]);

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

  function go(next: ViewId) {
    window.location.hash = next;
    setView(next);
    if (next === "pedidos") setUnseenOrders(0);
  }

  function open(next: ViewId) {
    if (next === view) return;
    if (dirty) setPending(next);
    else go(next);
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
  const flush = view === "conversas" || view === "pedidos";

  return (
    <ToastProvider>
    <div className="shell">
      <aside className="side">
        <div className="brand"><span><MessageCircle size={16} /></span> atende</div>
        <label className="tenant-switch">
          <small>Empresa</small>
          <strong>{tenant?.displayName ?? "Sem empresa"}</strong>
          <select aria-label="Trocar empresa" value={activeTenantId} onChange={(event) => onSwitchTenant(event.target.value)}>
            {tenants.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>)}
          </select>
        </label>
        <nav className="nav" aria-label="Seções">
          {views.map((item) => (
            <button key={item.id} type="button" className={view === item.id ? "active" : ""} onClick={() => open(item.id)}>
              {item.icon}
              <span>{item.label}</span>
              {item.id === "pedidos" && unseenOrders > 0 && <em className="nav-badge">{unseenOrders}</em>}
            </button>
          ))}
        </nav>
        {session.user.platformAdmin && (
          creating ? (
            <form className="stack side-form" onSubmit={(event) => void createTenant(event)}>
              <input aria-label="Nome da empresa" value={newName} onChange={(event) => setNewName(event.target.value)} required maxLength={120} placeholder="Nome da empresa" />
              <select aria-label="Segmento" value={newSegment} onChange={(event) => setNewSegment(event.target.value as Tenant["segment"])}>
                <option value="pizzaria">Pizzaria</option>
                <option value="barbearia">Barbearia</option>
                <option value="outro">Outro</option>
              </select>
              {createError && <div className="banner bad">{createError}</div>}
              <div className="dialog-actions">
                <Button size="sm" type="submit">Criar</Button>
                <Button size="sm" variant="secondary" type="button" onClick={() => setCreating(false)}>Cancelar</Button>
              </div>
            </form>
          ) : <Button variant="secondary" size="sm" onClick={() => setCreating(true)}><Plus size={14} /> Empresa</Button>
        )}
        <div className="side-foot">
          <button type="button" className="theme-toggle" onClick={toggle} aria-label={theme === "dark" ? "Usar tema claro" : "Usar tema escuro"}>
            {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
            {theme === "dark" ? "Tema claro" : "Tema escuro"}
          </button>
          <div className={`live ${channelHint.includes("QR") ? "" : "warn"}`}><i />{storageLabel} · {channelHint}</div>
          <div className="user-row">
            <div>
              <strong>{session.user.displayName}</strong>
              <small>{isAdmin ? "Administração" : "Atendimento"}</small>
            </div>
            <button type="button" className="icon-button" aria-label="Sair" onClick={onLogout}><LogOut size={16} /></button>
          </div>
        </div>
      </aside>
      <div className="main">
        <header className="top">
          <h1>{title}</h1>
          <span>{tenant?.displayName}</span>
          <button type="button" className="icon-button mobile-only" aria-label={theme === "dark" ? "Usar tema claro" : "Usar tema escuro"} onClick={toggle}>
            {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
          </button>
        </header>
        <div className={`body ${flush ? "flush" : ""}`}>
          {tenant && view === "inicio" && <DashboardView tenantId={tenant.id} session={session} revision={revision} onOpen={open} onSessionExpired={onSessionExpired} />}
          {tenant && view === "conversas" && <InboxView tenantId={tenant.id} session={session} revision={revision} onSessionExpired={onSessionExpired} />}
          {tenant && view === "pedidos" && <OrdersView tenantId={tenant.id} session={session} revision={revision} onSessionExpired={onSessionExpired} onUnseenChange={onUnseenChange} />}
          {tenant && view === "catalogo" && <CatalogView tenantId={tenant.id} session={session} canEdit={isAdmin} onSessionExpired={onSessionExpired} onDirtyChange={onDirtyChange} />}
          {tenant && view === "conhecimento" && <KnowledgeView tenantId={tenant.id} session={session} canEdit={isAdmin} onSessionExpired={onSessionExpired} onDirtyChange={onDirtyChange} />}
          {tenant && view === "whatsapp" && <WhatsAppView tenantId={tenant.id} session={session} isAdmin={isAdmin} onSessionExpired={onSessionExpired} />}
          {tenant && view === "configuracoes" && <SettingsView tenantId={tenant.id} session={session} canEdit={isAdmin} onSessionExpired={onSessionExpired} onDirtyChange={onDirtyChange} />}
          {!tenant && <p className="empty">Esta conta não tem empresa vinculada.</p>}
        </div>
      </div>
      <ConfirmDialog
        open={pending !== null}
        title="Alterações não salvas"
        body="Se você sair agora, as mudanças desta tela serão perdidas."
        confirmLabel="Sair sem salvar"
        danger
        onClose={() => setPending(null)}
        onConfirm={() => {
          const next = pending;
          dirtyRef.current = false;
          setPending(null);
          setDirty(false);
          if (next) go(next);
        }}
      />
    </div>
    </ToastProvider>
  );
}
