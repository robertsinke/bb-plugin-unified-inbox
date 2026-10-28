const K1 = 1.2;
const B = 0.75;

export function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(token => token.length > 1);
}

export function conversationText(parts: { title: string; preview: string; messages: unknown[] }): string {
  const bodies = parts.messages.map(message => {
    if (!message || typeof message !== 'object') return '';
    const row = message as { subject?: unknown; sender?: unknown; text?: unknown };
    return [row.subject, row.sender, row.text].filter((part): part is string => typeof part === 'string').join(' ');
  });
  return [parts.title, parts.preview, ...bodies].join('\n');
}

export function bm25Rank(query: string, documents: { id: string; text: string }[]): { id: string; score: number }[] {
  const terms = [...new Set(tokenize(query))];
  if (!terms.length || !documents.length) return [];
  const docs = documents.map(doc => {
    const tokens = tokenize(doc.text);
    const freq = new Map<string, number>();
    for (const token of tokens) freq.set(token, (freq.get(token) ?? 0) + 1);
    return { id: doc.id, freq, length: tokens.length };
  });
  const average = docs.reduce((sum, doc) => sum + doc.length, 0) / docs.length || 1;
  const docsWith = new Map(terms.map(term => [term, docs.filter(doc => doc.freq.has(term)).length]));
  const total = docs.length;
  const scored = docs.flatMap(doc => {
    let score = 0;
    for (const term of terms) {
      const freq = doc.freq.get(term) ?? 0;
      if (!freq) continue;
      const containing = docsWith.get(term) ?? 0;
      const idf = Math.log(1 + (total - containing + 0.5) / (containing + 0.5));
      const denominator = freq + K1 * (1 - B + B * doc.length / average);
      score += idf * (freq * (K1 + 1) / denominator);
    }
    return score > 0 ? [{ id: doc.id, score }] : [];
  });
  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return scored;
}
