// Old fragment links keep working. A page that moved or renamed sections
// embeds a #legacy-fragment-map of old fragment -> new URL, and this script
// follows it. The page shows no list of them, so a no-JS reader stays on the
// page. Ordinary navigation stays native, including history.
(function () {
  const element = document.getElementById("legacy-fragment-map");
  if (!element) return;
  const destinations = JSON.parse(element.textContent);
  function followLegacyLink() {
    const id = window.location.hash.slice(1);
    if (!Object.hasOwn(destinations, id)) return;
    const destination = new URL(destinations[id], window.location.href);
    if (destination.href !== window.location.href)
      window.location.replace(destination.href);
  }
  window.addEventListener("hashchange", followLegacyLink);
  followLegacyLink();
})();
