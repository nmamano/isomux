// Old fragment links keep working. Ordinary guide selection uses native page
// navigation, including keyboard activation, history, and no-JS readers.
(function () {
  const element = document.getElementById("hosting-legacy-map");
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
