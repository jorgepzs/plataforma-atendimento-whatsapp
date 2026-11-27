import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Toasts, type ToastItem } from "./ui";

type Tone = "ok" | "err";

const ToastContext = createContext<(text: string, tone?: Tone) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((text: string, tone: Tone = "ok") => {
    const id = Date.now() + Math.floor(Math.random() * 1000);
    setItems((current) => [...current.slice(-3), { id, tone, text }]);
    window.setTimeout(() => {
      setItems((current) => current.filter((item) => item.id !== id));
    }, 4200);
  }, []);
  const value = useMemo(() => push, [push]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <Toasts items={items} onDismiss={(id) => setItems((current) => current.filter((item) => item.id !== id))} />
    </ToastContext.Provider>
  );
}

export function useToast(): (text: string, tone?: Tone) => void {
  return useContext(ToastContext);
}

export function useTheme() {
  const [theme, setTheme] = useState<"light" | "dark">(() => {
    try {
      return localStorage.getItem("atende-theme") === "dark" ? "dark" : "light";
    } catch {
      return "light";
    }
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("atende-theme", theme);
    } catch {
      // O tema continua valendo nesta aba.
    }
  }, [theme]);
  return {
    theme,
    toggle: () => setTheme((current) => current === "dark" ? "light" : "dark")
  };
}

let audio: AudioContext | null = null;

export function unlockAudio(): void {
  const Context = window.AudioContext;
  if (!Context) return;
  audio ??= new Context();
  if (audio.state === "suspended") void audio.resume();
}

export function playOrderChime(): void {
  if (!audio || audio.state !== "running") return;
  const now = audio.currentTime;
  const oscillator = audio.createOscillator();
  const gain = audio.createGain();
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(784, now);
  oscillator.frequency.setValueAtTime(1046, now + 0.09);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.06, now + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.32);
  oscillator.connect(gain);
  gain.connect(audio.destination);
  oscillator.start(now);
  oscillator.stop(now + 0.34);
}
