// Prints a reproducible, offline regional catalogue. Never reads deployment secrets.
const cldr = 'https://raw.githubusercontent.com/unicode-org/cldr-json/48.0.0/';
const iana = 'https://data.iana.org/time-zones/tzdb-2025b/';
async function read(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Regional source unavailable: ${response.status}`);
  return response.text();
}
const [countries, zones, currencyJson, localeJson, licence] = await Promise.all([
  read(`${iana}iso3166.tab`), read(`${iana}zone.tab`),
  read(`${cldr}cldr-json/cldr-core/supplemental/currencyData.json`),
  read(`${cldr}cldr-json/cldr-core/supplemental/likelySubtags.json`), read(`${cldr}LICENSE`),
]);
const regions = JSON.parse(currencyJson).supplemental.currencyData.region;
const likely = JSON.parse(localeJson).supplemental.likelySubtags;
const asOf = '2026-09-12';
const zoneRows = zones.split('\n').filter(line => line && !line.startsWith('#')).map(line => line.split('\t'));
const names = new Intl.DisplayNames(['en'], { type: 'region' });
const rows = countries.split('\n').filter(line => line && !line.startsWith('#')).map(line => {
  const [code] = line.split('\t');
  const currencies = (regions[code] || []).flatMap(entry => Object.entries(entry))
    .filter(([, dates]) => dates._tender !== 'false' && (!dates._from || dates._from <= asOf) && (!dates._to || dates._to >= asOf))
    .map(([currency]) => currency);
  const locale = (likely[`und-${code}`] || `en-${code}`).split('-').filter(part => part.length !== 4).join('-');
  return { code, name: names.of(code), currencies: [...new Set(currencies)], locale, timeZones: zoneRows.filter(row => row[0] === code).map(row => row[2]) };
}).sort((a, b) => a.name.localeCompare(b.name, 'en'));
process.stdout.write(JSON.stringify({ rows, licence }));
