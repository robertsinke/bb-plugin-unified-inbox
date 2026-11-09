/** Same bounds as the pairing phone-code field. */
export const PHONE_MIN = 7;
export const PHONE_MAX = 15;

export const WHATSAPP_OFFLINE = 'Nothing was sent: WhatsApp is not connected. Reconnect it and try again.';
export const WHATSAPP_UNKNOWN_NUMBER = 'Nothing was sent: WhatsApp does not have an account for that number.';
export const WHATSAPP_OWN_NUMBER = 'Nothing was sent: that number is this WhatsApp account.';
export const WHATSAPP_BAD_PHONE = 'Nothing was sent: enter the phone number with the country code.';

export function whatsAppPhoneDigits(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (digits.length < PHONE_MIN || digits.length > PHONE_MAX) return null;
  return digits;
}
