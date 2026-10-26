// Ask RAE daily job pull.
// Pulls U.S. admin-family roles posted on company career sites (ATS) from the
// Active Jobs DB API (Fantastic.jobs on RapidAPI), keeps only real admin roles,
// keeps a running store in data/paid.json, then merges it into public/jobs.json
// (which the free script has just written) for the website.
//
// Needs: Node 20+, env RAPIDAPI_KEY (stored as a GitHub Actions secret).
// Optional env: MODE=test (one 25-job call), MAX_JOBS per run (default 160 = Pro plan / 30 days),
// MAX_CALLS (default 40), KEEP_DAYS (default 30).

import { readFile, writeFile, mkdir } from "node:fs/promises";

const KEY = process.env.RAPIDAPI_KEY;
if (!KEY) { console.log("No RAPIDAPI_KEY, skipping paid pull."); process.exit(0); }
const HOST = "active-jobs-db.p.rapidapi.com";
// RapidAPI serves the 7-day window at /active-ats-7d (there is no 24h path there).
// Daily runs add date_filter so only the last ~26 hours come back.
const ENDPOINT = `https://${HOST}/active-ats-7d`;
const MODE = (process.env.MODE || "full").trim();
const TEST = MODE === "test";                       // one small call to check the data
const BACKFILL = MODE === "backfill";               // first run: last 7 days, bigger budget
const SINCE = new Date(Date.now() - 26 * 3600e3).toISOString().slice(0, 19);
const MAX_JOBS = Number(process.env.MAX_JOBS || (BACKFILL ? 1500 : 160)); // Pro plan: 5,000 jobs a month
const MAX_CALLS = Number(process.env.MAX_CALLS || 40);
const KEEP_DAYS = Number(process.env.KEEP_DAYS || 30);
const STORE = "data/paid.json";
const OUT = "public/jobs.json";

// One search per title family. Each call returns up to 100 jobs.
const ALL_SEARCHES = [
  "Executive Assistant",
  "Senior Executive Assistant",
  "Executive Business Partner",
  "Chief of Staff",
  "Administrative Assistant",
  "Administrative Coordinator",
  "Office Manager",
  "Receptionist",
  "Executive Coordinator",
  "Team Assistant",
  "Legal Administrative Assistant",
  "Board Liaison",
];
const SEARCHES = TEST ? ["Executive Assistant"] : ALL_SEARCHES;

// Keep the admin job family, drop look-alikes.
const INCLUDE = /(executive (assistant|business partner|coordinator|administrator)|administrative (assistant|coordinator|specialist|manager|services|supervisor)|admin(istrative)? assistant|chief of staff|office (manager|coordinator|assistant|administrator)|receptionist|front desk|team assistant|department assistant|personal assistant|board (liaison|relations)|executive office)/i;
const EXCLUDE = /(system(s)? admin|network admin|database admin|it admin|salesforce admin|linux|windows|sysadmin|devops|engineer|developer|physician|nurse|dental assistant|medical assistant\b(?!.*admin)|teacher|chief of staff,? (army|navy|air force)|veterinar)/i;

const STATES = {Alabama:"AL",Alaska:"AK",Arizona:"AZ",Arkansas:"AR",California:"CA",Colorado:"CO",Connecticut:"CT",Delaware:"DE","District of Columbia":"DC",Florida:"FL",Georgia:"GA",Hawaii:"HI",Idaho:"ID",Illinois:"IL",Indiana:"IN",Iowa:"IA",Kansas:"KS",Kentucky:"KY",Louisiana:"LA",Maine:"ME",Maryland:"MD",Massachusetts:"MA",Michigan:"MI",Minnesota:"MN",Mississippi:"MS",Missouri:"MO",Montana:"MT",Nebraska:"NE",Nevada:"NV","New Hampshire":"NH","New Jersey":"NJ","New Mexico":"NM","New York":"NY","North Carolina":"NC","North Dakota":"ND",Ohio:"OH",Oklahoma:"OK",Oregon:"OR",Pennsylvania:"PA","Rhode Island":"RI","South Carolina":"SC","South Dakota":"SD",Tennessee:"TN",Texas:"TX",Utah:"UT",Vermont:"VT",Virginia:"VA",Washington:"WA","West Virginia":"WV",Wisconsin:"WI",Wyoming:"WY"};
const ABBRS = new Set(Object.values(STATES));

function level(title) {
  const t = title.toLowerCase();
  if (/chief of staff|director|head of/.test(t)) return "cos";
  if (/senior|sr\.?|lead|principal|executive business partner|strategic/.test(t) && /executive|business partner/.test(t)) return "senior";
  if (/executive/.test(t)) return "ea";
  return "admin";
}

function workplace(j) {
  const a = String(j.ai_work_arrangement || "").toLowerCase();
  if (a.includes("hybrid")) return "Hybrid";
  if (a.includes("remote")) return "Remote";   // "Remote OK" and "Remote Solely"
  if (a.includes("site") || a.includes("office")) return "On-site";
  if (j.remote_derived === true) return "Remote";
  return "On-site";
}

function place(j) {
  // Prefer structured fields, fall back to "City, State, Country" strings.
  const city = (Array.isArray(j.cities_derived) && j.cities_derived[0]) || "";
  let state = (Array.isArray(j.regions_derived) && j.regions_derived[0]) || "";
  const loc = (Array.isArray(j.locations_derived) && j.locations_derived[0]) || "";
  let c = city;
  if ((!c || !state) && loc) {
    const parts = String(loc).split(",").map(s => s.trim());
    if (!c && parts.length >= 2) c = parts[0];
    if (!state && parts.length >= 2) state = parts[1];
  }
  const code = STATES[state] || (ABBRS.has(state) ? state : "");
  const countries = [].concat(j.countries_derived || []).map(String);
  const us = countries.length ? countries.some(x => /united states|^us$|^usa$/i.test(x)) : /united states|, (us|usa)$/i.test(loc) || !!code;
  return { city: c, state: code, us };
}

function pay(j) {
  const min = Number(j.ai_salary_minvalue || j.ai_salary_value || 0);
  const max = Number(j.ai_salary_maxvalue || j.ai_salary_value || 0);
  const unit = String(j.ai_salary_unittext || "YEAR").toUpperCase();
  const mult = unit === "HOUR" ? 2080 : unit === "MONTH" ? 12 : unit === "WEEK" ? 52 : 1;
  return { payMin: min ? Math.round(min * mult) : null, payMax: max ? Math.round(max * mult) : null };
}

let raw = 0;
async function call(title, offset) {
  const q = new URLSearchParams({ title_filter: `"${title}"`, location_filter: '"United States"', limit: String(TEST ? 25 : Math.min(100, Math.max(10, MAX_JOBS - raw))), offset: String(offset) });
  if (!TEST && !BACKFILL) q.set("date_filter", SINCE);
  const res = await fetch(`${ENDPOINT}?${q}`, { headers: { "x-rapidapi-key": KEY, "x-rapidapi-host": HOST } });
  if (!res.ok) throw new Error(`${res.status} ${await res.text().then(t => t.slice(0, 200))}`);
  const data = await res.json();
  return Array.isArray(data) ? data : (data.jobs || data.data || []);
}

async function main() {
  let prev = [];
  try { prev = JSON.parse(await readFile(STORE, "utf8")).jobs || []; } catch {}
  let sample = null;
  const byKey = new Map(prev.map(j => [j.url, j]));
  let calls = 0, kept = 0;
  const errors = [];

  for (const title of SEARCHES) {
    for (let offset = 0; offset < 500 && calls < MAX_CALLS && raw < MAX_JOBS; offset += 100) {
      calls++;
      let batch;
      try { batch = await call(title, offset); } catch (e) { errors.push(`${title} @${offset}: ${e.message}`); break; }
      raw += batch.length;
      if (TEST && batch[0]) {
        const j = batch[0];
        sample = { fields: Object.keys(j), first: j };
        console.log("SAMPLE FIELDS:", Object.keys(j).join(", "));
        console.log("SAMPLE:", JSON.stringify({ title: j.title, organization: j.organization, url: j.url, source: j.source, date_posted: j.date_posted, locations_derived: j.locations_derived, cities_derived: j.cities_derived, regions_derived: j.regions_derived, countries_derived: j.countries_derived, ai_work_arrangement: j.ai_work_arrangement, remote_derived: j.remote_derived, ai_salary_minvalue: j.ai_salary_minvalue, ai_salary_maxvalue: j.ai_salary_maxvalue, ai_salary_unittext: j.ai_salary_unittext }));
      }
      for (const j of batch) {
        const t = String(j.title || "");
        if (!INCLUDE.test(t) || EXCLUDE.test(t)) continue;
        const p = place(j);
        if (!p.us) continue;
        const wp = workplace(j);
        const url = j.url || j.external_apply_url;
        if (!url) continue;
        byKey.set(url, {
          title: t,
          company: j.organization || "",
          city: wp === "Remote" ? "" : p.city,
          state: wp === "Remote" ? "" : p.state,
          workplace: wp,
          ...pay(j),
          posted: j.date_posted || j.date_created || null,
          url,
          source: j.source || "",
          level: level(t),
        });
        kept++;
      }
      if (TEST || batch.length < 100) break;
    }
    if (raw >= MAX_JOBS) { errors.push(`Stopped at ${raw} jobs to stay inside the plan limit`); break;
    }
  }

  const cutoff = Date.now() - KEEP_DAYS * 864e5;
  const jobs = [...byKey.values()]
    .filter(j => !j.posted || Date.parse(j.posted) >= cutoff)
    .sort((a, b) => Date.parse(b.posted || 0) - Date.parse(a.posted || 0));

  const summary = { mode: MODE, at: new Date().toISOString(), calls, raw, keptThisRun: kept, storeTotal: jobs.length, errors };
  await mkdir("data", { recursive: true });
  await writeFile("data/paid-report.json", JSON.stringify({ summary, sample }, null, 1));
  console.log(JSON.stringify(summary, null, 2));
  if (TEST) return;                                  // test runs never touch the live list
  if (errors.length && calls === errors.length) process.exit(1);
  await writeFile(STORE, JSON.stringify({ generatedAt: summary.at, count: jobs.length, jobs }));

  // Merge with today's free list. Same job from both sources counts once.
  let free = { jobs: [] };
  try { free = JSON.parse(await readFile(OUT, "utf8")); } catch {}
  const norm = x => String(x || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const seen = new Set();
  const merged = [];
  for (const j of [...(free.jobs || []), ...jobs]) {
    const k1 = j.url, k2 = norm(j.company) + "|" + norm(j.title) + "|" + norm(j.city);
    if (seen.has(k1) || seen.has(k2)) continue;
    seen.add(k1); seen.add(k2);
    merged.push(j);
  }
  merged.sort((a, b) => (Date.parse(b.posted || 0) || 0) - (Date.parse(a.posted || 0) || 0));
  await mkdir("public", { recursive: true });
  await writeFile(OUT, JSON.stringify({ generatedAt: summary.at, count: merged.length, free: (free.jobs || []).length, paid: jobs.length, jobs: merged }));
  console.log(`Merged list: ${merged.length} roles`);
}

main();
