// Velcro Convert — boot. Loaded last so every feature file is defined before init runs.

(async function init() {
  checkLoginState();
  populateBanks();
  await fetchRequirements();
  fetchInstitutions();

  // Navigation Guard: Intercept browser & device Back button
  window.addEventListener('popstate', function () {
    if (_isNavBackTracking) {
      _isNavBackTracking = false;
      return;
    }

    // 1. If any modal / bottom sheet is open, close it cleanly without leaving the page
    if (typeof getTopOpenModal === 'function' && getTopOpenModal()) {
      closeTopOpenModal();
      return;
    }

    // 2. If an order payment screen is active, confirm before exiting to prevent loss of details
    const buyGen = document.getElementById('buy-generated-account');
    const sellGen = document.getElementById('sell-generated-address');
    const isBuyActive = buyGen && !buyGen.classList.contains('hidden');
    const isSellActive = sellGen && !sellGen.classList.contains('hidden');

    if (isBuyActive || isSellActive) {
      const leave = confirm('Leave this order? Your current payment details will be closed.');
      if (leave) {
        if (isBuyActive && typeof resetBuyTransaction === 'function') resetBuyTransaction();
        if (isSellActive && typeof resetSellTransaction === 'function') resetSellTransaction();
      } else {
        if (typeof pushOrderHistory === 'function') pushOrderHistory(isBuyActive ? 'buy' : 'sell');
      }
    }
  });

  // Reload / Tab Close Guard: Trigger native "Changes you made may not be saved" prompt
  window.addEventListener('beforeunload', function (e) {
    if (typeof hasUnsavedRampChanges === 'function' && hasUnsavedRampChanges()) {
      e.preventDefault();
      e.returnValue = '';
      return '';
    }
  });
})();
