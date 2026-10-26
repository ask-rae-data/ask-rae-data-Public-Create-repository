// Ask RAE free job pull.
// Reads companies.json, asks each company's own career-site system for its open jobs
// (Greenhouse, Lever, Ashby and SmartRecruiters public job feeds, and Workday career
// sites), keeps U.S. admin-family roles, and writes:
//   public/jobs.json    the list the website reads
//   public/report.json  which companies worked, so broken entries can be fixed
// No API key needed. Node 20+.

import { readFile, writeFile, mkdir } from "node:fs/promises";

const UA = "AskRAE-JobBoard/1.0 (+https://rhondaaugustus.com/admin-job-board.html)";
const KEEP_DAYS = 60;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- What counts as an admin-family role ----------
const INCLUDE = /(executive (assistant|business partner|coordinator|administrator|admin)|administrative (assistant|coordinator|specialist|manager|services|supervisor|associate|professional)|admin(istrative)? assistant|chief of staff|office (manager|coordinator|assistant|administrator)|receptionist|front desk|team assistant|department(al)? assistant|personal assistant|board (liaison|relations)|executive office|business support (specialist|coordinator|manager)|workplace (coordinator|experience)|scheduling coordinator|legal (administrative )?assistant|ea to |ea,|\bea\b)/i;
const EXCLUDE = /(system(s)? admin|network admin|database admin|\bit admin|salesforce admin|platform admin|linux|windows|sysadmin|devops|engineer|developer|physician|nurse|\brn\b|dental assistant|medical assistant|pharmacy|teacher|teaching assistant|research assistant|lab assistant|veterinar|cashier|warehouse|driver|intern\b|internship|sales associate|caregiver|chief of staff,? (army|navy|air force)|military)/i;

function level(title) {
  const t = title.toLowerCase();
  if (/chief of staff|director|head of/.test(t)) return "cos";
  if (/(senior|sr\.?|lead|principal|executive business partner|strategic)/.test(t) && /(executive|business partner)/.test(t)) return "senior";
  if (/executive|\bea\b/.test(t)) return "ea";
  return "admin";
}

// ---------- Locations ----------
const STATES = {Alabama:"AL",Alaska:"AK",Arizona:"AZ",Arkansas:"AR",California:"CA",Colorado:"CO",Connecticut:"CT",Delaware:"DE","District of Columbia":"DC",Florida:"FL",Georgia:"GA",Hawaii:"HI",Idaho:"ID",Illinois:"IL",Indiana:"IN",Iowa:"IA",Kansas:"KS",Kentucky:"KY",Louisiana:"LA",Maine:"ME",Maryland:"MD",Massachusetts:"MA",Michigan:"MI",Minnesota:"MN",Mississippi:"MS",Missouri:"MO",Montana:"MT",Nebraska:"NE",Nevada:"NV","New Hampshire":"NH","New Jersey":"NJ","New Mexico":"NM","New York":"NY","North Carolina":"NC","North Dakota":"ND",Ohio:"OH",Oklahoma:"OK",Oregon:"OR",Pennsylvania:"PA","Rhode Island":"RI","South Carolina":"SC","South Dakota":"SD",Tennessee:"TN",Texas:"TX",Utah:"UT",Vermont:"VT",Virginia:"VA",Washington:"WA","West Virginia":"WV",Wisconsin:"WI",Wyoming:"WY"};
const ABBR = new Set(Object.values(STATES));
const FOREIGN = /(canada|toronto|vancouver|montreal|ontario|london|united kingdom|\buk\b|england|ireland|dublin|india|bengaluru|bangalore|hyderabad|mumbai|pune|germany|berlin|munich|france|paris|spain|madrid|barcelona|netherlands|amsterdam|poland|warsaw|portugal|lisbon|italy|milan|switzerland|zurich|sweden|stockholm|singapore|australia|sydney|melbourne|japan|tokyo|korea|seoul|china|shanghai|beijing|hong kong|taiwan|philippines|manila|mexico|brazil|são paulo|sao paulo|argentina|colombia|israel|tel aviv|dubai|uae|south africa|emea|apac|latam)/i;
const KNOWN_CITIES = { dallas: "TX", houston: "TX", austin: "TX", "san antonio": "TX", plano: "TX", irving: "TX", frisco: "TX", "fort worth": "TX", "new york": "NY", "new york city": "NY", brooklyn: "NY", "san francisco": "CA", "los angeles": "CA", "san jose": "CA", "san diego": "CA", "palo alto": "CA", "menlo park": "CA", "mountain view": "CA", "santa clara": "CA", seattle: "WA", bellevue: "WA", chicago: "IL", boston: "MA", cambridge: "MA", atlanta: "GA", denver: "CO", miami: "FL", "washington": "DC", "washington dc": "DC", "washington, d.c.": "DC", philadelphia: "PA", pittsburgh: "PA", phoenix: "AZ", nashville: "TN", charlotte: "NC", raleigh: "NC", minneapolis: "MN", detroit: "MI", portland: "OR", "salt lake city": "UT", columbus: "OH" };

function parseLoc(raw) {
  const s = String(raw || "").replace(/\s+/g, " ").trim();
  const out = { city: "", state: "", us: false, remote: /remote|work from home|virtual/i.test(s), hybrid: /hybrid/i.test(s) };
  if (!s) return out;
  // "US-TX-Dallas" / "USA - TX - Dallas"
  let m = s.match(/\bUS(?:A)?\s*[-,]\s*([A-Z]{2})\s*[-,]\s*([A-Za-z .'-]+)/);
  if (m && ABBR.has(m[1])) return { ...out, state: m[1], city: m[2].trim(), us: true };
  // "Dallas, TX" or "Dallas, Texas"
  m = s.match(/([A-Za-z .'-]+),\s*([A-Z]{2})\b/);
  if (m && ABBR.has(m[2])) return { ...out, city: cleanCity(m[1]), state: m[2], us: true };
  for (const [name, code] of Object.entries(STATES)) {
    const r = new RegExp(`([A-Za-z .'-]+),\\s*${name}\\b`);
    const mm = s.match(r);
    if (mm) return { ...out, city: cleanCity(mm[1]), state: code, us: true };
    if (new RegExp(`\\b${name}\\b`).test(s) && !(name === "Washington" && /washington,? d\.?c/i.test(s))) return { ...out, state: code, us: true };
  }
  const lc = s.toLowerCase();
  for (const [city, code] of Object.entries(KNOWN_CITIES)) {
    if (new RegExp(`\\b${city.replace(/[.,]/g, "\\$&")}\\b`).test(lc)) return { ...out, city: titleCase(city), state: code, us: true };
  }
  if (/united states|\busa\b|\bu\.s\.|\bus\b|north america|nationwide|anywhere in the us/i.test(s)) return { ...out, us: true };
  if (out.remote && !FOREIGN.test(s)) return { ...out, us: true };
  return out;
}
function cleanCity(c) { return c.replace(/^(remote|hybrid|on-?site|in-office)\s*[-–:|/]\s*/i, "").split(/[;|/]/).pop().trim(); }
function titleCase(c) { return c.replace(/\b\w/g, x => x.toUpperCase()); }

function workplaceFrom(text, explicit) {
  const e = String(explicit || "").toLowerCase();
  if (e.includes("hybrid")) return "Hybrid";
  if (e.includes("remote")) return "Remote";
  if (e.includes("onsite") || e.includes("on-site") || e.includes("in office") || e.includes("in-office")) return "On-site";
  const t = String(text || "");
  if (/hybrid/i.test(t)) return "Hybrid";
  if (/\bremote\b|work from home|virtual/i.test(t)) return "Remote";
  return "On-site";
}

// ---------- HTTP ----------
async function get(url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { "User-Agent": UA, Accept: "application/json", ...(opts.headers || {}) } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ---------- Sources ----------
async function greenhouse([token, name]) {
  const d = await get(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs`);
  return (d.jobs || []).map(j => ({
    title: j.title, company: name, loc: j.location?.name || "", wp: "",
    posted: j.first_published || j.updated_at || null, url: j.absolute_url, source: "Greenhouse",
  }));
}

async function lever([token, name]) {
  const d = await get(`https://api.lever.co/v0/postings/${encodeURIComponent(token)}?mode=json`);
  return (Array.isArray(d) ? d : []).map(j => {
    const sr = j.salaryRange || {};
    const mult = /hour/i.test(sr.interval || "") ? 2080 : /month/i.test(sr.interval || "") ? 12 : 1;
    return {
      title: j.text, company: name, loc: [j.categories?.location, ...(j.categories?.allLocations || [])].filter(Boolean).join("; "),
      wp: j.workplaceType || "", posted: j.createdAt ? new Date(j.createdAt).toISOString() : null, url: j.hostedUrl, source: "Lever",
      payMin: sr.min ? Math.round(sr.min * mult) : null, payMax: sr.max ? Math.round(sr.max * mult) : null,
    };
  });
}

async function ashby([token, name]) {
  const d = await get(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(token)}?includeCompensation=true`);
  return (d.jobs || []).filter(j => j.isListed !== false).map(j => {
    const a = j.address?.postalAddress || {};
    return {
      title: j.title, company: name,
      loc: [a.addressLocality, a.addressRegion, a.addressCountry].filter(Boolean).join(", ") || j.location || "",
      wp: j.workplaceType || (j.isRemote ? "remote" : ""), posted: j.publishedAt || null, url: j.jobUrl, source: "Ashby",
      payText: j.compensation?.compensationTierSummary || null,
    };
  });
}

async function smartrecruiters([id, name]) {
  const all = [];
  for (const q of ["assistant", "chief of staff", "office manager", "receptionist"]) {
    const d = await get(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(id)}/postings?q=${encodeURIComponent(q)}&limit=100`);
    for (const j of d.content || []) {
      const L = j.location || {};
      all.push({
        title: j.name, company: name, loc: [L.city, L.region, L.country === "us" ? "United States" : L.country].filter(Boolean).join(", "),
        wp: L.remote ? "remote" : L.hybrid ? "hybrid" : "", posted: j.releasedDate || null,
        url: `https://jobs.smartrecruiters.com/${id}/${j.id}`, source: "SmartRecruiters",
      });
    }
    await sleep(200);
  }
  return all;
}

function workdayPosted(txt) {
  const t = String(txt || "").toLowerCase();
  const now = Date.now();
  if (t.includes("today")) return new Date(now).toISOString();
  if (t.includes("yesterday")) return new Date(now - 864e5).toISOString();
  const m = t.match(/(\d+)\+?\s*days?/);
  if (m) return new Date(now - Number(m[1]) * 864e5).toISOString();
  return null;
}

async function workday([host, tenant, site, name]) {
  const all = [];
  const base = `https://${host}/wday/cxs/${tenant}/${site}/jobs`;
  for (const q of ["executive assistant", "administrative assistant", "chief of staff", "office manager"]) {
    for (let offset = 0; offset < 60; offset += 20) {
      const d = await get(base, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ appliedFacets: {}, limit: 20, offset, searchText: q }) });
      const rows = d.jobPostings || [];
      for (const j of rows) {
        all.push({
          title: j.title, company: name, loc: j.locationsText || "", wp: j.remoteType || "",
          posted: workdayPosted(j.postedOn), url: `https://${host}/${site}${j.externalPath}`, source: "Workday",
        });
      }
      await sleep(250);
      if (rows.length < 20) break;
    }
  }
  // Listings with "2 Locations" etc. need one more look to get the real places.
  for (const j of all) {
    if (!/\d+\s+locations/i.test(j.loc) || !INCLUDE.test(j.title) || EXCLUDE.test(j.title)) continue;
    try {
      const path = j.url.slice(`https://${host}/${site}`.length);
      const d = await get(`https://${host}/wday/cxs/${tenant}/${site}${path}`);
      const info = d.jobPostingInfo || {};
      j.loc = [info.location, ...(info.additionalLocations || []), info.country?.descriptor].filter(Boolean).join("; ");
      if (info.remoteType) j.wp = info.remoteType;
      await sleep(250);
    } catch {}
  }
  return all;
}

// ---------- Run ----------
async function runAll(list, fn, label, report, concurrency = 4) {
  const results = [];
  let i = 0;
  async function worker() {
    while (i < list.length) {
      const entry = list[i++];
      const name = entry[entry.length - 1];
      try {
        const jobs = await fn(entry);
        results.push(...jobs);
        report.push({ source: label, company: name, ok: true, openJobs: jobs.length });
      } catch (e) {
        report.push({ source: label, company: name, ok: false, error: e.message, entry });
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

async function main() {
  const companies = JSON.parse(await readFile("companies.json", "utf8"));
  const report = [];
  const raw = [
    ...(await runAll(companies.greenhouse || [], greenhouse, "Greenhouse", report)),
    ...(await runAll(companies.lever || [], lever, "Lever", report)),
    ...(await runAll(companies.ashby || [], ashby, "Ashby", report)),
    ...(await runAll(companies.smartrecruiters || [], smartrecruiters, "SmartRecruiters", report, 2)),
    ...(await runAll(companies.workday || [], workday, "Workday", report, 3)),
  ];

  const cutoff = Date.now() - KEEP_DAYS * 864e5;
  const seen = new Set();
  const jobs = [];
  let dropped = { notAdmin: 0, notUS: 0, old: 0, dup: 0 };
  for (const j of raw) {
    const title = String(j.title || "").trim();
    if (!INCLUDE.test(title) || EXCLUDE.test(title)) { dropped.notAdmin++; continue; }
    const p = parseLoc(j.loc);
    const wp = workplaceFrom(`${j.loc} ${title}`, j.wp);
    if (!p.us || FOREIGN.test(j.loc) && !p.state) { dropped.notUS++; continue; }
    if (j.posted && Date.parse(j.posted) < cutoff) { dropped.old++; continue; }
    const key = j.url || `${j.company}|${title}|${j.loc}`;
    if (seen.has(key)) { dropped.dup++; continue; }
    seen.add(key);
    jobs.push({
      title, company: j.company,
      city: wp === "Remote" ? "" : p.city, state: wp === "Remote" ? "" : p.state,
      workplace: wp, payMin: j.payMin ?? null, payMax: j.payMax ?? null, payText: j.payText ?? null,
      posted: j.posted, url: j.url, source: j.source, level: level(title),
    });
  }
  jobs.sort((a, b) => (Date.parse(b.posted || 0) || 0) - (Date.parse(a.posted || 0) || 0));

  const ok = report.filter(r => r.ok).length;
  const summary = { generatedAt: new Date().toISOString(), companiesChecked: report.length, companiesWorking: ok, rawJobs: raw.length, adminJobs: jobs.length, dropped };
  await mkdir("public", { recursive: true });
  await writeFile("public/jobs.json", JSON.stringify({ generatedAt: summary.generatedAt, count: jobs.length, jobs }));
  await writeFile("public/report.json", JSON.stringify({ summary, companies: report.sort((a, b) => a.source.localeCompare(b.source) || a.company.localeCompare(b.company)) }, null, 1));
  console.log(JSON.stringify(summary, null, 2));
  console.log("Not working:", report.filter(r => !r.ok).map(r => `${r.source}:${r.company} (${r.error})`).join(" | "));
}

main().catch(e => { console.error(e); process.exit(1); });
