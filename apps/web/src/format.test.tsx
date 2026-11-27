import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { DocumentField, MoneyField, PercentField, PhoneField } from "./fields";
import {
  deliveryTick,
  documentError,
  formatCents,
  formatPhoneBR,
  inputToCents,
  isCompleteCep,
  isCompletePhoneBR,
  isValidCnpj,
  isValidCpf,
  isValidTime,
  maskCep,
  maskPercent,
  maskTime,
  parseHours,
  parsePercent,
  phoneForApi,
  serializeHours,
  defaultWeek
} from "./format";

afterEach(() => cleanup());

describe("telefone brasileiro", () => {
  it("formata celular com DDD", () => {
    expect(formatPhoneBR("11912345678")).toBe("+55 (11) 91234-5678");
    expect(formatPhoneBR("+55 (11) 91234-5678")).toBe("+55 (11) 91234-5678");
    expect(isCompletePhoneBR("11912345678")).toBe(true);
    expect(phoneForApi("11912345678")).toBe("5511912345678");
  });

  it("formata fixo e recusa número curto", () => {
    expect(formatPhoneBR("1133334444")).toBe("+55 (11) 3333-4444");
    expect(isCompletePhoneBR("1133334444")).toBe(true);
    expect(isCompletePhoneBR("1191234")).toBe(false);
  });

  it("mostra a máscara no campo", () => {
    function Harness() {
      const [digits, setDigits] = useState("");
      return <PhoneField id="phone" label="Telefone" digits={digits} onDigits={setDigits} />;
    }
    render(<Harness />);
    fireEvent.change(screen.getByLabelText("Telefone"), { target: { value: "11912345678" } });
    expect((screen.getByLabelText("Telefone") as HTMLInputElement).value).toBe("+55 (11) 91234-5678");
  });
});

describe("dinheiro em centavos", () => {
  it("converte reais com vírgula e símbolo", () => {
    expect(inputToCents("48,00")).toBe(4800);
    expect(inputToCents("R$ 1.234,56")).toBe(123456);
    expect(inputToCents("-12,50")).toBe(-1250);
    expect(formatCents(4800)).toBe("R$ 48,00");
  });

  it("aplica a máscara de digitação no campo", () => {
    function Harness() {
      const [cents, setCents] = useState(0);
      return <MoneyField id="price" label="Preço" cents={cents} onCents={setCents} />;
    }
    render(<Harness />);
    fireEvent.change(screen.getByLabelText("Preço"), { target: { value: "4800" } });
    expect((screen.getByLabelText("Preço") as HTMLInputElement).value).toBe("R$ 48,00");
  });
});

describe("CEP, documento, hora e percentual", () => {
  it("mascara CEP", () => {
    expect(maskCep("01310100")).toBe("01310-100");
    expect(isCompleteCep("01310-100")).toBe(true);
    expect(isCompleteCep("0131")).toBe(false);
  });

  it("valida CPF e CNPJ", () => {
    expect(isValidCpf("529.982.247-25")).toBe(true);
    expect(isValidCpf("111.111.111-11")).toBe(false);
    expect(documentError("529982247")).toBe("CPF incompleto.");
    expect(isValidCnpj("11444777000161")).toBe(true);
    expect(documentError("11444777000100")).toBe("CNPJ inválido.");
  });

  it("mostra erro de CPF no campo", () => {
    function Harness() {
      const [value, setValue] = useState("");
      return <DocumentField id="doc" label="Documento" value={value} onValue={setValue} />;
    }
    render(<Harness />);
    fireEvent.change(screen.getByLabelText("Documento"), { target: { value: "11111111111" } });
    expect(screen.getByRole("alert").textContent).toBe("CPF inválido.");
  });

  it("mascara horário e percentual", () => {
    expect(maskTime("1830")).toBe("18:30");
    expect(isValidTime("18:30")).toBe(true);
    expect(isValidTime("25:00")).toBe(false);
    expect(maskPercent("12,5")).toBe("12,5");
    expect(parsePercent("100")).toBe(100);
    expect(parsePercent("100,5")).toBeUndefined();
  });

  it("mostra erro de percentual no campo", () => {
    function Harness() {
      const [value, setValue] = useState("");
      return <PercentField id="pct" label="Percentual" value={value} onValue={setValue} />;
    }
    render(<Harness />);
    fireEvent.change(screen.getByLabelText("Percentual"), { target: { value: "150" } });
    expect(screen.getByRole("alert").textContent).toBe("Informe um percentual de 0 a 100.");
  });
});

describe("horário semanal e ticks", () => {
  it("grava e lê a grade da semana", () => {
    const days = defaultWeek();
    const closed = days.map((day, index) => index === 6 ? { ...day, closed: true } : day);
    const text = serializeHours(closed);
    const parsed = parseHours(text);
    expect(parsed.structured).toBe(true);
    if (parsed.structured) expect(parsed.days[6]?.closed).toBe(true);
    expect(parseHours("Todos os dias, das 18h às 23h.").structured).toBe(false);
  });

  it("nomeia o estado de entrega", () => {
    expect(deliveryTick("PENDING").label).toBe("Na fila");
    expect(deliveryTick("ACCEPTED").tick).toBe("enviada");
    expect(deliveryTick("ACCEPTED", "delivered").tick).toBe("entregue");
    expect(deliveryTick("ACCEPTED", "read").tick).toBe("lida");
    expect(deliveryTick("HTTP_ERROR").tick).toBe("falha");
  });
});
