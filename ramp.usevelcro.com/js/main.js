// Velcro Convert — boot. Loaded last so every feature file is defined before init runs.

(async function init() {
  checkLoginState();
  populateBanks();
  await fetchRequirements();
  fetchInstitutions();
})();
