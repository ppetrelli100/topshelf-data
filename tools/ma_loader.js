// Loads the MA (Massachusetts state camp selection) feed -- ma.json in
// topshelf-data, flat array of rows tracking each player's progression
// through the MA regional/festival/NDC selection ladder by birth year.
// Same pattern as ccm68_loader.js/nepsac_loader.js/ep_loader.js.
// Order: GitHub raw (fresh) -> local ma.json -> [].
// Input only for now (Sept 2026) -- nothing on the site consumes this yet,
// and Master still reads its own MA Sheet tab, not this feed. See
// tools/MA_NOTES.md for the eligibility ladder and known data notes.
const MA_FEED_URL = "https://raw.githubusercontent.com/ppetrelli100/topshelf-data/main/ma.json";
function loadMA(){
  const get = u => fetch(u, { cache: "no-store" }).then(r => r.ok ? r.json() : Promise.reject(r.status));
  return get(MA_FEED_URL + "?_cb=" + Date.now())
    .catch(()=>get("ma.json?_cb=" + Date.now()))
    .catch(()=>[]);
}
