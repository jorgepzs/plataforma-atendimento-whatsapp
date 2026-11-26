import { useEffect, useState, type FormEvent } from "react";
import { MessageCircle, UserRound } from "lucide-react";
import { ApiError, apiRequest, formatApiError, type Session, type Tenant } from "./api";
import { Button } from "./ui";
import { Workspace } from "./Workspace";

type SystemInfo = {
  localDemoEnabled?: boolean;
  eventStore?: string;
  outboundMode?: string;
  llm?: { enabled: boolean; provider?: string; model?: string };
};

type AuthState = "checking" | "anonymous" | "authenticated" | "error" | "disabled";

function channelHint(info: SystemInfo | null): string {
  if (info?.outboundMode === "unofficial-qr") return "canal QR";
  if (info?.outboundMode === "meta-cloud") return "canal oficial";
  if (info?.llm?.enabled && info.llm.model) return info.llm.model;
  return "respostas simuladas";
}

function App() {
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [infoError, setInfoError] = useState("");
  const [authState, setAuthState] = useState<AuthState>("checking");
  const [session, setSession] = useState<Session | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [busy, setBusy] = useState(false);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [activeTenantId, setActiveTenantId] = useState("");

  useEffect(() => {
    let active = true;
    apiRequest<SystemInfo>("/api/v1/system/info").then(async (systemInfo) => {
      if (!active) return;
      setInfo(systemInfo);
      if (systemInfo.localDemoEnabled !== true) {
        setAuthState("disabled");
        return;
      }
      try {
        const current = await apiRequest<Session>("/api/v1/auth/me");
        if (!active) return;
        setSession(current);
        setAuthState("authenticated");
      } catch (error) {
        if (!active) return;
        setAuthState(error instanceof ApiError && error.status === 401 ? "anonymous" : "error");
        if (!(error instanceof ApiError && error.status === 401)) setInfoError(formatApiError(error));
      }
    }).catch((error: unknown) => {
      if (!active) return;
      setAuthState("disabled");
      setInfoError(formatApiError(error));
    });
    return () => { active = false; };
  }, []);

  function loadTenants(current: Session) {
    apiRequest<{ tenants: Tenant[] }>("/api/v1/tenants").then(({ tenants: available }) => {
      setTenants(available);
      setActiveTenantId((currentId) => available.some((tenant) => tenant.id === currentId) ? currentId : available[0]?.id ?? "");
    }).catch((error: unknown) => {
      if (error instanceof ApiError && error.status === 401) expire();
      else setInfoError(formatApiError(error));
    });
    void current;
  }

  useEffect(() => {
    if (!session) return;
    loadTenants(session);
  }, [session?.user.id]);

  function expire() {
    setSession(null);
    setTenants([]);
    setActiveTenantId("");
    setAuthState("anonymous");
    setPassword("");
    setLoginError("");
    setInfoError("Sua sessão expirou. Entre novamente.");
  }

  async function submitLogin(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setLoginError("");
    try {
      const result = await apiRequest<Session>("/api/v1/auth/login", {
        method: "POST",
        body: { email: email.trim(), password }
      });
      setSession(result);
      setAuthState("authenticated");
      setPassword("");
      setInfoError("");
    } catch (error) {
      setLoginError(formatApiError(error));
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    if (!session) return;
    setBusy(true);
    try {
      await apiRequest<void>("/api/v1/auth/logout", { method: "POST", csrfToken: session.csrfToken });
      setSession(null);
      setTenants([]);
      setActiveTenantId("");
      setAuthState("anonymous");
      setPassword("");
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) expire();
      else setInfoError(formatApiError(error));
    } finally {
      setBusy(false);
    }
  }

  if (authState === "authenticated" && session) {
    return (
      <Workspace
        session={session}
        tenants={tenants}
        activeTenantId={activeTenantId}
        onSwitchTenant={setActiveTenantId}
        onLogout={() => void logout()}
        onSessionExpired={expire}
        onTenantsChanged={() => loadTenants(session)}
        storageLabel={info?.eventStore === "sqlite" ? "SQLite" : "Memória"}
        channelHint={channelHint(info)}
      />
    );
  }

  return (
    <div className="auth">
      <div className="auth-card">
        <div className="brand"><span><MessageCircle size={16} /></span> atende</div>
        {infoError && <div className="banner bad" role="alert">{infoError}</div>}
        {authState === "checking" && <p className="muted">Verificando sessão…</p>}
        {authState === "disabled" && (
          <section className="section-card">
            <h2>Atendimento local desligado</h2>
            <p>Esta instalação não abriu o painel de operação.</p>
          </section>
        )}
        {authState === "error" && <Button variant="secondary" onClick={() => window.location.reload()}>Tentar de novo</Button>}
        {authState === "anonymous" && (
          <div className="auth-grid">
            <form className="section-card stack" onSubmit={(event) => void submitLogin(event)}>
              <h2>Entrar</h2>
              {loginError && <div className="banner bad" role="alert">{loginError}</div>}
              <label className="field" htmlFor="login-email"><span>E-mail</span>
                <input id="login-email" type="email" autoComplete="username" required value={email} onChange={(event) => setEmail(event.target.value)} disabled={busy} />
              </label>
              <label className="field" htmlFor="login-password"><span>Senha</span>
                <input id="login-password" type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} disabled={busy} />
              </label>
              <Button type="submit" disabled={busy}>{busy ? "Entrando…" : "Entrar"}</Button>
            </form>
            <aside className="section-card">
              <h2>Contas de demonstração</h2>
              <Demo email="admin@atende.local" role="Administração" onUse={() => { setEmail("admin@atende.local"); setPassword("AtendeLocal123!"); }} />
              <Demo email="pizzaria@atende.local" role="Pizzaria Demo" onUse={() => { setEmail("pizzaria@atende.local"); setPassword("AtendeLocal123!"); }} />
              <Demo email="barbearia@atende.local" role="Barbearia Demo" onUse={() => { setEmail("barbearia@atende.local"); setPassword("AtendeLocal123!"); }} />
              <p className="muted">Senha: AtendeLocal123!</p>
            </aside>
          </div>
        )}
      </div>
    </div>
  );
}

function Demo({ email, role, onUse }: { email: string; role: string; onUse: () => void }) {
  return (
    <div className="account-row">
      <span className="avatar"><UserRound size={15} /></span>
      <span><strong>{email}</strong><small>{role}</small></span>
      <button className="btn quiet sm" type="button" onClick={onUse}>Usar</button>
    </div>
  );
}

export default App;
