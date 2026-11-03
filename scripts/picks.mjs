// Ask RAE picks: chooses the featured roles for the top of the board and the twice-weekly LinkedIn post.
// Rules: executive assistant / senior EA / administrative assistant roles only, posted recently,
// strong pay, in a large, popular city, with on-site / hybrid / remote stated.
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
let featured = choose(jobs, 3, 3);
if (featured.length < 3) featured = choose(jobs, 3, 7);
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
