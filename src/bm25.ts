const K1 = 1.2;
const B = 0.75;
const EXACT_BOOST = 0.25;

export function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(token => token.length > 1);
}

export function conversationText(parts: { title: string; recipients?: string; attachments?: string[]; preview: string; messages: unknown[] }): string {
  const bodies = parts.messages.map(message => {
    if (!message || typeof message !== 'object') return '';
    const row = message as { subject?: unknown; sender?: unknown; to?: unknown; cc?: unknown; text?: unknown; attachments?: unknown };
    const attachments = Array.isArray(row.attachments) ? row.attachments.filter((name): name is string => typeof name === 'string') : [];
    return [row.subject, row.sender, row.to, row.cc, row.text, ...attachments].filter((part): part is string => typeof part === 'string').join(' ');
  });
  return [parts.title, parts.recipients, ...(parts.attachments ?? []), parts.preview, ...bodies].join('\n');
}

export type PreparedDocument = { id: string; freq: Map<string, number>; length: number };

export function prepareDocument(id: string, text: string): PreparedDocument {
  const tokens = tokenize(text);
  const freq = new Map<string, number>();
  for (const token of tokens) freq.set(token, (freq.get(token) ?? 0) + 1);
  return { id, freq, length: tokens.length };
}

/** Counts exact and prefix matches; "marn" matches "marn" and "marnix". */
function frequency(doc: PreparedDocument, term: string): number {
  let count = 0;
  for (const [token, value] of doc.freq) if (token.startsWith(term)) count += value;
  return count;
}

export function bm25RankPrepared(query: string, documents: PreparedDocument[]): { id: string; score: number }[] {
  const terms = [...new Set(tokenize(query))];
  if (!terms.length || !documents.length) return [];
  const average = documents.reduce((sum, doc) => sum + doc.length, 0) / documents.length || 1;
  const docsWith = new Map(terms.map(term => [term, documents.filter(doc => frequency(doc, term) > 0).length]));
  const total = documents.length;
  const scored = documents.flatMap(doc => {
    let score = 0;
    for (const term of terms) {
      const exact = doc.freq.get(term) ?? 0;
      const freq = frequency(doc, term);
      if (!freq) continue;
      const containing = docsWith.get(term) ?? 0;
      const idf = Math.log(1 + (total - containing + 0.5) / (containing + 0.5));
      const denominator = freq + K1 * (1 - B + B * doc.length / average);
      score += idf * (freq * (K1 + 1) / denominator) + (exact ? idf * EXACT_BOOST : 0);
    }
    return score > 0 ? [{ id: doc.id, score }] : [];
  });
  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return scored;
}

export function bm25Rank(query: string, documents: { id: string; text: string }[]): { id: string; score: number }[] {
  return bm25RankPrepared(query, documents.map(doc => prepareDocument(doc.id, doc.text)));
}
