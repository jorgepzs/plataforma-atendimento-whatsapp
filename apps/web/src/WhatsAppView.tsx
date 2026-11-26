import { useEffect, useState, type FormEvent } from "react";
import { QrCode, Wifi } from "lucide-react";
import { ApiError, apiRequest, formatApiError, tenantPath, type Session, type WhatsAppAntiBan, type WhatsAppUsage } from "./api";
import { useToast } from "./feedback";
import { Badge, Button, ConfirmDialog, Skeleton } from "./ui";

type ProviderId = "unofficial_qr" | "meta_cloud";

export interface WhatsAppChannelView {
  enabled: boolean;
  provider?: ProviderId;
  status?: string;
  halted?: boolean;
  haltReason?: string | null;
  phoneMasked?: string | null;
  pairedAt?: string | null;
  lastError?: string | null;
  qrAvailable?: boolean;
  qrDataUrl?: string | null;
  metaConfigured?: boolean;
  proactiveEnabled?: boolean;
  message?: string;
  antiBan?: WhatsAppAntiBan;
  usage?: WhatsAppUsage;
}

const statusLabels: Record<string, string> = {
  disconnected: "Desconectado",
  qr_pending: "Aguardando QR",
  connecting: "Conectando",
  connected: "Conectado",
  reconnecting: "Reconectando",
  logged_out: "Sessão encerrada",
  banned: "Número restrito",
  restricted: "Envio restrito",
  session_replaced: "Outra sessão assumiu",
  failed: "Falha na sessão"
};

const haltCopy: Record<string, { title: string; body: string }> = {
  banned: {
    title: "O WhatsApp restringiu este número",
    body: "Não reconecte agora. Uma nova tentativa de pareamento pode piorar o bloqueio. Use o celular só se o aplicativo ainda abrir, e evite disparos."
  },
  restricted: {
    title: "O envio está limitado",
    body: "Responda apenas quem escreveu primeiro, com intervalo, e pare qualquer envio em massa."
  },
  session_locked: {
    title: "Esta sessão já está em uso",
    body: "Outro processo segurou o arquivo da sessão. Deixe apenas uma instância do servidor ligada."
  },
  duplicate_number: {
    title: "Número pareado em outra empresa",
    body: "Desconecte o WhatsApp na outra empresa antes de usar este chip aqui."
  }
};

export function WhatsAppView({
  tenantId,
  session,
  isAdmin,
  onSessionExpired
}: {
  tenantId: string;
  session: Session;
  isAdmin: boolean;
  onSessionExpired: () => void;
}) {
  const toast = useToast();
  const [view, setView] = useState<WhatsAppChannelView | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [provider, setProvider] = useState<ProviderId>("unofficial_qr");
  const [proactive, setProactive] = useState(false);
  const [metaPhoneNumberId, setMetaPhoneNumberId] = useState("");
  const [metaAccessToken, setMetaAccessToken] = useState("");
  const [logoutOpen, setLogoutOpen] = useState(false);
  const [qrStarted, setQrStarted] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    apiRequest<WhatsAppChannelView>(tenantPath(tenantId, "whatsapp")).then((status) => {
      if (cancelled) return;
      setView(status);
      if (status.provider) setProvider(status.provider);
      setProactive(Boolean(status.proactiveEnabled));
    }).catch((reason: unknown) => {
      if (reason instanceof ApiError && reason.status === 401) onSessionExpired();
      else if (!cancelled) setError(formatApiError(reason));
    });
    return () => { cancelled = true; };
  }, [tenantId, onSessionExpired]);

  useEffect(() => {
    if (!view?.enabled) return undefined;
    const pairing = view.status === "qr_pending" || view.status === "connecting" || view.status === "reconnecting" || view.qrAvailable;
    const timer = window.setInterval(() => {
      const path = pairing && isAdmin ? "whatsapp/qr" : "whatsapp";
      apiRequest<WhatsAppChannelView>(tenantPath(tenantId, path)).then((next) => setView(next)).catch((reason: unknown) => {
        if (reason instanceof ApiError && reason.status === 401) onSessionExpired();
      });
    }, 3000);
    return () => window.clearInterval(timer);
  }, [tenantId, isAdmin, view?.enabled, view?.status, view?.qrAvailable, onSessionExpired]);

  useEffect(() => {
    if (view?.qrDataUrl) setQrStarted(Date.now());
  }, [view?.qrDataUrl]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  async function run(action: "connect" | "disconnect" | "logout") {
    setBusy(true);
    setError("");
    try {
      const next = await apiRequest<WhatsAppChannelView>(tenantPath(tenantId, `whatsapp/${action}`), {
        method: "POST",
        csrfToken: session.csrfToken
      });
      setView(next);
      setLogoutOpen(false);
      toast(action === "connect" ? "Pareamento iniciado. Leia o QR no celular." : "Sessão atualizada.");
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

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const next = await apiRequest<WhatsAppChannelView>(tenantPath(tenantId, "whatsapp"), {
        method: "PUT",
        csrfToken: session.csrfToken,
        body: {
          provider,
          proactiveEnabled: proactive,
          ...(provider === "meta_cloud" && metaPhoneNumberId ? { metaPhoneNumberId } : {}),
          ...(provider === "meta_cloud" && metaAccessToken ? { metaAccessToken } : {})
        }
      });
      setMetaAccessToken("");
      setView(next);
      toast("Canal salvo. O token da Meta não volta na resposta.");
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

  if (!view && !error) return <Skeleton className="card" />;
  const usage = view?.usage;
  const cap = usage?.effectiveDailyCap ?? view?.antiBan?.warmupDailyCap ?? view?.antiBan?.dailyCap ?? 0;
  const sent = usage?.sentToday ?? 0;
  const ratio = cap > 0 ? Math.min(100, Math.round((sent / cap) * 100)) : 0;
  const remaining = qrStarted ? Math.max(0, 20 - Math.floor((now - qrStarted) / 1000)) : 20;
  const halt = view?.haltReason ? haltCopy[view.haltReason] : undefined;
  const connected = view?.status === "connected" && !view.halted;

  return (
    <div className="settings-grid">
      {error && <div className="banner bad" role="alert">{error}</div>}
      <section className="section-card whatsapp-hero">
        <div className="split-line">
          <div>
            <p className="kicker"><Wifi size={14} /> WhatsApp</p>
            <h2>{view?.enabled ? statusLabels[view.status ?? ""] ?? "Sem status" : "Canal desligado"}</h2>
            <p>{presentPhone(view?.phoneMasked)}</p>
          </div>
          <Badge tone={!view?.enabled ? "neutral" : view.halted ? "bad" : connected ? "ok" : "wait"}>
            {!view?.enabled ? "Desligado" : view.halted ? "Interrompido" : connected ? "Conectado" : "Atenção"}
          </Badge>
        </div>
        {!view?.enabled && <p>O pareamento por QR fica desligado até WHATSAPP_CHANNEL_ENABLED=true. Sem isso, nada é enviado ao WhatsApp.</p>}
        {view?.enabled && <p>O bot só responde quem escreveu primeiro. Não existe disparo em massa.</p>}
        {isAdmin && view?.enabled && (
          <div className="dialog-actions">
            <Button disabled={busy || view.haltReason === "banned"} onClick={() => void run("connect")}>Parear / reconectar</Button>
            <Button variant="secondary" disabled={busy} onClick={() => void run("disconnect")}>Desconectar</Button>
            <Button variant="danger" disabled={busy} onClick={() => setLogoutOpen(true)}>Encerrar sessão</Button>
          </div>
        )}
      </section>
      {view?.enabled && (view.qrDataUrl || view.status === "qr_pending") && (
        <section className="section-card qr-card">
          <h2>Ler o QR</h2>
          <p>No celular: WhatsApp, Aparelhos conectados, Conectar aparelho.</p>
          {view.qrDataUrl ? (
            <img className="qr" alt="QR Code para parear o WhatsApp desta empresa" src={view.qrDataUrl} />
          ) : (
            <p className="muted"><QrCode size={16} /> Gerando o QR…</p>
          )}
          <p className="countdown" role="status">{remaining > 0 ? `Este QR atualiza em ${remaining}s` : "Aguardando o próximo QR…"}</p>
        </section>
      )}
      {view?.enabled && (
        <section className="section-card">
          <h2>Proteção do número</h2>
          <div className="meter" aria-label="Mensagens enviadas hoje">
            <div style={{ width: `${ratio}%` }} />
          </div>
          <p><strong>{sent}</strong> de <strong>{cap || "—"}</strong> mensagens hoje{usage?.inWarmup ? " (teto de aquecimento)" : ""}.</p>
          <p>Aquecimento dia {usage?.warmupDay ?? 1} de {usage?.warmupDays ?? view.antiBan?.warmupDays ?? 7}{view.pairedAt ? "" : ". Ainda sem data de pareamento, o teto menor continua valendo."}</p>
        </section>
      )}
      {halt && (
        <section className="section-card halt">
          <h2>{halt.title}</h2>
          <p>{halt.body}</p>
        </section>
      )}
      {view?.enabled && isAdmin && (
        <form className="section-card stack" onSubmit={(event) => void save(event)}>
          <h2>Provedor</h2>
          <label className="field">
            <span>Como conectar</span>
            <select value={provider} disabled={busy} onChange={(event) => setProvider(event.target.value as ProviderId)}>
              <option value="unofficial_qr">QR não oficial (Baileys)</option>
              <option value="meta_cloud">API oficial da Meta</option>
            </select>
          </label>
          <label className="check-line">
            <input type="checkbox" checked={proactive} disabled={busy} onChange={(event) => setProactive(event.target.checked)} />
            Permitir avisos para contatos com opt-in
          </label>
          {provider === "meta_cloud" && (
            <>
              <label className="field">
                <span>Phone number ID</span>
                <input inputMode="numeric" autoComplete="off" value={metaPhoneNumberId} disabled={busy} onChange={(event) => setMetaPhoneNumberId(event.target.value)} />
              </label>
              <label className="field">
                <span>Token de acesso</span>
                <input type="password" autoComplete="off" value={metaAccessToken} disabled={busy} placeholder={view.metaConfigured ? "Deixe em branco para manter o token salvo" : ""} onChange={(event) => setMetaAccessToken(event.target.value)} />
              </label>
            </>
          )}
          <Button type="submit" variant="secondary" disabled={busy}>Salvar canal</Button>
        </form>
      )}
      <ConfirmDialog
        open={logoutOpen}
        title="Encerrar sessão do WhatsApp"
        body="O celular deixa de estar pareado. Será preciso ler um QR novo para voltar a enviar."
        confirmLabel="Encerrar sessão"
        danger
        busy={busy}
        onClose={() => setLogoutOpen(false)}
        onConfirm={() => void run("logout")}
      />
    </div>
  );
}

function presentPhone(phone: string | null | undefined): string {
  if (!phone) return "Nenhum número pareado";
  const tail = phone.replace(/\D/g, "").slice(-4);
  return tail ? `Número •••• ${tail}` : phone;
}
