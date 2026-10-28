type Entry = { url: string; bytes: number };

/** An LRU of rendered media data URLs, bounded by both entry count and bytes. */
export function createMediaCache({ maxBytes = 128 * 1024 * 1024, maxEntries = 200 } = {}) {
  const entries = new Map<string, Entry>();
  let bytes = 0;
  const remove = (id: string) => {
    const entry = entries.get(id);
    if (!entry) return;
    entries.delete(id);
    bytes -= entry.bytes;
  };
  return {
    get(id: string) {
      const entry = entries.get(id);
      if (!entry) return undefined;
      entries.delete(id);
      entries.set(id, entry);
      return entry.url;
    },
    set(id: string, url: string) {
      remove(id);
      entries.set(id, { url, bytes: url.length });
      bytes += url.length;
      while (entries.size > maxEntries || bytes > maxBytes) {
        const oldest = entries.keys().next().value;
        if (!oldest) break;
        remove(oldest);
      }
    },
    get size() { return entries.size; },
    get bytes() { return bytes; },
  };
}
