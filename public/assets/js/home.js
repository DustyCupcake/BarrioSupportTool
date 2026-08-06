import { switchTab } from './app.js?v=1.0.3';
import { t } from './i18n.js?v=1.0.1';

const _h = (key) => t('home', key);

export function init(container, user) {
  const perms = user?.permissions || [];
  render(container, perms);
}

function render(container, perms) {
  const secondaryBtns = buildSecondary(perms);

  container.innerHTML = `
    <div class="home-wrap">
      <button class="home-scan-btn" id="home-scan-btn">
        <span class="home-scan-icon">&#x1F4F7;</span> ${_h('scan')}
      </button>
      ${buildSecondaryHtml(secondaryBtns)}
    </div>`;

  document.getElementById('home-scan-btn')?.addEventListener('click', () => switchTab('scanner'));

  container.querySelectorAll('.home-sec-btn[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
}

function buildSecondary(perms) {
  const has = p => perms.includes(p);
  const btns = [];

  if (has('view_groups')) {
    btns.push({ tab: 'groups', label: _h('barriosMgmt'), sub: _h('barriosMgmtSub') });
  }

  return btns;
}

function buildSecondaryHtml(btns) {
  if (!btns.length) return '';
  return `<div class="home-secondary">
    ${btns.map(b => `
      <button class="home-sec-btn" data-tab="${b.tab}">
        ${b.label}
        <span class="home-sec-sub">${b.sub}</span>
      </button>`).join('')}
  </div>`;
}
