// Loads the NEPSAC feed (nepsac.json in topshelf-data, flat array of rows) --
// same pattern as ndc_loader.js/ccm68_loader.js.
// Order: GitHub raw (fresh) -> local nepsac.json -> [].
// Same status as ccm68_loader.js as of Sept 2026: nothing on the site
// consumes this directly yet -- it's an input that feeds Master's own
// NEPSAC tab computation on the Sheet side. Published now for parity/
// readiness, not because a page needs it today.
const NEPSAC_FEED_URL = "https://raw.githubusercontent.com/ppetrelli100/topshelf-data/main/nepsac.json";
function loadNEPSAC(){
  const get = u => fetch(u, { cache: "no-store" }).then(r => r.ok ? r.json() : Promise.reject(r.status));
  return get(NEPSAC_FEED_URL + "?_cb=" + Date.now())
    .catch(()=>get("nepsac.json?_cb=" + Date.now()))
    .catch(()=>[]);
}
