/* Shared top navigation. One list, so every page shows the same buttons in the same order.
   A page calls loanNav.links('graph') (or tracker, cashflow, combined, home) and puts the result
   at the start of its #topSw box, ahead of Settings and Display. The current page is highlighted. */
(function () {
  'use strict';
  const ITEMS = [
    ['home', '🏠 Home', 'index.html', 'All the tools'],
    ['graph', 'Loan graph', 'graph.html', 'Every path out of a loan'],
    ['tracker', 'Loan Tracker', 'tracker.html', 'Track one real loan'],
    ['cashflow', '💰 Cash-flow', 'cashflow.html', 'Plan your pays, bills and goals'],
    ['combined', '⧉ Combined view', 'desktop.html', 'Graph and Tracker side by side on one screen']
  ];
  function links(current) {
    return ITEMS.map(([key, label, href, tip]) => {
      const a = document.createElement('a');
      a.href = href; a.textContent = label; a.title = tip; a.dataset.nav = key;
      if (key === 'combined') a.id = 'combSw';
      if (key === current) a.setAttribute('aria-current', 'page');
      return a;
    });
  }
  function mount(box, current) { if (box) box.prepend(...links(current)); }
  window.loanNav = { items: ITEMS, links, mount };
})();
