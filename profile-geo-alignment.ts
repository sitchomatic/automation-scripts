/**
 * Timezone + Locale Alignment
 * Aligns timezone and locale with proxy exit IP geolocation.
 * Prevents "location mismatch" bot detection when proxy location doesn't match browser settings.
 */

export interface GeoProfile {
  timezone: string;
  locale: string;
  countryCode: string;
}

const GEO_PROFILES: Record<string, GeoProfile> = {
  "US": { timezone: "America/New_York", locale: "en-US", countryCode: "US" },
  "GB": { timezone: "Europe/London", locale: "en-GB", countryCode: "GB" },
  "DE": { timezone: "Europe/Berlin", locale: "de-DE", countryCode: "DE" },
  "FR": { timezone: "Europe/Paris", locale: "fr-FR", countryCode: "FR" },
  "JP": { timezone: "Asia/Tokyo", locale: "ja-JP", countryCode: "JP" },
  "AU": { timezone: "Australia/Melbourne", locale: "en-AU", countryCode: "AU" },
  "SG": { timezone: "Asia/Singapore", locale: "en-SG", countryCode: "SG" },
  "CA": { timezone: "America/Toronto", locale: "en-CA", countryCode: "CA" },
};

/**
 * Detect country code from proxy URL by hostname pattern matching.
 * For production-grade detection, use MaxMind GeoIP DB or external API.
 */
function detectCountryFromProxy(proxyUrl: string): string {
  if (!proxyUrl) return "US";
  const url = proxyUrl.toLowerCase();
  if (url.includes("au.") || url.includes("australia")) return "AU";
  if (url.includes("uk.") || url.includes("britain") || url.includes(".co.uk")) return "GB";
  if (url.includes("de.") || url.includes("germany")) return "DE";
  if (url.includes("fr.") || url.includes("france")) return "FR";
  if (url.includes("jp.") || url.includes("japan")) return "JP";
  if (url.includes("sg.") || url.includes("singapore")) return "SG";
  if (url.includes("ca.") || url.includes("canada")) return "CA";
  if (url.includes("us.") || url.includes("america") || url.includes("united-states")) return "US";
  return "US";
}

/**
 * Get timezone and locale aligned to proxy exit location.
 * Returns US default if proxyUrl is empty.
 */
export function alignGeoToProxy(proxyUrl?: string): GeoProfile {
  const country = detectCountryFromProxy(proxyUrl || "");
  return GEO_PROFILES[country] || GEO_PROFILES["US"];
}

/**
 * Get geo profile with detailed logging.
 */
export function alignGeoToProxyWithLog(
  proxyUrl: string | undefined,
  logFn?: (msg: string) => void
): GeoProfile {
  const geo = alignGeoToProxy(proxyUrl);
  let proxyHost = "direct";
  if (proxyUrl) {
    try {
      const hostPart = proxyUrl.includes("@") ? proxyUrl.split("@")[1] : proxyUrl.replace(/^https?:\/\//, "");
      proxyHost = hostPart.split(":")[0] || "direct";
    } catch {
      proxyHost = "unknown";
    }
  }
  const msg = `Geo alignment: ${proxyHost} → ${geo.countryCode} (${geo.timezone} / ${geo.locale})`;
  if (logFn) logFn(msg);
  return geo;
}

/**
 * Extract launch context arguments for timezone/locale.
 */
export function getGeoLaunchArgs(profile: GeoProfile) {
  return {
    timezone: profile.timezone,
    locale: profile.locale,
  };
}

/**
 * Validate timezone and locale strings (basic sanity check).
 */
export function validateGeoProfile(profile: GeoProfile): boolean {
  const validTimezone = /^[A-Z][a-z]+\/[A-Za-z_]+$/.test(profile.timezone);
  const validLocale = /^[a-z]{2}(-[A-Z]{2})?$/.test(profile.locale);
  return validTimezone && validLocale;
}

