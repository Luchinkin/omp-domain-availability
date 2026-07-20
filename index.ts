import { domainToASCII } from "node:url";
import type { CustomToolFactory } from "@oh-my-pi/pi-coding-agent";

const NAMECHEAP_API_ENDPOINT = "https://api.namecheap.com/xml.response";
const NAMECHEAP_PRICING_ENDPOINT = "https://www.namecheap.com/domains/tlds.ashx";
const RDAP_BOOTSTRAP_ENDPOINT = "https://data.iana.org/rdap/dns.json";
const MAX_DOMAINS = 50;

type Availability = "available" | "registered" | "unregistered" | "unknown";
type PriceKind = "exact-premium" | "standard-tld";

export type DomainResult = {
  domain: string;
  availability: Availability;
  source: "namecheap" | "rdap";
  premium?: boolean;
  registrationPrice?: number;
  regularRegistrationPrice?: number;
  renewalPrice?: number;
  currency?: "USD";
  priceKind?: PriceKind;
  promotion?: string;
  minRegistrationYears?: number;
  maxRegistrationYears?: number;
  idnSupported?: boolean;
  type?: string;
  whoisPrivacyCompatible?: boolean;
  error?: string;
  namecheapUrl: string;
  registrarConfirmationRequired: boolean;
};

type TldPricing = {
  Name?: unknown;
  MinRegisterYears?: unknown;
  MaxRegisterYears?: unknown;
  IDN?: unknown;
  Type?: unknown;
  WhoisguardCompatibile?: unknown;
  Pricing?: {
    Price?: unknown;
    Regular?: unknown;
    Renewal?: unknown;
    Hint?: unknown;
  };
};

export function normalizeDomain(value: string): string {
  const trimmed = value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (trimmed.includes("/") || trimmed.includes(":") || trimmed.startsWith(".") || trimmed.endsWith(".")) {
    throw new Error(`Invalid domain: ${value}`);
  }
  const ascii = domainToASCII(trimmed);
  if (!ascii || ascii.length > 253 || !ascii.includes(".")) throw new Error(`Invalid domain: ${value}`);
  for (const label of ascii.split(".")) {
    if (!label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) {
      throw new Error(`Invalid domain: ${value}`);
    }
  }
  return ascii;
}

function attr(xml: string, name: string): string | undefined {
  const match = xml.match(new RegExp(`${name}="([^"]*)"`, "i"));
  return match?.[1]?.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function numberValue(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function configuredForNamecheap(): boolean {
  return ["NAMECHEAP_API_USER", "NAMECHEAP_API_KEY", "NAMECHEAP_USERNAME", "NAMECHEAP_CLIENT_IP"]
    .every((name) => Boolean(process.env[name]));
}

function purchaseUrl(domain: string): string {
  return `https://www.namecheap.com/domains/registration/results/?domain=${encodeURIComponent(domain)}`;
}

function suffixFor(domain: string, knownTlds: Set<string>): string | undefined {
  const labels = domain.split(".");
  for (let index = 1; index < labels.length; index += 1) {
    const candidate = labels.slice(index).join(".");
    if (knownTlds.has(candidate)) return candidate;
  }
  return undefined;
}

async function loadTldPricing(signal: AbortSignal): Promise<Map<string, TldPricing>> {
  try {
    const response = await fetch(NAMECHEAP_PRICING_ENDPOINT, { signal, headers: { Accept: "application/json" } });
    if (!response.ok) return new Map();
    const payload: unknown = await response.json();
    if (!Array.isArray(payload)) return new Map();
    const entries = payload.filter((row): row is TldPricing => Boolean(row) && typeof row === "object" && typeof (row as TldPricing).Name === "string");
    return new Map(entries.map((row) => [String(row.Name).toLowerCase(), row]));
  } catch (error) {
    if (signal.aborted) throw error;
    return new Map();
  }
}

export function rdapServicesFromBootstrap(payload: unknown): Map<string, string> {
  if (!payload || typeof payload !== "object" || !("services" in payload) || !Array.isArray(payload.services)) return new Map();
  const services = new Map<string, string>();
  for (const entry of payload.services) {
    if (!Array.isArray(entry) || !Array.isArray(entry[0]) || !Array.isArray(entry[1])) continue;
    const endpoint = entry[1].find((value): value is string => typeof value === "string" && value.startsWith("https://"));
    if (!endpoint) continue;
    for (const tld of entry[0]) {
      if (typeof tld === "string") services.set(tld.toLowerCase(), endpoint);
    }
  }
  return services;
}

async function loadRdapServices(signal: AbortSignal): Promise<Map<string, string>> {
  try {
    const response = await fetch(RDAP_BOOTSTRAP_ENDPOINT, { signal, headers: { Accept: "application/json" } });
    if (!response.ok) return new Map();
    return rdapServicesFromBootstrap(await response.json());
  } catch (error) {
    if (signal.aborted) throw error;
    return new Map();
  }
}

function addStandardPrice(result: DomainResult, pricing: Map<string, TldPricing>): DomainResult {
  if (result.availability !== "unregistered" && result.availability !== "available") return result;
  const suffix = suffixFor(result.domain, new Set(pricing.keys()));
  const row = suffix ? pricing.get(suffix) : undefined;
  if (!row) return result;
  const registrationPrice = numberValue(row.Pricing?.Price);
  const renewalPrice = numberValue(row.Pricing?.Renewal);
  return {
    ...result,
    registrationPrice: result.registrationPrice ?? registrationPrice,
    regularRegistrationPrice: numberValue(row.Pricing?.Regular),
    renewalPrice: result.renewalPrice ?? renewalPrice,
    currency: "USD",
    priceKind: result.priceKind ?? "standard-tld",
    promotion: stringValue(row.Pricing?.Hint),
    minRegistrationYears: numberValue(row.MinRegisterYears),
    maxRegistrationYears: numberValue(row.MaxRegisterYears),
    idnSupported: booleanValue(row.IDN),
    type: stringValue(row.Type),
    whoisPrivacyCompatible: booleanValue(row.WhoisguardCompatibile),
  };
}

async function checkNamecheap(domains: string[], signal: AbortSignal): Promise<DomainResult[]> {
  const query = new URLSearchParams({
    ApiUser: process.env.NAMECHEAP_API_USER!,
    ApiKey: process.env.NAMECHEAP_API_KEY!,
    UserName: process.env.NAMECHEAP_USERNAME!,
    ClientIp: process.env.NAMECHEAP_CLIENT_IP!,
    Command: "namecheap.domains.check",
    DomainList: domains.join(","),
  });
  const endpoint = process.env.NAMECHEAP_API_ENDPOINT || NAMECHEAP_API_ENDPOINT;
  const response = await fetch(`${endpoint}?${query}`, { signal, headers: { Accept: "application/xml" } });
  if (!response.ok) throw new Error(`Namecheap returned HTTP ${response.status}`);
  const xml = await response.text();
  const apiError = xml.match(/<Errors>\s*<Error[^>]*>([\s\S]*?)<\/Error>/i)?.[1];
  if (apiError) throw new Error(`Namecheap API error: ${apiError.replace(/<[^>]+>/g, "")}`);
  const rows = [...xml.matchAll(/<DomainCheckResult\b[^>]*\/?\s*>/gi)];
  if (rows.length !== domains.length) throw new Error(`Namecheap returned ${rows.length} results for ${domains.length} domains`);
  const byDomain = new Map(rows.map((row) => [attr(row[0], "Domain")?.toLowerCase(), row[0]]));
  return domains.map((domain) => {
    const row = byDomain.get(domain);
    if (!row) throw new Error(`Namecheap omitted ${domain}`);
    const available = attr(row, "Available")?.toLowerCase() === "true";
    const premium = attr(row, "IsPremiumName")?.toLowerCase() === "true";
    const error = attr(row, "Error") || undefined;
    return {
      domain,
      availability: error ? "unknown" : available ? "available" : "registered",
      source: "namecheap",
      premium,
      registrationPrice: numberValue(attr(row, "PremiumRegistrationPrice")),
      renewalPrice: numberValue(attr(row, "PremiumRenewalPrice")),
      currency: "USD",
      priceKind: premium ? "exact-premium" : undefined,
      error,
      namecheapUrl: purchaseUrl(domain),
      registrarConfirmationRequired: false,
    };
  });
}

async function checkRdap(domain: string, services: Map<string, string>, signal: AbortSignal): Promise<DomainResult> {
  const namecheapUrl = purchaseUrl(domain);
  const tld = domain.split(".").at(-1);
  const service = tld ? services.get(tld) : undefined;
  if (!service) {
    return {
      domain,
      availability: "unknown",
      source: "rdap",
      error: `The .${tld ?? ""} registry does not publish an IANA-listed HTTPS RDAP service`,
      namecheapUrl,
      registrarConfirmationRequired: true,
    };
  }
  try {
    const endpoint = `${service.replace(/\/?$/, "/")}domain/${encodeURIComponent(domain)}`;
    const response = await fetch(endpoint, {
      signal,
      redirect: "follow",
      headers: { Accept: "application/rdap+json, application/json" },
    });
    if (response.status === 404) return { domain, availability: "unregistered", source: "rdap", namecheapUrl, registrarConfirmationRequired: true };
    if (response.ok) return { domain, availability: "registered", source: "rdap", namecheapUrl, registrarConfirmationRequired: false };
    return { domain, availability: "unknown", source: "rdap", error: `RDAP returned HTTP ${response.status}`, namecheapUrl, registrarConfirmationRequired: true };
  } catch (error) {
    if (signal.aborted) throw error;
    return { domain, availability: "unknown", source: "rdap", error: error instanceof Error ? error.message : String(error), namecheapUrl, registrarConfirmationRequired: true };
  }
}

const factory: CustomToolFactory = (pi) => ({
  name: "domain_availability",
  label: "Domain Availability",
  description: "Batch-checks generated domain candidates and returns availability, Namecheap pricing, renewal cost, promotions, premium status, registration constraints, and purchase links. Uses exact Namecheap results with API credentials; otherwise reports preliminary RDAP registration status plus standard TLD pricing without claiming registrar availability.",
  parameters: pi.zod.object({
    domains: pi.zod.array(pi.zod.string()).min(1).max(MAX_DOMAINS).describe("Fully qualified domain candidates, up to 50"),
  }),
  async execute(_toolCallId, params: { domains: string[] }, onUpdate, _ctx, signal) {
    const activeSignal = signal ?? new AbortController().signal;
    const domains = [...new Set(params.domains.map(normalizeDomain))];
    onUpdate?.({ content: [{ type: "text", text: `Checking ${domains.length} domain candidate${domains.length === 1 ? "" : "s"}...` }], details: { phase: "checking", count: domains.length } });
    const useNamecheap = configuredForNamecheap();
    const [pricing, rdapServices] = await Promise.all([
      loadTldPricing(activeSignal),
      useNamecheap ? Promise.resolve(new Map<string, string>()) : loadRdapServices(activeSignal),
    ]);
    const rawResults = useNamecheap
      ? await checkNamecheap(domains, activeSignal)
      : await Promise.all(domains.map((domain) => checkRdap(domain, rdapServices, activeSignal)));
    const provider = useNamecheap ? "namecheap" : "rdap";
    const results = rawResults.map((result) => addStandardPrice(result, pricing));
    const checkedAt = new Date().toISOString();
    const caveat = provider === "namecheap"
      ? "Availability and prices are point-in-time results; recheck immediately before purchase."
      : "RDAP 'unregistered' is preliminary. Standard TLD prices do not include premium tiers, reserved-name rules, taxes, or account-specific discounts. Open namecheapUrl or configure the Namecheap API before claiming availability or quoting a final price.";
    const summary = results.map((result) => {
      const fields = [
        `availability=${result.availability}`,
        `source=${result.source}`,
        result.premium === undefined ? undefined : `premium=${result.premium}`,
        result.registrationPrice === undefined ? undefined : `registrationPrice=${result.registrationPrice} ${result.currency} (${result.priceKind})`,
        result.regularRegistrationPrice === undefined ? undefined : `regularRegistrationPrice=${result.regularRegistrationPrice} ${result.currency}`,
        result.renewalPrice === undefined ? undefined : `renewalPrice=${result.renewalPrice} ${result.currency}`,
        result.promotion ? `promotion=${result.promotion}` : undefined,
        result.minRegistrationYears === undefined ? undefined : `registrationYears=${result.minRegistrationYears}-${result.maxRegistrationYears}`,
        result.idnSupported === undefined ? undefined : `idnSupported=${result.idnSupported}`,
        result.type ? `type=${result.type}` : undefined,
        result.whoisPrivacyCompatible === undefined ? undefined : `whoisPrivacyCompatible=${result.whoisPrivacyCompatible}`,
        `registrarConfirmationRequired=${result.registrarConfirmationRequired}`,
        `namecheapUrl=${result.namecheapUrl}`,
      ].filter((field) => field !== undefined);
      return `${result.domain}: ${fields.join("; ")}`;
    }).join("\n");
    return {
      content: [{ type: "text", text: `${summary}\n\nSource: ${provider}. ${caveat}` }],
      details: { provider, checkedAt, caveat, results },
    };
  },
});

export default factory;
