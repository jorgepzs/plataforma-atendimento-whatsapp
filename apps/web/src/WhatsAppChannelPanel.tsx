import { useEffect, useState, type FormEvent } from "react";
import { QrCode, Wifi } from "lucide-react";
import { apiRequest, tenantPath } from "./api";

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
}

const statusLabels: Record<string, string> = {
  disconnected: "Desconectado",
  qr_pending: "Aguardando leitura do QR",
  connecting: "Conectando",
  connected: "Conectado",
  reconnecting: "Reconectando",
  logged_out: "Sessão encerrada",
  banned: "Número banido ou restrito pelo WhatsApp",
  restricted: "Envio restrito pelo WhatsApp",
  session_replaced: "Outra sessão assumiu este número",
  failed: "Falha na sessão"
};

function statusText(view: WhatsAppChannelView): string {
  if (!view.enabled) return "Canal desligado neste servidor";
  if (view.haltReason === "banned") return "O envio foi interrompido. Não reconecte este número até entender o bloqueio.";
  if (view.haltReason === "session_locked") return "Outro processo já está usando esta sessão. Mantenha uma única instância.";
  if (view.haltReason === "duplicate_number") return "Este número já está pareado em outra empresa.";
  return statusLabels[view.status ?? ""] ?? "Sem status";
}

export function WhatsAppChannelPanel({
  tenantId,
  csrfToken,
  isAdmin
}: {
  tenantId: string;
  csrfToken: string;
  isAdmin: boolean;
}) {
  const [view, setView] = useState<WhatsAppChannelView | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [provider, setProvider] = useState<ProviderId>("unofficial_qr");
  const [proactive, setProactive] = useState(false);
  const [metaPhoneNumberId, setMetaPhoneNumberId] = useState("");
  const [metaAccessToken, setMetaAccessToken] = useState("");

  useEffect(() => {
    let cancelled = false;
    apiRequest<WhatsAppChannelView>(tenantPath(tenantId, "whatsapp")).then((status) => {
      if (cancelled) return;
      setView(status);
      if (status.provider) setProvider(status.provider);
      setProactive(Boolean(status.proactiveEnabled));
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : "Não foi possível consultar o canal.");
    });
    return () => { cancelled = true; };
  }, [tenantId]);

  useEffect(() => {
    if (!view?.enabled) return undefined;
    const pairing = view.status === "qr_pending" || view.status === "connecting" || view.status === "reconnecting" || view.qrAvailable;
    const timer = window.setInterval(() => {
      const path = pairing && isAdmin ? "whatsapp/qr" : "whatsapp";
      apiRequest<WhatsAppChannelView>(tenantPath(tenantId, path)).then((next) => {
        setView(next);
      }).catch(() => undefined);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [tenantId, isAdmin, view?.enabled, view?.status, view?.qrAvailable]);

  async function run(action: "connect" | "disconnect" | "logout"): Promise<void> {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const next = await apiRequest<WhatsAppChannelView>(tenantPath(tenantId, `whatsapp/${action}`), {
        method: "POST",
        csrfToken
      });
      setView(next);
      setNotice(action === "connect" ? "Pareamento iniciado. Leia o QR no celular." : "Sessão atualizada.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Não foi possível atualizar a sessão.");
    } finally {
      setBusy(false);
    }
  }

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const next = await apiRequest<WhatsAppChannelView>(tenantPath(tenantId, "whatsapp"), {
        method: "PUT",
        csrfToken,
        body: {
          provider,
          proactiveEnabled: proactive,
          ...(provider === "meta_cloud" && metaPhoneNumberId ? { metaPhoneNumberId } : {}),
          ...(provider === "meta_cloud" && metaAccessToken ? { metaAccessToken } : {})
        }
      });
      setMetaAccessToken("");
      setView(next);
      setNotice("Configuração do canal salva. A chave da Meta não volta na resposta.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Não foi possível salvar o canal.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel whatsapp-panel" id="whatsapp" aria-labelledby="whatsapp-title">
      <div className="panel-heading">
        <span className="panel-icon"><Wifi size={18} /></span>
        <div>
          <p className="section-kicker">WHATSAPP</p>
          <h2 id="whatsapp-title">Canal da empresa</h2>
        </div>
        <span className="version-tag">{view?.enabled ? statusText(view) : "Desligado"}</span>
      </div>
      {!view?.enabled && (
        <p className="muted-copy">
          O pareamento por QR fica desligado até <code>WHATSAPP_CHANNEL_ENABLED=true</code>. Sem isso, o atendimento continua simulado e nada é enviado ao WhatsApp.
        </p>
      )}
      {view?.enabled && (
        <>
          <p className="muted-copy">
            {statusText(view)}
            {view.phoneMasked ? ` · número ${view.phoneMasked}` : ""}.
            O bot só responde quem escreveu primeiro. Disparo em massa não existe. Lembretes ficam desligados até haver conversa anterior e opt-in.
          </p>
          {view.qrDataUrl && (
            <img className="whatsapp-qr" alt="QR Code para parear o WhatsApp desta empresa" src={view.qrDataUrl} />
          )}
          {!view.qrDataUrl && view.status === "qr_pending" && (
            <p className="muted-copy"><QrCode size={14} /> Gerando o QR…</p>
          )}
          {isAdmin && (
            <div className="form-actions whatsapp-actions">
              <button className="primary-button" type="button" onClick={() => void run("connect")} disabled={busy}>Parear / reconectar</button>
              <button className="secondary-button" type="button" onClick={() => void run("disconnect")} disabled={busy}>Desconectar</button>
              <button className="quiet-action" type="button" onClick={() => void run("logout")} disabled={busy}>Encerrar sessão</button>
            </div>
          )}
          <form onSubmit={(event) => void save(event)}>
            <label className="field-label" htmlFor="whatsapp-provider">Provedor</label>
            <select id="whatsapp-provider" value={provider} onChange={(event) => setProvider(event.target.value as ProviderId)} disabled={!isAdmin || busy}>
              <option value="unofficial_qr">QR não oficial (Baileys)</option>
              <option value="meta_cloud">API oficial da Meta</option>
            </select>
            <label className="check-row" htmlFor="whatsapp-proactive">
              <input id="whatsapp-proactive" type="checkbox" checked={proactive} onChange={(event) => setProactive(event.target.checked)} disabled={!isAdmin || busy} />
              Permitir envios proativos para contatos com opt-in
            </label>
            {provider === "meta_cloud" && (
              <>
                <label className="field-label" htmlFor="meta-phone-id">Phone number ID da Meta</label>
                <input id="meta-phone-id" value={metaPhoneNumberId} onChange={(event) => setMetaPhoneNumberId(event.target.value)} disabled={!isAdmin || busy} inputMode="numeric" autoComplete="off" />
                <label className="field-label" htmlFor="meta-token">Token de acesso da Meta</label>
                <input id="meta-token" type="password" value={metaAccessToken} onChange={(event) => setMetaAccessToken(event.target.value)} disabled={!isAdmin || busy} autoComplete="off" placeholder={view.metaConfigured ? "Deixe em branco para manter o token salvo" : ""} />
              </>
            )}
            {isAdmin && <div className="form-actions"><button className="secondary-button" type="submit" disabled={busy}>Salvar canal</button></div>}
          </form>
        </>
      )}
      {error && <div className="inline-alert error" role="alert">{error}</div>}
      {notice && <div className="inline-alert success" role="status">{notice}</div>}
    </section>
  );
}
