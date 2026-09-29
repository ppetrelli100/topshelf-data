// Loads the EP feed (ep.json in topshelf-data, flat array of rows) --
// same pattern as ndc_loader.js/ccm68_loader.js/nepsac_loader.js.
// Order: GitHub raw (fresh) -> local ep.json -> [].
// This is a one-way reference lookup (fills gaps like DOB when nothing else
// has one), not a page feed -- as of Sept 2026 nothing consumes it directly.
// See tools/EP_NOTES.md before writing anything that joins this to Master:
// personkey alone is not a safe join key here (see collision notes), and
// source priority for a given field is not a fixed rule across all fields.
const EP_FEED_URL = "https://raw.githubusercontent.com/ppetrelli100/topshelf-data/main/ep.json";
function loadEP(){
  const get = u => fetch(u, { cache: "no-store" }).then(r => r.ok ? r.json() : Promise.reject(r.status));
  return get(EP_FEED_URL + "?_cb=" + Date.now())
    .catch(()=>get("ep.json?_cb=" + Date.now()))
    .catch(()=>[]);
}
