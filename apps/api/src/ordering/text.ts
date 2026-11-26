export function normalizeText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const quantityWords: Record<string, number> = {
  um: 1,
  uma: 1,
  dois: 2,
  duas: 2,
  tres: 3,
  quatro: 4,
  cinco: 5
};

export function quantityNear(text: string, name: string): number {
  const normalized = normalizeText(text);
  const target = normalizeText(name);
  const index = normalized.indexOf(target);
  if (index < 0) return 1;
  const before = normalized.slice(Math.max(0, index - 12), index).trim();
  const digit = /(\d{1,2})\s*$/.exec(before);
  if (digit) {
    const value = Number(digit[1]);
    if (value >= 1 && value <= 20) return value;
  }
  const word = /([a-z]+)\s*$/.exec(before);
  return word?.[1] ? quantityWords[word[1]] ?? 1 : 1;
}
