import { OpenRedaction } from '@openredaction/core';

// Only these categories are enabled: name detection changes ordinary message text.
const redactor = new OpenRedaction({
  includeNames: false,
  includeEmails: true,
  includePhones: true,
  patterns: ['EMAIL', 'PHONE_UK_MOBILE', 'PHONE_LINE_NUMBER', 'PHONE_UK', 'PHONE_US', 'PHONE_INTERNATIONAL'],
  redactionMode: 'mask-all',
});

/** Make a redacted copy for inference; never return the detection map. */
export async function redactInferenceValue(value: unknown): Promise<unknown> {
  try {
    if (typeof value === 'string') {
      const emailMasked = value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[EMAIL]');
      return (await redactor.detect(emailMasked)).redacted;
    }
    if (Array.isArray(value)) return await Promise.all(value.map(redactInferenceValue));
    if (value && typeof value === 'object') {
      const entries = await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await redactInferenceValue(item)] as const));
      return Object.fromEntries(entries);
    }
    return value;
  } catch {
    throw new Error('Could not redact inbox data; nothing was sent.');
  }
}
