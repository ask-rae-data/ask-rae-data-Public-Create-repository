// Removes job postings that are closed, expired, or no longer on the employer's site.
// Runs after the daily fetch. A posting is removed only on clear evidence (the employer's
// system says it does not exist, or the page says the job is closed). Anything uncertain
// (timeouts, blocked requests, server errors) is kept.
import { readFile, writeFile } from "node:fs/promises";

const JOBS = "public/jobs.json";
const STORE = "data/paid.json";
const CONCURRENCY = 16;
const TIMEOUT = 15000;
const UA = "Mozilla/5.0 (compatible; AskRAE-LinkCheck/1.0; +https://rhondaaugustus.com/admin-job-board.html)";

const CLOSED_TEXT = [
  "no longer available", "no longer accepting applications", "position has been filled",
  "this job has expired", "job posting has expired", "this posting has expired", "this position is closed",
  "this position has been closed", "job is closed", "job has been closed", "requisition is no longer",
  "job not found", "the job you are looking for", "posting is no longer", "this job is no longer",
  "position is no longer", "page you requested could not be found", "no longer open",
];

async function get(url, opts = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    return await fetch(url, { redirect: "follow", signal: ctl.signal, headers: { "User-Agent": UA, "Accept": opts.json ? "application/json" : "text/html,*/*" }, ...opts });
  } finally { clearTimeout(t); }
}

const ashbyCache = new Map();
async function ashbyIds(org) {
  if (!ashbyCache.has(org)) {
    ashbyCache.set(org, (async () => {
      const r = await get(`https://api.ashbyhq.com/posting-api/job-board/${org}`, { json: true });
      if (!r.ok) return null;
      const d = await r.json();
      return new Set((d.jobs || []).map(j => j.id));
    })().catch(() => null));
  }
  return ashbyCache.get(org);
}

// Returns "open", "closed", or "unknown", plus a reason.
async function check(url) {
  let u;
  try { u = new URL(url); } catch { return ["unknown", "bad url"]; }
  const host = u.hostname, parts = u.pathname.split("/").filter(Boolean);
  try {
    // Workday: ask the posting's own JSON endpoint.
    if (/myworkdayjobs\.com$|myworkdaysite\.com$/.test(host)) {
      const ji = parts.indexOf("job");
      if (ji > 0 && /myworkdayjobs\.com$/.test(host)) {
        const tenant = host.split(".")[0];
        const site = parts[ji - 1];
        const api = `https://${host}/wday/cxs/${tenant}/${site}/job/${parts.slice(ji + 1).join("/")}`;
        const r = await get(api, { json: true });
        if (r.status === 404 || r.status === 410) return ["closed", "workday 404"];
        if (r.ok) { const d = await r.json().catch(() => null); return d && d.jobPostingInfo ? ["open", "workday"] : ["unknown", "workday no info"]; }
        return ["unknown", "workday " + r.status];
      }
    }
    // Greenhouse public API.
    if (/greenhouse\.io$/.test(host)) {
      const ji = parts.indexOf("jobs");
      if (ji > 0) {
        const r = await get(`https://boards-api.greenhouse.io/v1/boards/${parts[ji - 1]}/jobs/${parts[ji + 1]}`, { json: true });
        if (r.status === 404) return ["closed", "greenhouse 404"];
        if (r.ok) return ["open", "greenhouse"];
        return ["unknown", "greenhouse " + r.status];
      }
    }
    // Ashby public job board API.
    if (host === "jobs.ashbyhq.com" && parts.length >= 2) {
      const ids = await ashbyIds(parts[0]);
      if (!ids) return ["unknown", "ashby board"];
      return ids.has(parts[1]) ? ["open", "ashby"] : ["closed", "ashby not listed"];
    }
    // SmartRecruiters public API.
    if (host === "jobs.smartrecruiters.com" && parts.length >= 2) {
      const id = (parts[1].match(/^\d+/) || [])[0];
      if (id) {
        const r = await get(`https://api.smartrecruiters.com/v1/companies/${parts[0]}/postings/${id}`, { json: true });
        if (r.status === 404) return ["closed", "smartrecruiters 404"];
        if (r.ok) { const d = await r.json().catch(() => ({})); return d.active === false ? ["closed", "smartrecruiters inactive"] : ["open", "smartrecruiters"]; }
        return ["unknown", "smartrecruiters " + r.status];
      }
    }
    // Everything else: load the page and look for clear signs it is gone.
    const r = await get(url);
    if (r.status === 404 || r.status === 410) return ["closed", "page " + r.status];
    if (!r.ok) return ["unknown", "page " + r.status];
    const final = r.url.toLowerCase();
    if (/[?&]error=true|jobnotfound|job-not-found|notfound|expired|jobclosed/.test(final) && final !== url.toLowerCase()) return ["closed", "redirected to not-found"];
    if (host === "jobs.lever.co" && parts.length >= 2 && !final.includes(parts[1].toLowerCase())) return ["closed", "lever redirected"];
    const text = (await r.text()).slice(0, 400000).toLowerCase();
    const hit = CLOSED_TEXT.find(p => text.includes(p));
    if (hit) return ["closed", "page says: " + hit];
    return ["open", "page ok"];
  } catch (e) {
    return ["unknown", e.name === "AbortError" ? "timeout" : "error"];
  }
}

const data = JSON.parse(await readFile(JOBS, "utf8"));
const jobs = data.jobs || [];
const urls = [...new Set(jobs.map(j => j.url).filter(Boolean))];
const result = new Map();
let i = 0;
async function worker() {
  while (i < urls.length) { const url = urls[i++]; result.set(url, await check(url)); }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

const closed = urls.filter(u => result.get(u)[0] === "closed");
const tally = {};
for (const [, [state, why]] of result) { const k = state + ": " + why.replace(/page says: .*/, "page says closed"); tally[k] = (tally[k] || 0) + 1; }
const share = closed.length / Math.max(1, urls.length);
const report = { checkedAt: new Date().toISOString(), checked: urls.length, closed: closed.length, applied: false, tally, removed: [] };

// Safety: if a large share looks closed, something is blocking the check. Change nothing.
if (share > 0.4) {
  report.note = "Too many postings looked closed; nothing was removed.";
} else {
  const gone = new Set(closed);
  const keep = jobs.filter(j => !gone.has(j.url));
  report.removed = jobs.filter(j => gone.has(j.url)).map(j => ({ title: j.title, company: j.company, url: j.url, why: result.get(j.url)[1] }));
  data.jobs = keep;
  data.count = keep.length;
  data.removedClosed = report.removed.length;
  if (Array.isArray(data.featured)) data.featured = data.featured.filter(j => !gone.has(j.url));
  await writeFile(JOBS, JSON.stringify(data));
  try {
    const store = JSON.parse(await readFile(STORE, "utf8"));
    if (Array.isArray(store.jobs)) {
      store.jobs = store.jobs.filter(j => !gone.has(j.url));
      store.count = store.jobs.length;
      await writeFile(STORE, JSON.stringify(store));
    }
  } catch {}
  report.applied = true;
}
await writeFile("public/live-check.json", JSON.stringify(report, null, 1));
console.log(`Checked ${urls.length}, closed ${closed.length}${report.applied ? " (removed)" : " (not applied)"}`);
console.log(tally);
