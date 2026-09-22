/**
 * ISO-4217 Currency Precision Mapping & Monetary Utility
 * Respects international currency-specific decimal places (e.g., JPY=0, BHD=3, USD=2).
 */

export const CURRENCY_PRECISION_MAP: Record<string, number> = {
  // 0 decimal places (no minor unit / integer currencies)
  BIF: 0, // Burundian Franc
  CLP: 0, // Chilean Peso
  DJF: 0, // Djiboutian Franc
  GNF: 0, // Guinean Franc
  HUF: 0, // Hungarian Forint (invoicing standard)
  ISK: 0, // Icelandic Krona
  JPY: 0, // Japanese Yen
  KMF: 0, // Comorian Franc
  KRW: 0, // South Korean Won
  PYG: 0, // Paraguayan Guarani
  RWF: 0, // Rwandan Franc
  UGX: 0, // Ugandan Shilling
  VND: 0, // Vietnamese Dong
  VUV: 0, // Vanuatu Vatu
  XAF: 0, // Central African CFA Franc
  XOF: 0, // West African CFA Franc
  XPF: 0, // CFP Franc

  // 3 decimal places (1/1000th minor unit)
  BHD: 3, // Bahraini Dinar
  IQD: 3, // Iraqi Dinar
  JOD: 3, // Jordanian Dinar
  KWD: 3, // Kuwaiti Dinar
  LYD: 3, // Libyan Dinar
  OMR: 3, // Omani Rial
  TND: 3, // Tunisian Dinar

  // 4 decimal places (specialized investment / exchange)
  CLF: 4, // Unidad de Fomento
  UYW: 4, // Unidad Previsional

  // Standard 2 decimal places (default worldwide)
  USD: 2,
  EUR: 2,
  GBP: 2,
  CAD: 2,
  AUD: 2,
  NZD: 2,
  CHF: 2,
  INR: 2,
  SGD: 2,
  HKD: 2,
  CNY: 2,
  SEK: 2,
  NOK: 2,
  DKK: 2,
  PLN: 2,
  BRL: 2,
  MXN: 2,
  ZAR: 2,
  AED: 2,
  SAR: 2,
  TRY: 2,
  THB: 2,
  MYR: 2,
  IDR: 2,
  PHP: 2,
  CZK: 2,
  ILS: 2,
};

/**
 * Returns the exact standard ISO decimal precision for a currency code.
 * Defaults to 2 for unspecified or standard currencies.
 */
export function getCurrencyPrecision(currencyCode?: string | null): number {
  if (!currencyCode) {
    return 2;
  }
  const clean = currencyCode.trim().toUpperCase();
  if (clean in CURRENCY_PRECISION_MAP) {
    return CURRENCY_PRECISION_MAP[clean]!;
  }
  return 2;
}

/**
 * Inspects numeric values to detect if source document explicitly uses a higher precision
 * (e.g., fuel pricing, bulk commodities with 3 or 4 decimal places).
 */
export function detectDocumentMaxPrecision(
  values: (number | string | null | undefined)[],
  currencyDefault = 2
): number {
  let maxObserved = currencyDefault;

  for (const v of values) {
    if (v === null || v === undefined) continue;
    const str = String(v).trim();
    const parts = str.split('.');
    if (parts.length === 2 && parts[1]) {
      // Ignore trailing zeros only if past default
      const decimals = parts[1].length;
      if (decimals > maxObserved && decimals <= 6) {
        maxObserved = decimals;
      }
    }
  }

  return maxObserved;
}
