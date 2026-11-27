import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "./feedback";
import { SettingsView } from "./SettingsView";
import type { Session, TenantConfig } from "./api";

const session: Session = {
  user: {
    id: "user-1",
    email: "admin@atende.local",
    displayName: "Admin",
    platformAdmin: true,
    memberships: [{ tenantId: "pizzaria-demo", role: "TENANT_ADMIN" }]
  },
  csrfToken: "csrf-token-test",
  expiresAt: "2026-12-31T00:00:00.000Z"
};

const baseConfig: TenantConfig = {
  businessName: "Pizzaria Demo",
  segment: "pizzaria",
  assistantObjective: "Montar pedidos com preço do cardápio",
  greeting: "Olá!",
  knowledge: [],
  handoffKeywords: ["atendente"],
  assistantMode: "approved_faq",
  version: 1,
  profile: {
    address: "Rua A, 10",
    serviceArea: "Centro",
    hours: "seg 18:00-23:00",
    deliveryEnabled: true,
    pickupEnabled: true,
    deliveryFeeCents: 800,
    paymentMethods: ["Pix"],
    policies: "",
    persona: ""
  },
  catalog: [],
  orderingEnabled: true
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SettingsView", () => {
  it("keeps the payment editor outside the parent form and adds a chip with Enter", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/config") && (!init?.method || init.method === "GET")) {
        return new Response(JSON.stringify({ config: baseConfig }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(
      <ToastProvider>
        <SettingsView
          tenantId="pizzaria-demo"
          session={session}
          canEdit
          onSessionExpired={() => undefined}
          onDirtyChange={() => undefined}
        />
      </ToastProvider>
    );

    await waitFor(() => {
      expect(screen.getByText("Objetivo do bot")).toBeTruthy();
    });

    expect(container.querySelectorAll("form")).toHaveLength(1);

    const paymentInput = screen.getByRole("textbox", { name: "Formas de pagamento" });
    fireEvent.change(paymentInput, { target: { value: "Cartão de crédito" } });
    fireEvent.keyDown(paymentInput, { key: "Enter", code: "Enter" });
    expect(screen.getByRole("button", { name: "Cartão de crédito" })).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/v1/tenants/pizzaria-demo/config",
      expect.objectContaining({ method: "PUT" })
    );
  });
});
