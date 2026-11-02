// A source's declaration, as the gateway validates it before it travels to the panel (see
// `SourceDeclaration` in ./types.ts). Strict: a declaration that invents a field is refused here
// rather than arriving in the UI unread, the way `capabilitiesSchema` guards capabilities.
import { z } from 'zod';

export const sourceDeclarationSchema = z.strictObject({
  label: z.string().min(1).max(80),
  icon: z.string().min(1).max(80),
  pollIntervalMs: z.number().int().positive(),
  watchIntervalMs: z.number().int().positive().optional(),
  pageSize: z.number().int().positive().max(200).optional(),
});
