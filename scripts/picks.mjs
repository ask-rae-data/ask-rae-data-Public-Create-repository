// Ask RAE picks: chooses the featured roles for the top of the board and the twice-weekly LinkedIn post.
// Banner rules (chooseFeatured): EA / senior EA / admin assistant, $80K+ floor, Texas first,
// then other states, never CA, NY, DC, MA, WA, NJ, CT. Post rules (choose): big cities, $60K+.
import { readFile, writeFile } from "node:fs/promises";

const FILE = "public/jobs.json";
const BIG_CITIES = new Set([
  "new york", "new york city", "manhattan", "brooklyn", "los angeles", "chicago", "houston", "dallas", "fort worth",
  "plano", "irving", "frisco", "austin", "san antonio", "san francisco", "san jose", "palo alto", "menlo park",
  "mountain view", "santa clara", "seattle", "bellevue", "redmond", "boston", "cambridge", "washington",
  "arlington", "atlanta", "miami", "denver", "phoenix", "scottsdale", "philadelphia", "san diego", "charlotte",
  "nashville", "minneapolis", "detroit", "tampa", "orlando", "raleigh", "portland", "salt lake city", "las vegas",
  "baltimore", "pittsburgh", "st. louis", "columbus", "indianapolis", "kansas city", "jersey city", "newark",
  "stamford", "greenwich", "irvine", "santa monica", "oakland", "sacramento"
]);
const CORE = /(executive assistant|executive business partner|executive administrator|administrative assistant|admin assistant)/i;
const NOT = /(receptionist|front desk|manager|director|chief of staff|coordinator|intern|temporary|temp\b|part[- ]time)/i;

const annual = j => j.payMax || j.payMin || 0;
const ageDays = j => j.posted ? (Date.now() - Date.parse(j.posted)) / 864e5 : 99;

// Featured banner: prove six-figure-level admin pay exists outside the well-known high-pay states.
// Texas first, $80K+; any empty spots come from other states, never the high-pay ones below.
const HIGH_PAY_STATES = new Set(["CA", "NY", "DC", "MA", "WA", "NJ", "CT"]);
function chooseFeatured(jobs, n) {
  const base = jobs
    .filter(j => CORE.test(j.title) && !NOT.test(j.title))
    .filter(j => j.workplace && j.city && j.state && j.workplace !== "Remote")
    // The bottom of the posted range must be $80K+, so "$65K–$151K" doesn't count.
    .filter(j => (j.payMin || j.payMax || 0) >= 80000 && annual(j) <= 400000)
    .sort((a, b) => annual(b) - annual(a));
  // Texas roles may be up to 14 days old (fewer Texas postings list pay); other states 7 days.
  const tx = base.filter(j => j.state === "TX" && ageDays(j) <= 14);
  const rest = base.filter(j => j.state !== "TX" && !HIGH_PAY_STATES.has(j.state) && ageDays(j) <= 7);
  const out = [], seenCo = new Set(), seenCity = new Set();
  const take = (list, uniqueCity) => {
    for (const j of list) {
      if (out.length >= n) return;
      const co = (j.company || "").toLowerCase(), city = j.city.toLowerCase();
      if (seenCo.has(co) || (uniqueCity && seenCity.has(city))) continue;
      out.push(j); seenCo.add(co); seenCity.add(city);
    }
  };
  take(tx, true);    // Texas, different cities first
  take(tx, false);   // then more Texas, even in the same city
  take(rest, true);  // then other lower-cost states
  return out;
}

function choose(jobs, n, maxAge) {
  const pool = jobs
    .filter(j => CORE.test(j.title) && !NOT.test(j.title))
    .filter(j => j.workplace && j.city && BIG_CITIES.has(j.city.toLowerCase()))
    .filter(j => annual(j) >= 60000 && annual(j) <= 400000)
    .filter(j => ageDays(j) <= maxAge)
    .sort((a, b) => annual(b) - annual(a));
  const out = [], seenCo = new Set(), seenCity = new Set();
  for (const j of pool) {
    const co = (j.company || "").toLowerCase(), city = j.city.toLowerCase();
    if (seenCo.has(co) || (out.length < 3 && seenCity.has(city))) continue;
    out.push(j); seenCo.add(co); seenCity.add(city);
    if (out.length >= n) break;
  }
  return out;
}

const money = v => "$" + Math.round(v / 1000) + "K";
function payText(j) {
  if (j.payMin && j.payMax && j.payMax !== j.payMin) return `${money(j.payMin)}–${money(j.payMax)}`;
  return money(j.payMax || j.payMin);
}

const data = JSON.parse(await readFile(FILE, "utf8"));
const jobs = data.jobs || [];
// Prefer roles from the last 3 days; widen to 7 days only if needed.
const featured = chooseFeatured(jobs, 3);
let post = choose(jobs, 5, 4);
if (post.length < 5) post = choose(jobs, 5, 8);

data.featured = featured.map(j => ({ ...j, payText: payText(j) }));
await writeFile(FILE, JSON.stringify(data));

const day = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "America/Chicago" });
const lines = post.map((j, i) =>
  `${i + 1}. ${j.title} | ${j.company}\n   ${j.city}, ${j.state} · ${j.workplace} · ${payText(j)}`);
const text = `ASK RAE PICKS · ${day}
Ready to paste. Swap any role you don't love: the full list is on the board.

---

Open roles for admins and executive assistants 👇

${lines.join("\n\n")}

Every role comes straight from the company's own career site, posted in the last few days.

Search 1,500+ admin and EA roles by city, state, and on-site / hybrid / remote:
rhondaaugustus.com/admin-job-board.html

Interview coming up? Grab my free guide, Interview Like an Executive Business Partner:
rhondaaugustus.com/free-interview-guide.html

#ExecutiveAssistant #AdministrativeProfessional #AdminJobs #EAJobs #AskRAE

---

Apply links (for your own reference, not for the post):
${post.map((j, i) => `${i + 1}. ${j.url}`).join("\n")}
`;
await writeFile("public/ask-rae-post.txt", text);
await writeFile("public/picks.json", JSON.stringify({ generatedAt: new Date().toISOString(), featured: data.featured, post }, null, 1));
console.log(`Featured ${featured.length}, post picks ${post.length}`);
