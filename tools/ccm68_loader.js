// Loads the CCM68 feed (ccm68.json in topshelf-data, flat array of rows) --
// same pattern as ndc_loader.js/xp_loader.js.
// Order: GitHub raw (fresh) -> local ccm68.json -> [].
// Nothing on the site currently consumes this directly (as of Sept 2026,
// master.json's CCM68 Yes/No flag is still fed by the Sheet's own CCM68
// tab, not this file) -- this loader is published now for parity with the
// other migrated sources, ready for whenever a page needs raw CCM68 rows.
const CCM68_FEED_URL = "https://raw.githubusercontent.com/ppetrelli100/topshelf-data/main/ccm68.json";
function loadCCM68(){
  const get = u => fetch(u, { cache: "no-store" }).then(r => r.ok ? r.json() : Promise.reject(r.status));
  return get(CCM68_FEED_URL + "?_cb=" + Date.now())
    .catch(()=>get("ccm68.json?_cb=" + Date.now()))
    .catch(()=>[]);
}
