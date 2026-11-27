import { useEffect, useState } from "react";
import { ApiError, apiRequest, formatApiError, tenantPath, type Session, type TenantConfig } from "./api";
import { normalizeConfig } from "./format";
import { useToast } from "./feedback";

export function useTenantConfig(tenantId: string, session: Session, onSessionExpired: () => void) {
  const toast = useToast();
  const [config, setConfig] = useState<TenantConfig | null>(null);
  const [saved, setSaved] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setConfig(null);
    apiRequest<{ config: TenantConfig }>(tenantPath(tenantId, "config")).then((result) => {
      if (cancelled) return;
      const next = normalizeConfig(result.config);
      setConfig(next);
      setSaved(JSON.stringify(next));
      setError("");
    }).catch((reason: unknown) => {
      if (cancelled) return;
      if (reason instanceof ApiError && reason.status === 401) onSessionExpired();
      else setError(formatApiError(reason));
    });
    return () => { cancelled = true; };
  }, [tenantId, onSessionExpired]);

  async function save(next: TenantConfig): Promise<TenantConfig | null> {
    setBusy(true);
    setError("");
    try {
      const result = await apiRequest<{ config: TenantConfig }>(tenantPath(tenantId, "config"), {
        method: "PUT",
        csrfToken: session.csrfToken,
        body: next
      });
      const normalized = normalizeConfig(result.config);
      setConfig(normalized);
      setSaved(JSON.stringify(normalized));
      toast("Alterações salvas.");
      return normalized;
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) onSessionExpired();
      else {
        const message = formatApiError(reason);
        setError(message);
        toast(message, "err");
      }
      return null;
    } finally {
      setBusy(false);
    }
  }

  return {
    config,
    setConfig,
    error,
    busy,
    save,
    dirty: config !== null && JSON.stringify(config) !== saved
  };
}
