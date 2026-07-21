/**
 * International address formatting and metadata.
 * Country-specific field order, labels, and display formatting.
 */

import { getData } from "country-list";
import { State } from "country-state-city";

export type AddressFields = {
  address1?: string;
  address2?: string;
  city?: string;
  provinceCode?: string;
  zip?: string;
  countryCode: string;
};

export type AddressLabels = {
  address1: string;
  city: string;
  province: string;
  zip: string;
};

/** Countries that use postal-code-first ordering (e.g. Japan, France) */
const POSTAL_FIRST_COUNTRIES = new Set(["JP", "FR", "DE", "AT", "CH", "NL", "BE", "PL", "CZ", "SK", "HU", "RO", "BG", "GR", "PT", "ES", "IT", "SE", "NO", "FI", "DK"]);

/** Zone/province label by country */
const ZONE_LABELS: Record<string, string> = {
  US: "State",
  CA: "Province",
  AU: "State",
  IN: "State",
  JP: "Prefecture",
  GB: "County",
  IE: "County",
  NZ: "Region",
  DE: "State",
  AT: "State",
  CH: "Canton",
  MX: "State",
  BR: "State",
};

/** Postal code label by country */
const ZIP_LABELS: Record<string, string> = {
  US: "ZIP code",
  GB: "Postcode",
  IE: "Eircode",
  IN: "Pincode",
  AU: "Postcode",
  NZ: "Postcode",
  CA: "Postal code",
};

let cachedCountryOptions: Array<{ label: string; value: string }> | null = null;

/**
 * Returns country options for Select, sorted by name.
 */
export function getCountryOptions(): Array<{ label: string; value: string }> {
  if (cachedCountryOptions) return cachedCountryOptions;
  const data = getData();
  cachedCountryOptions = data
    .map((c) => ({ label: c.name, value: c.code }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return cachedCountryOptions;
}

/**
 * Returns province/state options for Select. Empty array when country has no predefined states.
 */
export function getProvinceOptions(countryCode: string): Array<{ label: string; value: string }> {
  const cc = countryCode?.toUpperCase() || "";
  if (!cc) return [];
  const states = State.getStatesOfCountry(cc);
  return states
    .map((s) => ({ label: s.name, value: s.isoCode }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Returns localized labels for address form fields based on country.
 */
export function getAddressLabels(countryCode: string): AddressLabels {
  const cc = countryCode?.toUpperCase() || "US";
  return {
    address1: "Address line 1",
    city: "City",
    province: ZONE_LABELS[cc] ?? "State / Province",
    zip: ZIP_LABELS[cc] ?? "Postal code",
  };
}

/**
 * Field order: "western" for most countries (address1, city, province, zip),
 * "eastern" for postal-first (zip, province, city, address1).
 */
export type AddressFieldOrder = "western" | "eastern";

export function getAddressFieldOrder(countryCode: string): AddressFieldOrder {
  return POSTAL_FIRST_COUNTRIES.has(countryCode?.toUpperCase() || "US") ? "eastern" : "western";
}

/**
 * Formats an address for display according to country conventions.
 * Western: address1, city province zip, country
 * Eastern (e.g. Japan): 〒zip province city, address1, country
 */
export function formatAddress(address: AddressFields | null | undefined): string {
  if (!address) return "";
  const cc = address.countryCode?.toUpperCase() || "US";
  const a = address;

  const parts: string[] = [];
  const line1 = [a.address1, a.address2].filter(Boolean).join(", ");
  const city = a.city?.trim();
  const province = a.provinceCode?.trim();
  const zip = a.zip?.trim();
  const country = a.countryCode;

  const isEastern = POSTAL_FIRST_COUNTRIES.has(cc);

  if (isEastern && cc === "JP" && zip) {
    parts.push(`〒${zip}`);
  } else if (isEastern && zip) {
    parts.push(zip);
  }

  if (province && city) {
    parts.push(`${province} ${city}`.trim());
  } else if (city) {
    parts.push(city);
  } else if (province) {
    parts.push(province);
  }

  if (!isEastern && zip) {
    parts.push(zip);
  }

  if (line1) {
    parts.push(line1);
  }

  if (country) {
    parts.push(country);
  }

  return parts.filter(Boolean).join("\n");
}
