/**
 * Logo Fetcher — attempts to find a real brand logo from the web.
 * Adapted from PocketSIC.
 *
 * Strategy (tried in order):
 *   1. Extract domain from provided website URL
 *   2. Map brand name to known domain
 *   3. Guess brandname.com
 *   Then try: Apistemic Logo API → Google Favicon v2
 *
 * Note: Clearbit Logo API was shut down December 2025.
 *       Apistemic (logos-api.apistemic.com) is a free drop-in replacement
 *       that requires no API key.
 */

const https = require('https');
const http = require('http');

// Well-known brand → domain mappings
const BRAND_DOMAINS = {
  'nike': 'nike.com',
  'adidas': 'adidas.com',
  'apple': 'apple.com',
  'google': 'google.com',
  'amazon': 'amazon.com',
  'starbucks': 'starbucks.com',
  'coca-cola': 'coca-cola.com',
  'coca cola': 'coca-cola.com',
  'pepsi': 'pepsi.com',
  'microsoft': 'microsoft.com',
  'salesforce': 'salesforce.com',
  'tesla': 'tesla.com',
  'spotify': 'spotify.com',
  'netflix': 'netflix.com',
  'disney': 'disney.com',
  'target': 'target.com',
  'walmart': 'walmart.com',
  'patagonia': 'patagonia.com',
  'the north face': 'thenorthface.com',
  'north face': 'thenorthface.com',
  'lululemon': 'lululemon.com',
  'rei': 'rei.com',
  'allbirds': 'allbirds.com',
  'warby parker': 'warbyparker.com',
  'glossier': 'glossier.com',
  'airbnb': 'airbnb.com',
  'uber': 'uber.com',
  'lyft': 'lyft.com',
  'slack': 'slack.com',
  'zoom': 'zoom.us',
  'stripe': 'stripe.com',
  'shopify': 'shopify.com',
  'hubspot': 'hubspot.com',
  'zendesk': 'zendesk.com',
  'twilio': 'twilio.com',
  'datadog': 'datadoghq.com',
  'snowflake': 'snowflake.com',
  'servicenow': 'servicenow.com',
  'workday': 'workday.com',
  'figma': 'figma.com',
  'notion': 'notion.so',
  'canva': 'canva.com',
  'sephora': 'sephora.com',
  'bmw': 'bmw.com',
  'mercedes': 'mercedes-benz.com',
  'mercedes-benz': 'mercedes-benz.com',
  'ford': 'ford.com',
  'toyota': 'toyota.com',
  'honda': 'honda.com',
  'samsung': 'samsung.com',
  'sony': 'sony.com',
  'dell': 'dell.com',
  'hp': 'hp.com',
  'ibm': 'ibm.com',
  'oracle': 'oracle.com',
  'sap': 'sap.com',
  'adobe': 'adobe.com',
  'intuit': 'intuit.com',
  'chase': 'chase.com',
  'wells fargo': 'wellsfargo.com',
  'bank of america': 'bankofamerica.com',
  'american express': 'americanexpress.com',
  'amex': 'americanexpress.com',
  'visa': 'visa.com',
  'mastercard': 'mastercard.com',
  'paypal': 'paypal.com',
  'square': 'squareup.com',
  'robinhood': 'robinhood.com',
  'coinbase': 'coinbase.com',
  'whole foods': 'wholefoodsmarket.com',
  'trader joes': 'traderjoes.com',
  "trader joe's": 'traderjoes.com',
  'costco': 'costco.com',
  'home depot': 'homedepot.com',
  'lowes': 'lowes.com',
  "lowe's": 'lowes.com',
  'best buy': 'bestbuy.com',
  'wayfair': 'wayfair.com',
  'etsy': 'etsy.com',
  'williams sonoma': 'williams-sonoma.com',
  'williams-sonoma': 'williams-sonoma.com',
  'pottery barn': 'potterybarn.com',
  'crate and barrel': 'crateandbarrel.com',
  'crate & barrel': 'crateandbarrel.com',
  'yeti': 'yeti.com',
  'peloton': 'onepeloton.com',
  'under armour': 'underarmour.com',
  'new balance': 'newbalance.com',
  'puma': 'puma.com',
  'reebok': 'reebok.com',
  'converse': 'converse.com',
  'vans': 'vans.com',
  'ralph lauren': 'ralphlauren.com',
  'gucci': 'gucci.com',
  'louis vuitton': 'louisvuitton.com',
  'prada': 'prada.com',
  'burberry': 'burberry.com',
  'chanel': 'chanel.com',
  'tiffany': 'tiffany.com',
  'rolex': 'rolex.com',
  'marriott': 'marriott.com',
  'hilton': 'hilton.com',
  'hyatt': 'hyatt.com',
  'southwest': 'southwest.com',
  'delta': 'delta.com',
  'united': 'united.com',
  'american airlines': 'aa.com',
  'jetblue': 'jetblue.com',
  'doordash': 'doordash.com',
  'instacart': 'instacart.com',
  'chipotle': 'chipotle.com',
  'mcdonalds': 'mcdonalds.com',
  "mcdonald's": 'mcdonalds.com',
  'chick-fil-a': 'chick-fil-a.com',
  'shake shack': 'shakeshack.com',
};

/**
 * Extract domain from a website URL.
 */
function extractDomain(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url.startsWith('http') ? url : `https://${url}`);
    return parsed.hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/**
 * Guess a domain from a brand name.
 */
function guessDomain(brandName, websiteUrl) {
  // First: use the website URL if provided
  if (websiteUrl) {
    const domain = extractDomain(websiteUrl);
    if (domain) return domain;
  }

  if (!brandName) return null;
  const normalized = brandName.toLowerCase().trim();

  // Check known mappings
  if (BRAND_DOMAINS[normalized]) return BRAND_DOMAINS[normalized];

  // Skip fictional Salesforce demo brands
  const fictional = [
    'northern trail outfitters', 'nto', 'cumulus',
    'dreamhouse realty', 'dreamhouse', 'ursus fitness', 'ursus',
    'coral cloud', 'coral cloud resorts', 'astro', 'codey',
  ];
  if (fictional.includes(normalized)) return null;

  // Guess: strip and build domain
  const slug = normalized
    .replace(/['']/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '')
    .trim();

  return slug ? `${slug}.com` : null;
}

/**
 * Check if a URL returns a valid image by downloading the full body.
 * Uses actual byte size (not Content-Length header) to avoid rejecting
 * small but valid logos (e.g. Sephora's 890-byte Apistemic logo).
 *
 * @param {string} url - Image URL to check
 * @param {number} maxRedirects - Max redirect hops (default 5)
 * @param {number} minSize - Minimum body size in bytes (default 500)
 */
function checkImageUrl(url, maxRedirects = 5, minSize = 500) {
  return new Promise((resolve) => {
    const protocol = url.startsWith('https') ? https : http;
    const req = protocol.get(url, { timeout: 8000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && maxRedirects > 0) {
        const redirectUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        res.resume();
        return checkImageUrl(redirectUrl, maxRedirects - 1, minSize).then(resolve);
      }

      const contentType = res.headers['content-type'] || '';
      // Download the full body to measure actual size (don't rely on Content-Length header)
      let size = 0;
      res.on('data', c => size += c.length);
      res.on('end', () => {
        const isValid = res.statusCode === 200
          && (contentType.startsWith('image/') || contentType.includes('svg'))
          && size > minSize;
        resolve(isValid);
      });
    });

    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

/**
 * Try to fetch a real logo for a brand.
 *
 * @param {string} brandName - The brand name
 * @param {string} websiteUrl - Optional website URL
 * @returns {Promise<{found: boolean, url?: string, source?: string}>}
 */
async function fetchBrandLogo(brandName, websiteUrl) {
  const domain = guessDomain(brandName, websiteUrl);
  if (!domain) return { found: false };

  // Strategy 1: Apistemic Logo API (high-res, no API key required)
  const apistemicUrl = `https://logos-api.apistemic.com/domain:${domain}`;
  try {
    if (await checkImageUrl(apistemicUrl)) {
      console.log(`[LogoFetcher] Found logo for "${brandName}" via Apistemic: ${apistemicUrl}`);
      return { found: true, url: apistemicUrl, source: 'apistemic' };
    }
  } catch (_) { /* continue */ }

  // Strategy 2: Google Favicon (128px)
  const googleUrl = `https://www.google.com/s2/favicons?sz=128&domain=${domain}`;
  try {
    if (await checkImageUrl(googleUrl)) {
      console.log(`[LogoFetcher] Found favicon for "${brandName}" via Google: ${googleUrl}`);
      return { found: true, url: googleUrl, source: 'google-favicon' };
    }
  } catch (_) { /* continue */ }

  console.log(`[LogoFetcher] No logo found for "${brandName}" (tried domain: ${domain})`);
  return { found: false };
}

module.exports = { fetchBrandLogo, guessDomain, BRAND_DOMAINS };
