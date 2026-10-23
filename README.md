# Ask RAE job data

Daily list of U.S. admin and executive assistant jobs from company career sites,
used by the Admin Job Board at rhondaaugustus.com.

- `scripts/fetch-jobs.mjs` pulls and filters the jobs.
- `.github/workflows/update-jobs.yml` runs it every morning and publishes `jobs.json`.
- The API key lives in the repository secret `RAPIDAPI_KEY`. Never commit it.
