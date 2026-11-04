import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  Activity,
  AlertCircle,
  ArrowDownLeft,
  Bot,
  Check,
  ChevronDown,
  CircleHelp,
  Clock3,
  Grid2X2,
  Headset,
  Layers3,
  LogOut,
  MessageCircle,
  MessageSquareText,
  Phone,
  Plus,
  RefreshCw,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  UserRound,
  Wifi,
  X,
} from "lucide-react";
import {
  apiRequest,
  ApiError,
  formatApiError,
  tenantPath,
  type ConfigResponse,
  type Conversation,
  type ConversationDetail,
  type ConversationState,
  type KnowledgeItem,
  type Message,
  type Session,
  type Tenant,
  type TenantConfig,
} from "./api";

type SystemInfo = {
  product: string;
  version: string;
  phase: string;
  eventStore: string;
  capabilities: string[];
  localDemoEnabled?: boolean;
  localAiEnabled?: boolean;
  outboundMode?: "simulated" | "cloud-api-local-test";
};

type Readiness = {
  status: string;
  dependencies: { eventStore: { status: string; kind: string } };
};

type LoadState<T> = { value: T | null; state: "loading" | "ok" | "error" };
type AuthState = "checking" | "anonymous" | "authenticated" | "error" | "disabled";
type RealtimeState = "connecting" | "connected" | "reconnecting";
type QueueFilter = "ALL" | ConversationState;

const capabilityLabels: Record<string, string> = {
  "meta.webhook.verify": "Verificação de webhook Meta",
  "meta.webhook.receive": "Recebimento de eventos",
  "meta.webhook.deduplicate": "Deduplicação de eventos",
  "conversation.state.validate": "Validação de estado da conversa",
  "message.cost.guard": "Proteção de custo de mensagens",
  "auth.local.session": "Acesso local autenticado",
  "attendance.local.worker": "Processamento de conversas",
  "attendance.human.queue": "Fila de atendimento humano",
  "tenant.local.configuration": "Configuração por empresa",
  "attendance.local.persistence": "Histórico salvo localmente",
  "attendance.queue.recovery": "Recuperação da fila",
  "whatsapp.text.send.local-test": "Envio WhatsApp restrito a teste local",
};

const stateLabels: Record<ConversationState, string> = {
  BOT_ACTIVE: "Automação ativa",
  WAITING_HUMAN: "Aguardando pessoa",
  HUMAN_ACTIVE: "Em atendimento",
  CLOSED: "Encerrada",
};

function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toLocaleUpperCase("pt-BR") ?? "")
    .join("") || "A";
}

function formatDate(value: string, includeDate = false): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("pt-BR", {
    ...(includeDate ? { day: "2-digit", month: "short" } : {}),
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function statusLabel(error: unknown): string {
  if (error instanceof ApiError && error.status === 409) return "Esta conversa mudou em outra sessão. Atualize a fila e tente novamente.";
  return formatApiError(error);
}

function App() {
  const [info, setInfo] = useState<LoadState<SystemInfo>>({ value: null, state: "loading" });
  const [readiness, setReadiness] = useState<LoadState<Readiness>>({ value: null, state: "loading" });
  const [authState, setAuthState] = useState<AuthState>("checking");
  const [authProblem, setAuthProblem] = useState("");
  const [session, setSession] = useState<Session | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [writeBusy, setWriteBusy] = useState(false);

  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [activeTenantId, setActiveTenantId] = useState("");
  const [tenantLoading, setTenantLoading] = useState(false);
  const [tenantError, setTenantError] = useState("");

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState(false);
  const [queueError, setQueueError] = useState("");
  const [realtimeState, setRealtimeState] = useState<RealtimeState>("connecting");
  const [queueFilter, setQueueFilter] = useState<QueueFilter>("ALL");
  const [selectedConversationId, setSelectedConversationId] = useState("");
  const [selectedDetail, setSelectedDetail] = useState<ConversationDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");
  const [replyText, setReplyText] = useState("");
  const [actionError, setActionError] = useState("");

  const [config, setConfig] = useState<TenantConfig | null>(null);
  const [handoffKeywordsText, setHandoffKeywordsText] = useState("");
  const [configLoading, setConfigLoading] = useState(false);
  const [configError, setConfigError] = useState("");
  const [configNotice, setConfigNotice] = useState("");
  const [configConflict, setConfigConflict] = useState(false);

  const [showCreateTenant, setShowCreateTenant] = useState(false);
  const [newTenantName, setNewTenantName] = useState("");
  const [newTenantSegment, setNewTenantSegment] = useState<Tenant["segment"]>("outro");
  const [createTenantError, setCreateTenantError] = useState("");

  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [customerText, setCustomerText] = useState("");
  const [simulatorNotice, setSimulatorNotice] = useState("");
  const [simulatorError, setSimulatorError] = useState("");

  const scopeRef = useRef(0);
  const queueRequestRef = useRef(0);
  const detailRequestRef = useRef(0);
  const selectedConversationRef = useRef("");
  const activeTenantRef = useRef("");

  const demoEnabled = info.value?.localDemoEnabled === true;
  const persistentLocal = demoEnabled && info.value?.eventStore === "sqlite";
  const ready = readiness.value?.status === "ready";
  const today = new Intl.DateTimeFormat("pt-BR", {
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date());
  const activeTenant = tenants.find((tenant) => tenant.id === activeTenantId) ?? null;
  const activeMembership = session?.user.memberships.find((membership) => membership.tenantId === activeTenantId);
  const isTenantAdmin = activeMembership?.role === "TENANT_ADMIN";
  const isPlatformAdmin = session?.user.platformAdmin === true;

  const filteredConversations = useMemo(
    () => queueFilter === "ALL" ? conversations : conversations.filter((item) => item.state === queueFilter),
    [conversations, queueFilter],
  );
  const waitingCount = conversations.filter((item) => item.state === "WAITING_HUMAN").length;
  const activeCount = conversations.filter((item) => item.state === "HUMAN_ACTIVE").length;
  const botCount = conversations.filter((item) => item.state === "BOT_ACTIVE").length;
  const closedCount = conversations.filter((item) => item.state === "CLOSED").length;
  const ownsConversation = Boolean(
    session && selectedDetail?.conversation.assignedUserId === session.user.id,
  );

  function resetTenantData() {
    queueRequestRef.current += 1;
    detailRequestRef.current += 1;
    selectedConversationRef.current = "";
    setConversations([]);
    setConversationsLoading(false);
    setQueueError("");
    setRealtimeState("connecting");
    setQueueFilter("ALL");
    setSelectedConversationId("");
    setSelectedDetail(null);
    setDetailLoading(false);
    setDetailError("");
    setReplyText("");
    setActionError("");
    setConfig(null);
    setHandoffKeywordsText("");
    setConfigLoading(false);
    setConfigError("");
    setConfigNotice("");
    setConfigConflict(false);
    setCustomerName("");
    setCustomerPhone("");
    setCustomerText("");
    setSimulatorNotice("");
    setSimulatorError("");
  }

  function switchTenant(tenantId: string) {
    if (!tenantId || tenantId === activeTenantRef.current || writeBusy) return;
    scopeRef.current += 1;
    activeTenantRef.current = tenantId;
    resetTenantData();
    setActiveTenantId(tenantId);
    setTenantError("");
  }

  function expireSession(requestScope: number) {
    if (scopeRef.current !== requestScope) return;
    scopeRef.current += 1;
    activeTenantRef.current = "";
    resetTenantData();
    setSession(null);
    setTenants([]);
    setActiveTenantId("");
    setTenantError("");
    setAuthState("anonymous");
    setAuthProblem("Sua sessão expirou. Entre novamente para continuar.");
    setLoginError("");
    setPassword("");
    setWriteBusy(false);
  }

  async function refreshQueue(tenantId: string, requestScope: number, initial = false) {
    const requestId = ++queueRequestRef.current;
    if (initial) setConversationsLoading(true);
    try {
      const response = await apiRequest<{ conversations: Conversation[] }>(tenantPath(tenantId, "conversations"));
      if (scopeRef.current !== requestScope || queueRequestRef.current !== requestId) return;
      setConversations(response.conversations);
      setQueueError("");
      if (selectedConversationRef.current) {
        const updated = response.conversations.find((item) => item.id === selectedConversationRef.current);
        if (updated) {
          setSelectedDetail((current) => current ? { ...current, conversation: updated } : current);
        }
      }
    } catch (error) {
      if (scopeRef.current !== requestScope || queueRequestRef.current !== requestId) return;
      if (error instanceof ApiError && error.status === 401) {
        expireSession(requestScope);
      } else {
        setQueueError(`Não foi possível atualizar a fila. ${formatApiError(error)}`);
      }
    } finally {
      if (scopeRef.current === requestScope && queueRequestRef.current === requestId) {
        setConversationsLoading(false);
      }
    }
  }

  async function refreshSelectedConversation(tenantId: string, requestScope: number) {
    const conversationId = selectedConversationRef.current;
    if (!conversationId || scopeRef.current !== requestScope || activeTenantRef.current !== tenantId) return;
    const requestId = ++detailRequestRef.current;
    try {
      const detail = await apiRequest<ConversationDetail>(
        tenantPath(tenantId, `conversations/${encodeURIComponent(conversationId)}`),
      );
      if (
        scopeRef.current !== requestScope
        || activeTenantRef.current !== tenantId
        || selectedConversationRef.current !== conversationId
        || detailRequestRef.current !== requestId
      ) return;
      setSelectedDetail(detail);
      setDetailError("");
      setDetailLoading(false);
    } catch (error) {
      if (
        scopeRef.current !== requestScope
        || activeTenantRef.current !== tenantId
        || selectedConversationRef.current !== conversationId
        || detailRequestRef.current !== requestId
      ) return;
      if (error instanceof ApiError && error.status === 401) expireSession(requestScope);
      else setDetailError(`Não foi possível atualizar o histórico. ${formatApiError(error)}`);
      setDetailLoading(false);
    }
  }

  async function loadConfig(tenantId: string, requestScope: number, loading = true) {
    if (loading) setConfigLoading(true);
    setConfigError("");
    try {
      const response = await apiRequest<ConfigResponse>(tenantPath(tenantId, "config"));
      if (scopeRef.current !== requestScope || activeTenantRef.current !== tenantId) return;
      setConfig(response.config);
      setHandoffKeywordsText(response.config.handoffKeywords.join(", "));
      setConfigConflict(false);
      setConfigNotice("");
    } catch (error) {
      if (scopeRef.current !== requestScope) return;
      if (error instanceof ApiError && error.status === 401) {
        expireSession(requestScope);
      } else {
        setConfigError(`Não foi possível carregar a configuração. ${formatApiError(error)}`);
      }
    } finally {
      if (scopeRef.current === requestScope) setConfigLoading(false);
    }
  }

  useEffect(() => {
    let active = true;
    apiRequest<SystemInfo>("/api/v1/system/info").then(
      async (systemInfo) => {
        if (!active) return;
        setInfo({ value: systemInfo, state: "ok" });
        if (systemInfo.localDemoEnabled !== true) {
          setAuthState("disabled");
          return;
        }
        setAuthState("checking");
        try {
          const currentSession = await apiRequest<Session>("/api/v1/auth/me");
          if (!active) return;
          scopeRef.current += 1;
          setSession(currentSession);
          setAuthState("authenticated");
          setAuthProblem("");
        } catch (error) {
          if (!active) return;
          if (error instanceof ApiError && error.status === 401) {
            setAuthState("anonymous");
          } else {
            setAuthState("error");
            setAuthProblem(`Não foi possível verificar a sessão. ${formatApiError(error)}`);
          }
        }
      },
      (error: unknown) => {
        if (!active) return;
        setInfo({ value: null, state: "error" });
        setAuthState("disabled");
        setAuthProblem(formatApiError(error));
      },
    );
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    apiRequest<Readiness>("/health/ready", { allowNotReady: true }).then(
      (value) => active && setReadiness({ value, state: "ok" }),
      () => active && setReadiness({ value: null, state: "error" }),
    );
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!session) return;
    let active = true;
    const requestScope = scopeRef.current;
    setTenantLoading(true);
    setTenantError("");
    apiRequest<{ tenants: Tenant[] }>("/api/v1/tenants").then(
      ({ tenants: available }) => {
        if (!active || scopeRef.current !== requestScope) return;
        setTenants(available);
        const currentIsAllowed = available.some((tenant) => tenant.id === activeTenantRef.current);
        const nextId = currentIsAllowed ? activeTenantRef.current : available[0]?.id ?? "";
        if (!currentIsAllowed) {
          activeTenantRef.current = nextId;
          setActiveTenantId(nextId);
        }
        if (!nextId) setTenantError("Esta conta ainda não tem acesso a uma empresa.");
      },
      (error: unknown) => {
        if (!active || scopeRef.current !== requestScope) return;
        if (error instanceof ApiError && error.status === 401) expireSession(requestScope);
        else setTenantError(`Não foi possível carregar as empresas. ${formatApiError(error)}`);
      },
    ).finally(() => {
      if (active && scopeRef.current === requestScope) setTenantLoading(false);
    });
    return () => { active = false; };
  }, [session?.user.id]);

  useEffect(() => {
    if (!session || !activeTenantId) return;
    let active = true;
    let authCheckInFlight = false;
    const requestScope = scopeRef.current;
    void refreshQueue(activeTenantId, requestScope, true);
    void loadConfig(activeTenantId, requestScope);
    setRealtimeState("connecting");

    const stream = new EventSource(tenantPath(activeTenantId, "events"));
    const refreshAttendance = () => {
      if (!active || scopeRef.current !== requestScope) return;
      void refreshQueue(activeTenantId, requestScope);
      void refreshSelectedConversation(activeTenantId, requestScope);
    };
    stream.addEventListener("attendance.queue.changed.v1", refreshAttendance);
    stream.addEventListener("auth.expired.v1", () => {
      stream.close();
      expireSession(requestScope);
    });
    stream.onopen = () => {
      if (active && scopeRef.current === requestScope) setRealtimeState("connected");
    };
    stream.onerror = () => {
      if (!active || scopeRef.current !== requestScope) return;
      setRealtimeState("reconnecting");
      if (authCheckInFlight) return;
      authCheckInFlight = true;
      void apiRequest<Session>("/api/v1/auth/me").catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 401) expireSession(requestScope);
      }).finally(() => { authCheckInFlight = false; });
    };
    return () => {
      active = false;
      stream.close();
    };
  }, [session?.user.id, activeTenantId]);

  async function retrySessionCheck() {
    setAuthState("checking");
    setAuthProblem("");
    try {
      const currentSession = await apiRequest<Session>("/api/v1/auth/me");
      scopeRef.current += 1;
      setSession(currentSession);
      setAuthState("authenticated");
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) setAuthState("anonymous");
      else {
        setAuthState("error");
        setAuthProblem(`Não foi possível verificar a sessão. ${formatApiError(error)}`);
      }
    }
  }

  async function submitLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!demoEnabled || writeBusy) return;
    setWriteBusy(true);
    setLoginError("");
    setAuthProblem("");
    try {
      const result = await apiRequest<Session>("/api/v1/auth/login", {
        method: "POST",
        body: { email: email.trim(), password },
      });
      scopeRef.current += 1;
      activeTenantRef.current = "";
      resetTenantData();
      setTenants([]);
      setActiveTenantId("");
      setSession(result);
      setAuthState("authenticated");
      setPassword("");
      setLoginError("");
    } catch (error) {
      setLoginError(`Não foi possível entrar. ${formatApiError(error)}`);
    } finally {
      setWriteBusy(false);
    }
  }

  async function logout() {
    if (!session || writeBusy) return;
    const requestScope = scopeRef.current;
    setWriteBusy(true);
    setAuthProblem("");
    try {
      await apiRequest<void>("/api/v1/auth/logout", {
        method: "POST",
        csrfToken: session.csrfToken,
      });
      if (scopeRef.current !== requestScope) return;
      scopeRef.current += 1;
      activeTenantRef.current = "";
      resetTenantData();
      setSession(null);
      setTenants([]);
      setActiveTenantId("");
      setAuthState("anonymous");
      setAuthProblem("");
      setPassword("");
      setWriteBusy(false);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) expireSession(requestScope);
      else setAuthProblem(`Não foi possível encerrar a sessão. ${formatApiError(error)}`);
    } finally {
      if (scopeRef.current === requestScope) setWriteBusy(false);
    }
  }

  async function selectConversation(conversation: Conversation) {
    if (!activeTenantId || !session) return;
    selectedConversationRef.current = conversation.id;
    setSelectedConversationId(conversation.id);
    setSelectedDetail(null);
    setDetailError("");
    setDetailLoading(true);
    setReplyText("");
    const requestScope = scopeRef.current;
    const requestId = ++detailRequestRef.current;
    try {
      const detail = await apiRequest<ConversationDetail>(tenantPath(activeTenantId, `conversations/${encodeURIComponent(conversation.id)}`));
      if (scopeRef.current !== requestScope || detailRequestRef.current !== requestId || selectedConversationRef.current !== conversation.id) return;
      setSelectedDetail(detail);
    } catch (error) {
      if (scopeRef.current !== requestScope || detailRequestRef.current !== requestId) return;
      if (error instanceof ApiError && error.status === 401) expireSession(requestScope);
      else setDetailError(`Não foi possível abrir a conversa. ${formatApiError(error)}`);
    } finally {
      if (scopeRef.current === requestScope && detailRequestRef.current === requestId) setDetailLoading(false);
    }
  }

  async function updateConversation(action: "handoff" | "claim" | "close" | "resume") {
    const conversation = selectedDetail?.conversation;
    if (!conversation || !activeTenantId || !session || writeBusy) return;
    const requestScope = scopeRef.current;
    setWriteBusy(true);
    setActionError("");
    try {
      const result = await apiRequest<{ conversation: Conversation }>(
        tenantPath(activeTenantId, `conversations/${encodeURIComponent(conversation.id)}/${action}`),
        { method: "POST", csrfToken: session.csrfToken },
      );
      if (scopeRef.current !== requestScope) return;
      setConversations((current) => current.map((item) => item.id === result.conversation.id ? result.conversation : item));
      if (selectedConversationRef.current === result.conversation.id) {
        detailRequestRef.current += 1;
        setSelectedDetail((current) => current ? { ...current, conversation: result.conversation } : current);
      }
      await refreshQueue(activeTenantId, requestScope);
    } catch (error) {
      if (scopeRef.current !== requestScope) return;
      if (error instanceof ApiError && error.status === 401) expireSession(requestScope);
      else if (selectedConversationRef.current === conversation.id) setActionError(statusLabel(error));
    } finally {
      if (scopeRef.current === requestScope) setWriteBusy(false);
    }
  }

  async function submitReply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const conversation = selectedDetail?.conversation;
    const text = replyText.trim();
    if (!conversation || !activeTenantId || !session || !text || writeBusy || !ownsConversation) return;
    const requestScope = scopeRef.current;
    setWriteBusy(true);
    setActionError("");
    try {
      const result = await apiRequest<{ message: Message; conversation: Conversation }>(
        tenantPath(activeTenantId, `conversations/${encodeURIComponent(conversation.id)}/reply`),
        { method: "POST", csrfToken: session.csrfToken, body: { text } },
      );
      if (scopeRef.current !== requestScope) return;
      if (selectedConversationRef.current === conversation.id) {
        detailRequestRef.current += 1;
        setSelectedDetail((current) => current && current.conversation.id === conversation.id
          ? { conversation: result.conversation, messages: [...current.messages, result.message] }
          : current);
      }
      setConversations((current) => current.map((item) => item.id === result.conversation.id ? result.conversation : item));
      if (selectedConversationRef.current === conversation.id) setReplyText("");
      await refreshQueue(activeTenantId, requestScope);
    } catch (error) {
      if (scopeRef.current !== requestScope) return;
      if (error instanceof ApiError && error.status === 401) expireSession(requestScope);
      else if (selectedConversationRef.current === conversation.id) setActionError(statusLabel(error));
    } finally {
      if (scopeRef.current === requestScope) setWriteBusy(false);
    }
  }

  async function saveConfig(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!config || !activeTenantId || !session || !isTenantAdmin || writeBusy) return;
    const requestScope = scopeRef.current;
    setWriteBusy(true);
    setConfigError("");
    setConfigNotice("");
    setConfigConflict(false);
    try {
      const response = await apiRequest<ConfigResponse>(tenantPath(activeTenantId, "config"), {
        method: "PUT",
        csrfToken: session.csrfToken,
        body: {
          businessName: config.businessName,
          segment: config.segment,
          greeting: config.greeting,
          knowledge: config.knowledge,
          handoffKeywords: config.handoffKeywords,
          assistantMode: config.assistantMode,
          version: config.version,
        },
      });
      if (scopeRef.current !== requestScope) return;
      setConfig(response.config);
      setHandoffKeywordsText(response.config.handoffKeywords.join(", "));
      setTenants((current) => current.map((tenant) => tenant.id === response.tenant.id ? response.tenant : tenant));
      setConfigNotice("Configuração salva.");
    } catch (error) {
      if (scopeRef.current !== requestScope) return;
      if (error instanceof ApiError && error.status === 401) expireSession(requestScope);
      else if (error instanceof ApiError && error.status === 409) {
        setConfigConflict(true);
        setConfigError("A configuração foi alterada em outra sessão. Recarregue a versão atual antes de salvar.");
      } else setConfigError(`Não foi possível salvar. ${formatApiError(error)}`);
    } finally {
      if (scopeRef.current === requestScope) setWriteBusy(false);
    }
  }

  async function createTenant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session || !session.user.platformAdmin || writeBusy) return;
    const requestScope = scopeRef.current;
    setWriteBusy(true);
    setCreateTenantError("");
    try {
      const result = await apiRequest<{ tenant: Tenant }>("/api/v1/tenants", {
        method: "POST",
        csrfToken: session.csrfToken,
        body: { displayName: newTenantName.trim(), segment: newTenantSegment },
      });
      const [refreshedSession, availableTenants] = await Promise.all([
        apiRequest<Session>("/api/v1/auth/me"),
        apiRequest<{ tenants: Tenant[] }>("/api/v1/tenants"),
      ]);
      if (scopeRef.current !== requestScope) return;
      setSession(refreshedSession);
      setTenants(availableTenants.tenants);
      setShowCreateTenant(false);
      setNewTenantName("");
      setNewTenantSegment("outro");
      scopeRef.current += 1;
      activeTenantRef.current = result.tenant.id;
      resetTenantData();
      setActiveTenantId(result.tenant.id);
      setConfigNotice(`Empresa “${result.tenant.displayName}” cadastrada.`);
      setWriteBusy(false);
    } catch (error) {
      if (scopeRef.current !== requestScope) return;
      if (error instanceof ApiError && error.status === 401) expireSession(requestScope);
      else setCreateTenantError(`Não foi possível cadastrar a empresa. ${formatApiError(error)}`);
    } finally {
      if (scopeRef.current === requestScope) setWriteBusy(false);
    }
  }

  async function submitSimulation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeTenantId || !session || writeBusy) return;
    const requestScope = scopeRef.current;
    setWriteBusy(true);
    setSimulatorError("");
    setSimulatorNotice("");
    try {
      const clientMessageId = typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const response = await apiRequest<{ eventId: string; status: "PENDING" | "DUPLICATE" }>(
        tenantPath(activeTenantId, "simulate"),
        {
          method: "POST",
          csrfToken: session.csrfToken,
          body: { customerName: customerName.trim(), customerPhone: customerPhone.trim(), text: customerText.trim(), clientMessageId },
        },
      );
      if (scopeRef.current !== requestScope) return;
      setSimulatorNotice(response.status === "DUPLICATE"
        ? "Esta mensagem já estava na fila local. A fila será atualizada em instantes."
        : "Mensagem aceita para processamento local. A conversa deve aparecer em instantes.");
      setCustomerText("");
    } catch (error) {
      if (scopeRef.current !== requestScope) return;
      if (error instanceof ApiError && error.status === 401) expireSession(requestScope);
      else setSimulatorError(`Não foi possível simular a mensagem. ${formatApiError(error)}`);
    } finally {
      if (scopeRef.current === requestScope) setWriteBusy(false);
    }
  }

  function updateConfig<K extends keyof TenantConfig>(key: K, value: TenantConfig[K]) {
    setConfig((current) => current ? { ...current, [key]: value } : current);
    setConfigNotice("");
  }

  function updateKnowledge(index: number, key: keyof KnowledgeItem, value: string) {
    setConfig((current) => {
      if (!current) return current;
      const knowledge = current.knowledge.map((item, itemIndex) => itemIndex === index ? { ...item, [key]: value } : item);
      return { ...current, knowledge };
    });
    setConfigNotice("");
  }

  function addKnowledge() {
    setConfig((current) => current ? { ...current, knowledge: [...current.knowledge, { question: "", answer: "" }] } : current);
  }

  function removeKnowledge(index: number) {
    setConfig((current) => current ? { ...current, knowledge: current.knowledge.filter((_, itemIndex) => itemIndex !== index) } : current);
  }

  const foundationDescription = info.state === "loading"
    ? "Carregando informações da plataforma…"
    : info.state === "error"
      ? "Não foi possível consultar as informações da plataforma. Verifique se a API está disponível."
      : demoEnabled
        ? persistentLocal
          ? "Ambiente local de demonstração. Empresas, configurações, sessões e histórico são salvos nesta máquina e permanecem após reiniciar. Respostas continuam simuladas."
          : "Ambiente local de demonstração. Contas, conversas e configurações ficam em memória e são apagadas quando o serviço reinicia."
        : "A plataforma está na fase de fundação. O atendimento local não está habilitado neste ambiente.";

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Navegação principal">
        <a className="brand" href="#inicio" aria-label="Atende, início">
          <span className="brand-mark"><MessageCircle size={19} strokeWidth={2.4} /></span>
          <span>atende<span className="brand-dot">.</span></span>
        </a>
        {session && demoEnabled ? (
          <>
            <label className="workspace-switch" htmlFor="tenant-select">
              <span className="workspace-avatar">{initials(activeTenant?.displayName ?? "Atende")}</span>
              <span className="workspace-copy"><strong>Empresa atual</strong><small>{activeTenant?.displayName ?? (tenantLoading ? "Carregando…" : "Sem empresa")}</small></span>
              <ChevronDown size={15} aria-hidden="true" />
              <select
                id="tenant-select"
                className="workspace-select"
                value={activeTenantId}
                aria-label="Trocar empresa"
                disabled={tenantLoading || writeBusy || tenants.length < 2}
                onChange={(event) => switchTenant(event.target.value)}
              >
                {tenants.map((tenant) => <option key={tenant.id} value={tenant.id}>{tenant.displayName}</option>)}
              </select>
            </label>
            <p className="nav-label">MENU</p>
            <nav className="nav-list">
              <a className="nav-item active" href="#inicio" aria-current="page"><Grid2X2 size={18} /> Visão geral</a>
              <a className="nav-item" href="#atendimento"><Headset size={18} /> Atendimento{waitingCount > 0 && <span className="nav-count">{waitingCount}</span>}</a>
              <a className="nav-item" href="#configuracao"><Settings2 size={18} /> Configuração</a>
              <a className="nav-item" href="#simulador"><MessageSquareText size={18} /> Simulador</a>
            </nav>
            <div className="sidebar-bottom">
              <div className="profile">
                <span className="profile-avatar">{initials(session.user.displayName)}</span>
                <span className="workspace-copy"><strong>{session.user.displayName}</strong><small>{activeMembership?.role === "TENANT_ADMIN" ? "Administradora" : "Atendente"}</small></span>
                <button className="icon-button" type="button" onClick={() => void logout()} disabled={writeBusy} aria-label="Sair da conta" title="Sair">
                  <LogOut size={16} />
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="sidebar-note">
            <Layers3 size={17} />
            <span>{demoEnabled ? "Acesso local" : "Fundação da plataforma"}</span>
          </div>
        )}
      </aside>

      <main id="inicio" className="main-content">
        <header className="topbar">
          <div className="breadcrumb">{activeTenant?.displayName ?? "Plataforma"} <span>/</span> <strong>Visão geral</strong></div>
          <div className="topbar-right">
            <span className="help-link"><CircleHelp size={16} /> Ajuda</span>
            {session && <button className="icon-button mobile-logout" type="button" onClick={() => void logout()} disabled={writeBusy} aria-label="Sair da conta" title="Sair"><LogOut size={15} /></button>}
            {session && <span className="top-avatar" aria-label={session.user.displayName}>{initials(session.user.displayName)}</span>}
          </div>
        </header>

        <div className="content-wrap">
          <section className="welcome-row">
            <div>
              <p className="eyebrow">{today.toLocaleUpperCase("pt-BR")}</p>
              <h1>Visão geral <span>✳</span></h1>
              <p className="welcome-sub">Aqui está o estado atual da sua operação.</p>
            </div>
            <div className={`system-pill ${readiness.state === "loading" ? "pending" : ready ? "healthy" : "problem"}`} role="status">
              {readiness.state === "loading" ? <Clock3 size={15} /> : readiness.state === "error" ? <X size={15} /> : ready ? <Check size={15} /> : <Activity size={15} />}
              {readiness.state === "loading" ? "Verificando sistema" : readiness.state === "error" ? "Sistema indisponível" : ready ? "Sistema operacional" : "Atenção necessária"}
            </div>
          </section>

          <section className="foundation-card" aria-labelledby="foundation-title">
            <div className="foundation-top">
              <div className="foundation-icon"><Layers3 size={19} /></div>
              <div className="foundation-heading"><div className="section-kicker">SUA PLATAFORMA</div><h2 id="foundation-title">Fundação do sistema</h2></div>
              {info.state === "ok" && info.value && <span className="version-tag">v{info.value.version}</span>}
            </div>
            <p className="foundation-description">{foundationDescription}</p>
            <div className="status-grid">
              <div className="status-cell"><span className="cell-label"><Wifi size={14} /> API</span><span className={`cell-value ${info.state === "ok" ? "text-green" : info.state === "error" ? "text-red" : "text-muted"}`}><i className="status-dot" />{info.state === "ok" ? "Conectada" : info.state === "error" ? "Sem conexão" : "Verificando…"}</span></div>
              <div className="status-cell"><span className="cell-label"><ShieldCheck size={14} /> Armazenamento de eventos</span><span className={`cell-value ${readiness.state === "ok" && ready ? "text-green" : readiness.state === "error" || readiness.state === "ok" ? "text-red" : "text-muted"}`}><i className="status-dot" />{readiness.state === "loading" ? "Verificando…" : readiness.state === "error" ? "Sem resposta" : ready ? `${readiness.value?.dependencies.eventStore.kind} · Disponível` : "Indisponível"}</span></div>
              <div className="status-cell"><span className="cell-label"><Activity size={14} /> Fase</span><span className="cell-value neutral">{info.state === "ok" ? info.value?.phase : info.state === "error" ? "—" : "Carregando…"}</span></div>
            </div>
            {info.state === "ok" && info.value && <div className="capabilities"><span className="capabilities-label">CAPACIDADES DISPONÍVEIS</span><div className="capability-list">{info.value.capabilities.map((item) => <span className="capability" key={item}><Check size={13} />{capabilityLabels[item] ?? item}</span>)}</div></div>}
            {info.state === "error" && <div className="inline-alert error" role="alert">{authProblem || "API indisponível."} <button type="button" className="text-button" onClick={() => window.location.reload()}>Tentar novamente</button></div>}
          </section>

          {!demoEnabled && info.state === "ok" && (
            <section className="notice-card disabled-demo" aria-labelledby="demo-disabled-title">
              <span className="notice-icon"><ShieldCheck size={19} /></span>
              <div><h2 id="demo-disabled-title">Atendimento local não habilitado</h2><p>Esta instalação está mostrando apenas a fundação da plataforma. Login e ferramentas locais aparecem quando a demonstração estiver habilitada.</p></div>
            </section>
          )}

          {demoEnabled && authState === "checking" && (
            <section className="notice-card" role="status"><Clock3 size={17} /><p>Verificando sua sessão segura…</p></section>
          )}

          {demoEnabled && authState === "error" && (
            <section className="notice-card error-card" role="alert">
              <AlertCircle size={18} /><div><h2>Não foi possível verificar a sessão</h2><p>{authProblem}</p><button className="secondary-button" type="button" onClick={() => void retrySessionCheck()}>Tentar novamente</button></div>
            </section>
          )}

          {demoEnabled && authState === "anonymous" && (
            <section className="login-layout" aria-labelledby="login-title">
              <form className="panel login-card" onSubmit={(event) => void submitLogin(event)}>
                <div className="panel-heading"><span className="panel-icon"><ShieldCheck size={18} /></span><div><p className="section-kicker">AMBIENTE LOCAL</p><h2 id="login-title">Entre na sua conta</h2></div></div>
                <p className="muted-copy">Use uma conta autorizada para acessar as empresas vinculadas ao seu perfil.</p>
                {authProblem && <div className="inline-alert warning" role="status">{authProblem}</div>}
                {loginError && <div className="inline-alert error" role="alert">{loginError}</div>}
                <label className="field-label" htmlFor="login-email">E-mail</label>
                <input id="login-email" type="email" autoComplete="username" required value={email} onChange={(event) => setEmail(event.target.value)} disabled={writeBusy} />
                <label className="field-label" htmlFor="login-password">Senha</label>
                <input id="login-password" type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} disabled={writeBusy} />
                <button className="primary-button full-button" type="submit" disabled={writeBusy}><ShieldCheck size={16} />{writeBusy ? "Entrando…" : "Entrar"}</button>
                <p className="form-footnote">Sua sessão fica protegida neste navegador. Os dados de acesso não são salvos.</p>
              </form>
              <aside className="panel demo-accounts" aria-label="Contas de demonstração">
                <div className="panel-heading"><span className="panel-icon mint"><Sparkles size={18} /></span><div><p className="section-kicker">ACESSO DE TESTE</p><h2>Contas de demonstração</h2></div></div>
                <p className="muted-copy">O modo local está habilitado nesta instalação.</p>
                <div className="account-list">
                  <DemoAccount email="admin@atende.local" role="Admin de plataforma e empresas" onUse={() => { setEmail("admin@atende.local"); setPassword("AtendeLocal123!"); }} />
                  <DemoAccount email="pizzaria@atende.local" role="Atendente · Pizzaria Demo" onUse={() => { setEmail("pizzaria@atende.local"); setPassword("AtendeLocal123!"); }} />
                  <DemoAccount email="barbearia@atende.local" role="Atendente · Barbearia Demo" onUse={() => { setEmail("barbearia@atende.local"); setPassword("AtendeLocal123!"); }} />
                </div>
                <div className="demo-password"><span>Senha comum</span><code>AtendeLocal123!</code></div>
              </aside>
            </section>
          )}

          {demoEnabled && authState === "authenticated" && session && (
            <>
              <div className="demo-banner" role="note"><Sparkles size={16} /><span><strong>Demonstração local</strong> · {persistentLocal ? "Dados salvos nesta máquina" : "Dados voláteis"} · {info.value?.outboundMode === "cloud-api-local-test" ? "Envio de teste restrito ao canal e aos destinatários autorizados." : "Respostas simuladas; nada é enviado ao WhatsApp."} · {info.value?.localAiEnabled ? "IA local habilitada." : "Sem IA local."}</span></div>
              {authProblem && <div className="inline-alert warning" role="status">{authProblem}</div>}
              {(tenantLoading || tenantError) && <div className={tenantError ? "inline-alert error" : "inline-alert"} role={tenantError ? "alert" : "status"}>{tenantError || "Carregando empresas permitidas…"}</div>}

              <section className="overview-section" aria-label="Contagem de conversas">
                <div className="section-title-row"><div><p className="section-kicker">OPERAÇÃO</p><h2>Resumo da fila</h2></div><span className={`poll-indicator realtime-${realtimeState}`}><i className="status-dot" />{realtimeState === "connected" ? "Atualizações em tempo real" : realtimeState === "reconnecting" ? "Reconectando à fila…" : "Conectando à fila…"}</span></div>
                <div className="metrics-grid">
                  <MetricCard label="Total de conversas" value={conversations.length} icon={<MessageCircle size={18} />} tone="green" />
                  <MetricCard label="Aguardando pessoa" value={waitingCount} icon={<Headset size={18} />} tone="amber" />
                  <MetricCard label="Em atendimento" value={activeCount} icon={<UserRound size={18} />} tone="violet" />
                  <MetricCard label="Automação ativa" value={botCount} icon={<Bot size={18} />} tone="mint" />
                  <MetricCard label="Encerradas" value={closedCount} icon={<Check size={18} />} tone="green" />
                </div>
              </section>

              {isPlatformAdmin && <section className="section-block" aria-labelledby="tenant-create-title">
                {!showCreateTenant ? (
                  <button className="quiet-action" type="button" onClick={() => { setShowCreateTenant(true); setCreateTenantError(""); }} disabled={writeBusy}><Plus size={15} /> Cadastrar empresa</button>
                ) : (
                  <form className="panel create-tenant-form" onSubmit={(event) => void createTenant(event)}>
                    <div className="panel-heading"><span className="panel-icon"><Plus size={18} /></span><div><p className="section-kicker">ADMINISTRAÇÃO</p><h2 id="tenant-create-title">Cadastrar empresa local</h2></div></div>
                    <div className="form-grid two-columns">
                      <div><label className="field-label" htmlFor="tenant-name">Nome da empresa</label><input id="tenant-name" value={newTenantName} onChange={(event) => setNewTenantName(event.target.value)} required maxLength={100} disabled={writeBusy} /></div>
                      <div><label className="field-label" htmlFor="tenant-segment">Segmento</label><select id="tenant-segment" value={newTenantSegment} onChange={(event) => setNewTenantSegment(event.target.value as Tenant["segment"])} disabled={writeBusy}><option value="pizzaria">Pizzaria</option><option value="barbearia">Barbearia</option><option value="outro">Outro</option></select></div>
                    </div>
                    <p className="form-footnote">Será criado um canal de demonstração e seu perfil terá acesso de administração à empresa.</p>
                    {createTenantError && <div className="inline-alert error" role="alert">{createTenantError}</div>}
                    <div className="form-actions"><button className="secondary-button" type="button" onClick={() => setShowCreateTenant(false)} disabled={writeBusy}>Cancelar</button><button className="primary-button" type="submit" disabled={writeBusy || !newTenantName.trim()}>{writeBusy ? "Cadastrando…" : "Cadastrar empresa"}</button></div>
                  </form>
                )}
              </section>}

              {activeTenant && (
                <>
                  <section className="queue-card" id="atendimento" aria-labelledby="queue-title">
                    <div className="queue-header"><div><p className="section-kicker">ATENDIMENTO</p><h2 id="queue-title">Fila de conversas</h2></div><span className="queue-count">{filteredConversations.length} {filteredConversations.length === 1 ? "conversa" : "conversas"}</span></div>
                    <div className="queue-toolbar">
                      <label className="filter-label" htmlFor="queue-filter">Filtrar por estado</label>
                      <select id="queue-filter" value={queueFilter} onChange={(event) => setQueueFilter(event.target.value as QueueFilter)}>
                        <option value="ALL">Todos os estados</option><option value="WAITING_HUMAN">Aguardando pessoa</option><option value="HUMAN_ACTIVE">Em atendimento</option><option value="BOT_ACTIVE">Automação ativa</option><option value="CLOSED">Encerradas</option>
                      </select>
                      <span className="queue-updated" role="status">{conversationsLoading ? "Atualizando…" : queueError ? "Atualização com erro" : "Atualizada"}</span>
                      <button className="icon-button refresh-button" type="button" onClick={() => void refreshQueue(activeTenantId, scopeRef.current)} aria-label="Atualizar fila" title="Atualizar fila"><RefreshCw size={15} /></button>
                    </div>
                    {queueError && <div className="inline-alert error" role="alert">{queueError}</div>}
                    <div className="queue-workspace">
                      <div className="conversation-list" aria-label="Conversas">
                        {conversationsLoading && conversations.length === 0 && <div className="list-empty"><Clock3 size={17} /> Carregando conversas…</div>}
                        {!conversationsLoading && filteredConversations.length === 0 && (
                          <div className="list-empty"><span className="empty-icon small"><ArrowDownLeft size={18} /></span><strong>Nenhuma conversa neste filtro</strong><span>Novas mensagens simuladas aparecerão aqui.</span></div>
                        )}
                        {filteredConversations.map((conversation) => (
                          <button
                            className={`conversation-row ${selectedConversationId === conversation.id ? "selected" : ""}`}
                            key={conversation.id}
                            type="button"
                            onClick={() => void selectConversation(conversation)}
                            aria-pressed={selectedConversationId === conversation.id}
                          >
                            <span className="conversation-avatar">{initials(conversation.customerName)}</span>
                            <span className="conversation-copy"><span className="conversation-title"><strong>{conversation.customerName}</strong><time>{formatDate(conversation.updatedAt)}</time></span><span className="conversation-preview">{conversation.lastMessagePreview || "Sem mensagens"}</span><span className="conversation-meta"><span className={`state-pill state-${conversation.state.toLowerCase()}`}>{stateLabels[conversation.state]}</span>{conversation.state === "WAITING_HUMAN" && <span className="new-human-pill">Nova solicitação humana</span>}</span></span>
                          </button>
                        ))}
                      </div>
                      <ConversationPanel
                        detail={selectedDetail}
                        loading={detailLoading}
                        error={detailError}
                        actionError={actionError}
                        sessionUserId={session.user.id}
                        ownsConversation={ownsConversation}
                        replyText={replyText}
                        onReplyText={setReplyText}
                        onReply={(event) => void submitReply(event)}
                        onAction={(action) => void updateConversation(action)}
                        writeBusy={writeBusy}
                        outboundEnabled={info.value?.outboundMode === "cloud-api-local-test"}
                      />
                    </div>
                  </section>

                  <section className="panel config-panel" id="configuracao" aria-labelledby="config-title">
                    <div className="panel-heading"><span className="panel-icon violet"><Settings2 size={18} /></span><div><p className="section-kicker">CONFIGURAÇÃO</p><h2 id="config-title">Atendimento da empresa</h2></div><span className="version-tag">{config ? `v${config.version}` : "—"}</span></div>
                    {!isTenantAdmin && <div className="readonly-note"><ShieldCheck size={15} /> Configuração somente para leitura. Um administrador da empresa pode editar estes campos.</div>}
                    {configLoading && <p className="muted-copy">Carregando configuração…</p>}
                    {configError && <div className="inline-alert error" role="alert">{configError}{configConflict && <button className="text-button" type="button" onClick={() => void loadConfig(activeTenantId, scopeRef.current)} disabled={writeBusy}>Recarregar configuração</button>}</div>}
                    {config && <form onSubmit={(event) => void saveConfig(event)}>
                      <div className="form-grid two-columns">
                        <div><label className="field-label" htmlFor="business-name">Nome comercial</label><input id="business-name" value={config.businessName} onChange={(event) => updateConfig("businessName", event.target.value)} disabled={!isTenantAdmin || writeBusy} required maxLength={100} /></div>
                        <div><label className="field-label" htmlFor="config-segment">Segmento</label><select id="config-segment" value={config.segment} onChange={(event) => updateConfig("segment", event.target.value as TenantConfig["segment"])} disabled={!isTenantAdmin || writeBusy}><option value="pizzaria">Pizzaria</option><option value="barbearia">Barbearia</option><option value="outro">Outro</option></select></div>
                      </div>
                      <label className="field-label" htmlFor="assistant-mode">Interpretação das mensagens</label>
                      <select
                        id="assistant-mode"
                        value={config.assistantMode}
                        onChange={(event) => updateConfig("assistantMode", event.target.value as TenantConfig["assistantMode"])}
                        disabled={!isTenantAdmin || writeBusy}
                      >
                        <option value="approved_faq">Respostas cadastradas (sem IA)</option>
                        <option value="local_ai" disabled={!info.value?.localAiEnabled && config.assistantMode !== "local_ai"}>IA local (Ollama)</option>
                      </select>
                      <p className="muted-copy">
                        {config.assistantMode === "local_ai"
                          ? info.value?.localAiEnabled
                            ? "O modelo local só escolhe uma resposta cadastrada; se não encontrar uma resposta segura ou o modelo falhar, a conversa vai para uma pessoa."
                            : "A IA local não está habilitada neste servidor. Sem ela, perguntas que não coincidam exatamente com a FAQ serão encaminhadas a uma pessoa."
                          : "Sem IA, somente perguntas iguais às cadastradas recebem resposta automática; as demais vão para uma pessoa."}
                      </p>
                      <label className="field-label" htmlFor="greeting">Saudação</label>
                      <textarea id="greeting" rows={3} value={config.greeting} onChange={(event) => updateConfig("greeting", event.target.value)} disabled={!isTenantAdmin || writeBusy} required maxLength={1000} />
                      <div className="subsection-heading"><div><h3>Respostas autorizadas</h3><p>O modo local usa estas respostas ou transfere a conversa para uma pessoa.</p></div>{isTenantAdmin && <button className="secondary-button compact" type="button" onClick={addKnowledge} disabled={writeBusy}><Plus size={14} /> Adicionar</button>}</div>
                      <div className="knowledge-list">
                        {config.knowledge.map((item, index) => <div className="knowledge-row" key={`knowledge-${index}`}>
                          <div><label className="field-label" htmlFor={`knowledge-q-${index}`}>Pergunta reconhecida</label><input id={`knowledge-q-${index}`} value={item.question} onChange={(event) => updateKnowledge(index, "question", event.target.value)} disabled={!isTenantAdmin || writeBusy} required maxLength={300} /></div>
                          <div><label className="field-label" htmlFor={`knowledge-a-${index}`}>Resposta autorizada</label><textarea id={`knowledge-a-${index}`} rows={2} value={item.answer} onChange={(event) => updateKnowledge(index, "answer", event.target.value)} disabled={!isTenantAdmin || writeBusy} required maxLength={1000} /></div>
                          {isTenantAdmin && <button className="icon-button remove-knowledge" type="button" onClick={() => removeKnowledge(index)} disabled={writeBusy} aria-label={`Remover pergunta ${index + 1}`} title="Remover"><X size={16} /></button>}
                        </div>)}
                        {config.knowledge.length === 0 && <p className="muted-copy">Nenhuma resposta autorizada cadastrada.</p>}
                      </div>
                      <label className="field-label" htmlFor="handoff-keywords">Termos que solicitam atendimento humano</label>
                      <input id="handoff-keywords" value={handoffKeywordsText} onChange={(event) => { setHandoffKeywordsText(event.target.value); updateConfig("handoffKeywords", event.target.value.split(",").map((keyword) => keyword.trim()).filter(Boolean)); }} disabled={!isTenantAdmin || writeBusy} placeholder="ex.: atendente, pessoa, falar com alguém" />
                      <div className="config-footer">
                        <span className="form-footnote">Versão {config.version} · mudanças feitas em outra sessão serão detectadas ao salvar.</span>
                        {configNotice && <span className="success-note" role="status"><Check size={14} />{configNotice}</span>}
                        {isTenantAdmin && <button className="primary-button" type="submit" disabled={writeBusy}>{writeBusy ? "Salvando…" : "Salvar configuração"}</button>}
                      </div>
                    </form>}
                  </section>

                  <section className="panel simulator-panel" id="simulador" aria-labelledby="simulator-title">
                    <div className="panel-heading"><span className="panel-icon coral"><MessageSquareText size={18} /></span><div><p className="section-kicker">SIMULADOR LOCAL</p><h2 id="simulator-title">Receber mensagem de teste</h2></div><span className="sim-status">Fila local</span></div>
                    <p className="muted-copy">A mensagem será processada no ambiente local. Nenhum pedido ou agendamento é confirmado.</p>
                    <form onSubmit={(event) => void submitSimulation(event)}>
                      <div className="form-grid two-columns">
                        <div><label className="field-label" htmlFor="customer-name">Nome da pessoa</label><input id="customer-name" value={customerName} onChange={(event) => setCustomerName(event.target.value)} required maxLength={100} disabled={writeBusy} /></div>
                        <div><label className="field-label" htmlFor="customer-phone">Telefone</label><div className="input-with-icon"><Phone size={15} /><input id="customer-phone" type="tel" inputMode="tel" value={customerPhone} onChange={(event) => setCustomerPhone(event.target.value)} required maxLength={30} disabled={writeBusy} /></div></div>
                      </div>
                      <label className="field-label" htmlFor="customer-message">Mensagem</label>
                      <textarea id="customer-message" rows={3} value={customerText} onChange={(event) => setCustomerText(event.target.value)} required maxLength={2000} disabled={writeBusy} placeholder="Escreva a mensagem de teste…" />
                      {simulatorError && <div className="inline-alert error" role="alert">{simulatorError}</div>}
                      {simulatorNotice && <div className="inline-alert success" role="status">{simulatorNotice}</div>}
                      <div className="form-actions"><span className="form-footnote">Atualização automática da fila a cada 2 segundos.</span><button className="primary-button" type="submit" disabled={writeBusy || !customerName.trim() || !customerPhone.trim() || !customerText.trim()}><Send size={15} />{writeBusy ? "Enviando…" : "Simular mensagem"}</button></div>
                    </form>
                  </section>
                </>
              )}

              <footer className="footer"><span>Atende <span className="brand-dot">·</span> Plataforma de atendimento</span><span>{info.state === "ok" ? `Versão ${info.value?.version}` : "Versão indisponível"}</span></footer>
            </>
          )}

          {(!demoEnabled || authState !== "authenticated") && <footer className="footer foundation-footer"><span>Atende <span className="brand-dot">·</span> Plataforma de atendimento</span><span>{info.state === "ok" ? `Versão ${info.value?.version}` : info.state === "error" ? "Versão indisponível" : "Consultando versão…"}</span></footer>}
        </div>
      </main>
      {demoEnabled && <a className="floating-help" href="#simulador" aria-label="Abrir simulador de mensagens"><Sparkles size={18} /></a>}
    </div>
  );
}

function MetricCard({ label, value, icon, tone }: { label: string; value: number; icon: ReactNode; tone: string }) {
  return <div className="metric-card"><span className={`metric-icon ${tone}`}>{icon}</span><span className="metric-copy"><strong>{value}</strong><small>{label}</small></span></div>;
}

function DemoAccount({ email, role, onUse }: { email: string; role: string; onUse: () => void }) {
  return <div className="account-row"><span className="account-avatar"><UserRound size={16} /></span><span className="account-copy"><strong>{email}</strong><small>{role}</small></span><button className="use-account" type="button" onClick={onUse}>Usar</button></div>;
}

function ConversationPanel({
  detail,
  loading,
  error,
  actionError,
  sessionUserId,
  ownsConversation,
  replyText,
  onReplyText,
  onReply,
  onAction,
  writeBusy,
  outboundEnabled,
}: {
  detail: ConversationDetail | null;
  loading: boolean;
  error: string;
  actionError: string;
  sessionUserId: string;
  ownsConversation: boolean;
  replyText: string;
  onReplyText: (value: string) => void;
  onReply: (event: FormEvent<HTMLFormElement>) => void;
  onAction: (action: "handoff" | "claim" | "close" | "resume") => void;
  writeBusy: boolean;
  outboundEnabled: boolean;
}) {
  const conversation = detail?.conversation;
  const canReply = conversation?.state === "HUMAN_ACTIVE" && ownsConversation;
  const canClose = conversation?.state === "HUMAN_ACTIVE" && ownsConversation;
  const canResume = conversation?.state === "WAITING_HUMAN" || (conversation?.state === "HUMAN_ACTIVE" && ownsConversation);

  return <section className="conversation-detail" aria-label="Detalhes da conversa" aria-live="polite">
    {!conversation && !loading && !error && <div className="detail-placeholder"><span className="empty-icon"><MessageCircle size={21} /></span><h3>Selecione uma conversa</h3><p>O histórico e as ações disponíveis aparecerão aqui.</p></div>}
    {loading && <div className="detail-placeholder"><Clock3 size={18} /><p>Carregando histórico…</p></div>}
    {error && <div className="inline-alert error detail-alert" role="alert">{error}</div>}
    {conversation && detail && <>
      <header className="detail-header">
        <span className="conversation-avatar large">{initials(conversation.customerName)}</span>
        <div className="detail-person"><strong>{conversation.customerName}</strong><span>{conversation.customerPhone}</span></div>
        <span className={`state-pill state-${conversation.state.toLowerCase()}`}>{stateLabels[conversation.state]}</span>
      </header>
      <div className="detail-subline"><span>Atualizada {formatDate(conversation.updatedAt, true)}</span>{conversation.assignedUserId && <span>{ownsConversation ? "Atribuída a você" : `Responsável: ${conversation.assignedUserId === sessionUserId ? "você" : "outra pessoa"}`}</span>}</div>
      {actionError && <div className="inline-alert error detail-alert" role="alert">{actionError}</div>}
      <div className="message-history" aria-label="Histórico de mensagens">
        {detail.messages.length === 0 && <p className="muted-copy">Esta conversa ainda não tem mensagens.</p>}
        {detail.messages.map((message) => <article className={`message-bubble message-${message.role.toLowerCase()}`} key={message.id}>
          <div className="message-meta"><span>{message.role === "CUSTOMER" ? conversation.customerName : message.authorName ?? (message.role === "BOT" ? "Assistente local" : "Atendente")}</span><time>{formatDate(message.createdAt)}</time></div>
          <p>{message.text}</p>
          {message.deliveryStatus !== "RECEIVED" && <span className="simulated-tag">{deliveryStatusLabel(message.deliveryStatus)}</span>}
        </article>)}
      </div>
      <div className="detail-actions">
        {conversation.state === "BOT_ACTIVE" && <button className="secondary-button" type="button" onClick={() => onAction("handoff")} disabled={writeBusy}><Headset size={15} />Transferir para pessoa</button>}
        {conversation.state === "WAITING_HUMAN" && <button className="primary-button" type="button" onClick={() => onAction("claim")} disabled={writeBusy}><UserRound size={15} />{writeBusy ? "Assumindo…" : "Assumir atendimento"}</button>}
        {canResume && <button className="secondary-button" type="button" onClick={() => onAction("resume")} disabled={writeBusy}><Bot size={15} />Retomar automação</button>}
        {canClose && <button className="quiet-action close-action" type="button" onClick={() => onAction("close")} disabled={writeBusy}><Check size={15} />Encerrar</button>}
      </div>
      {conversation.state === "HUMAN_ACTIVE" && !ownsConversation && <p className="readonly-note"><ShieldCheck size={15} />Esta conversa está atribuída a outra pessoa. Só ela pode responder, encerrar ou retomá-la.</p>}
      {canReply ? <form className="reply-form" onSubmit={onReply}>
        <label className="visually-hidden" htmlFor="reply-message">Sua resposta</label>
        <textarea id="reply-message" rows={2} value={replyText} onChange={(event) => onReplyText(event.target.value)} placeholder="Escreva uma resposta…" disabled={writeBusy} />
        <button className="send-button" type="submit" aria-label={outboundEnabled ? "Enviar resposta ao WhatsApp de teste" : "Registrar resposta simulada"} title={outboundEnabled ? "Enviar resposta ao WhatsApp de teste" : "Registrar resposta simulada"} disabled={writeBusy || !replyText.trim()}><Send size={17} /></button>
        <span className="reply-note">{outboundEnabled ? "Envio de teste ativo; somente canal e destinatários autorizados podem receber. Aceite pela Meta não confirma entrega." : "Resposta registrada como simulada; nada será enviado ao WhatsApp."}</span>
      </form> : conversation.state === "HUMAN_ACTIVE" && ownsConversation ? null : conversation.state === "CLOSED" ? <p className="readonly-note"><Check size={15} />Conversa encerrada.</p> : null}
    </>}
  </section>;
}

function deliveryStatusLabel(status: Message["deliveryStatus"]): string {
  switch (status) {
    case "SIMULATED": return "Resposta simulada; não enviada";
    case "PENDING": return "Aguardando envio";
    case "SENDING": return "Enviando";
    case "ACCEPTED": return "Aceita pela Meta; entrega não confirmada";
    case "BLOCKED": return "Envio bloqueado pela política";
    case "HTTP_ERROR": return "Falha no envio";
    case "INDETERMINATE": return "Sem confirmação; não repetir automaticamente";
    case "RECEIVED": return "Recebida";
  }
}

export default App;
