/**
 * DENTIVA — application window entry point.
 *
 * Boots the shell: resolves the session, shows the first-run wizard or the sign
 * in screen when needed, builds the navigation, starts the router and wires the
 * global chrome (notifications, search palette, language, lock screen, hotkeys).
 */
import { api, ApiError, setErrorTranslator } from './core/api.js';
import { clearSession, can, emit, isSignedIn, loadSession, state, subscribe } from './core/store.js';
import { debounce, el, h, mount, openModal, toast } from './core/dom.js';
import { navigate, parseHash, refresh, startRouter } from './core/router.js';
import { NAV_GROUPS, titleFor } from './core/nav.js';
import { createTranslator, LOCALE_LABELS, normaliseLocale } from '/shared/i18n/index.js';
import { initials } from './core/format.js';
import { renderLogin, renderFirstRun } from './views/session.js';
import { registerRoutes } from './views/index.js';

/** @type {any} */
let t = createTranslator('en');
const IDLE_LIMIT_MS = 30 * 60 * 1000;
const IDLE_WARN_MS = 60 * 1000;
let idleTimer = 0;
let idleWarnTimer = 0;
let locked = false;

export function translator() {
  return t;
}

export function setLocale(locale) {
  state.locale = normaliseLocale(locale);
  t = createTranslator(state.locale);
  setErrorTranslator((key, params) => t(key, params));
  document.documentElement.lang = state.locale;
  document.body.classList.toggle('lang-bn', state.locale === 'bn');
  document.title = t('app.windowTitle');
}

/* ------------------------------------------------------------------ layout */

function renderShell() {
  const visible = NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => !item.permission || can(item.permission)),
  })).filter((group) => group.items.length);

  mount('#nav', visible.map((group) => h('div', {}, [
    h('div', { class: 'nav-group-title' }, t(group.label)),
    group.items.map((item) => h('button', {
      type: 'button',
      class: `nav-item ${parseHash().path.startsWith(item.path) ? 'active' : ''}`,
      dataset: { path: item.path, nav: '1' },
      onclick: () => {
        navigate(item.path);
        document.body.classList.remove('nav-open');
      },
    }, [h('span', { class: 'nav-icon', 'aria-hidden': 'true' }, item.icon), h('span', { class: 'nav-label' }, t(item.label))])),
  ])));

  const clinicName = state.clinic?.name ?? '';
  mount('#brandClinic', clinicName);
  mount('#appVersion', state.app ? t('app.version', { version: state.app.version, build: state.app.build }) : '');
  mount('#accountName', state.session?.displayName ?? '');
  mount('#accountAvatar', initials(state.session?.displayName));
  mount('#languageLabel', state.locale === 'bn' ? 'বাং' : 'EN');
}

export function renderChrome() {
  renderShell();
  highlightNav();
}

function highlightNav() {
  const path = parseHash().path;
  for (const button of /** @type {any} */ ([...document.querySelectorAll('#nav .nav-item')])) {
    button.classList.toggle('active', path.startsWith(button.dataset.path));
  }
}

export function setPageTitle(key, subtitle = '') {
  mount('#pageTitle', t(key));
  mount('#pageSubtitle', subtitle);
}

/* ------------------------------------------------------------- boot phases */

async function boot() {
  const status = await api.get('/api/auth/status');
  if (status?.firstRun) {
    renderFirstRunScreen(status?.dataDir ?? '');
    return;
  }
  if (!status?.authenticated) {
    renderLoginScreen();
    return;
  }
  await enterApplication();
}

function renderLoginScreen() {
  el('#boot').hidden = true;
  el('#app').hidden = true;
  mount('#view', [renderLogin({ t, onSignedIn: () => enterApplication() })]);
}

function renderFirstRunScreen(dataDir = '') {
  el('#boot').hidden = true;
  el('#app').hidden = true;
  mount('#view', [renderFirstRun({ t, onDone: () => window.location.reload(), dataDir })]);
}

async function enterApplication() {
  await loadSession();
  setLocale(state.locale);
  el('#boot').hidden = true;
  el('#app').hidden = false;
  renderChrome();
  registerRoutes({ t: () => t });
  startRouter({
    notFound: () => {
      mount('#view', [h('div', { class: 'empty-state' }, [
        h('h3', {}, t('errors.notFound')),
        h('p', { class: 'muted' }, parseHash().path),
      ])]);
    },
    onError: (error) => renderError(error),
  });
  subscribe(() => renderShell());
  startIdleWatch();
  refreshNotificationBadge();
  window.setInterval(refreshNotificationBadge, 60_000);
  window.setInterval(async () => {
    try {
      await api.post('/api/session/keepalive', {});
    } catch {
      /* the session expired; the next request reports it */
    }
  }, 5 * 60_000);
}

export function renderError(error) {
  const message = error instanceof ApiError ? error.message : String(error?.message ?? error);
  mount('#view', [h('div', { class: 'card' }, [
    h('div', { class: 'card-head' }, h('h2', {}, t('app.startupError'))),
    h('div', { class: 'card-body stack' }, [
      h('div', { class: 'alert' }, message),
      h('div', { class: 'row-actions' }, h('button', { type: 'button', class: 'ghost', onclick: () => refresh() }, t('app.retry'))),
    ]),
  ])]);
}

/* ---------------------------------------------------------------- chrome */

function toggleAccountMenu() {
  const menu = el('#accountMenu');
  if (!menu.hidden) {
    menu.hidden = true;
    return;
  }
  menu.hidden = false;
  const close = (event) => {
    if (!menu.contains(event.target) && !event.target.closest('#accountButton')) {
      menu.hidden = true;
      document.removeEventListener('mousedown', close);
    }
  };
  document.addEventListener('mousedown', close);
}

async function signOut() {
  try {
    await api.post('/api/auth/logout', {});
  } catch {
    /* ignore */
  }
  clearSession();
  window.location.hash = '';
  window.location.reload();
}

function lockScreen() {
  if (locked) return;
  locked = true;
  const screen = el('#lockScreen');
  screen.hidden = false;
  const form = el('#unlockForm');
  form.reset();
  const input = form.querySelector('input[name="password"]');
  input.focus();
  form.onsubmit = async (event) => {
    event.preventDefault();
    const error = el('#unlockError');
    error.hidden = true;
    try {
      await api.post('/api/auth/login', { username: state.session.username, password: input.value });
      locked = false;
      screen.hidden = true;
      form.reset();
      touchActivity();
    } catch (failure) {
      error.textContent = failure.message;
      error.hidden = false;
      input.select();
    }
  };
  el('#unlockSignOut').onclick = () => signOut();
}

function touchActivity() {
  window.clearTimeout(idleTimer);
  window.clearTimeout(idleWarnTimer);
  idleWarnTimer = window.setTimeout(() => {
    toast({ message: t('auth.sessionExpired'), tone: 'warn' });
  }, IDLE_LIMIT_MS - IDLE_WARN_MS);
  idleTimer = window.setTimeout(lockScreen, IDLE_LIMIT_MS);
}

function startIdleWatch() {
  for (const event of ['mousedown', 'keydown', 'wheel', 'touchstart']) {
    window.addEventListener(event, touchActivity, { passive: true });
  }
  touchActivity();
}

/* ------------------------------------------------------------ notifications */

export async function refreshNotificationBadge() {
  if (!isSignedIn()) return;
  try {
    const payload = await api.get('/api/notifications/count');
    const badge = el('#notificationBadge');
    const unread = Number(payload?.unread ?? 0);
    badge.textContent = String(unread);
    badge.hidden = unread === 0;
  } catch {
    /* offline or signed out — the badge simply stays as it was */
  }
}

async function openNotifications() {
  const drawer = el('#notificationsDrawer');
  drawer.hidden = false;
  const list = el('#notificationsList');
  mount(list, [h('p', { class: 'muted small' }, t('common.loading'))]);
  try {
    const payload = await api.get('/api/notifications', { limit: 40 });
    const rows = payload?.rows ?? [];
    if (!rows.length) {
      mount(list, [h('div', { class: 'empty-state' }, h('h3', {}, t('notifications.empty')))]);
      return;
    }
    mount(list, rows.map((row) => h('div', { class: `notification-row ${row.isRead ? '' : 'unread'}`.trim() }, [
      h('strong', {}, t(row.titleKey ?? 'notifications.title', row.titleParams ?? {})),
      row.bodyKey ? h('span', { class: 'small muted' }, t(row.bodyKey, row.bodyParams ?? {})) : null,
      h('span', { class: 'when' }, row.createdAt ?? ''),
      h('div', { class: 'row-actions' }, [
        row.isRead ? null : h('button', {
          type: 'button',
          class: 'link',
          onclick: async () => {
            await api.post(`/api/notifications/${row.id}/read`, {});
            openNotifications();
            refreshNotificationBadge();
          },
        }, t('common.ok')),
        h('button', {
          type: 'button',
          class: 'link',
          onclick: async () => {
            await api.post(`/api/notifications/${row.id}/dismiss`, {});
            openNotifications();
            refreshNotificationBadge();
          },
        }, t('common.remove')),
      ]),
    ])));
  } catch (error) {
    mount(list, [h('div', { class: 'alert' }, error.message)]);
  }
}

/* ------------------------------------------------------------- search palette */

function openSearchPalette() {
  const input = h('input', { type: 'search', placeholder: t('nav.search'), autocomplete: 'off' });
  const results = h('div', { class: 'search-panel' });
  const modal = openModal({
    title: t('nav.searchShort'),
    body: h('div', { class: 'stack' }, [input, results]),
  });

  const run = debounce(async () => {
    const term = input.value.trim();
    if (term.length < 2) {
      mount(results, [h('p', { class: 'muted small' }, t('common.searchHint'))]);
      return;
    }
    try {
      const payload = await api.get('/api/search', { q: term, limit: 8 });
      const hits = (payload?.groups ?? []).flatMap((group) =>
        (group.items ?? []).map((item) => ({ ...item, entity: item.entity ?? group.entity })),
      );
      if (!hits.length) {
        mount(results, [h('p', { class: 'muted small' }, t('common.noResults'))]);
        return;
      }
      mount(results, hits.map((hit) => h('div', {
        class: 'search-hit',
        onclick: () => {
          modal.close();
          openSearchHit(hit);
        },
      }, [
        h('div', {}, [h('div', { class: 'strong' }, hit.title), h('div', { class: 'small muted' }, hit.subtitle ?? '')]),
        h('span', { class: 'kind' }, t(`search.entity.${hit.entity}`) === `search.entity.${hit.entity}` ? hit.entity : t(`search.entity.${hit.entity}`)),
      ])));
    } catch (error) {
      mount(results, [h('div', { class: 'alert' }, error.message)]);
    }
  }, 220);

  input.addEventListener('input', run);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      const first = results.querySelector('.search-hit');
      if (first) first.click();
    }
  });
  run();
}

export function openSearchHit(hit) {
  switch (hit.entity) {
    case 'patient':
      navigate(`/patients/${hit.entityId}`);
      break;
    case 'invoice':
      navigate(`/billing/${hit.entityId}`);
      break;
    case 'payment':
      navigate(`/payments/${hit.entityId}`);
      break;
    case 'prescription':
      navigate(`/prescriptions/${hit.entityId}`);
      break;
    case 'plan':
      navigate(`/plans/${hit.entityId}`);
      break;
    case 'appointment':
      navigate(`/appointments/${hit.entityId}`);
      break;
    case 'visit':
      navigate(`/visits/${hit.entityId}`);
      break;
    case 'referral':
      navigate(`/referrals/${hit.entityId}`);
      break;
    case 'treatment':
      navigate(`/treatments/${hit.entityId}`);
      break;
    default:
      navigate('/patients');
  }
}

/* ------------------------------------------------------------------ hotkeys */

function bindHotkeys() {
  document.addEventListener('keydown', (event) => {
    const withModifier = event.ctrlKey || event.metaKey;
    if (withModifier && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      openSearchPalette();
      return;
    }
    if (withModifier && event.key.toLowerCase() === 'n') {
      event.preventDefault();
      navigate('/patients?new=1');
      return;
    }
    if (event.key === 'Escape') {
      el('#notificationsDrawer').hidden = true;
      el('#accountMenu').hidden = true;
    }
    if (event.key === '/' && !/** @type {any} */ (event.target).closest('input, textarea, select, [contenteditable]')) {
      event.preventDefault();
      openSearchPalette();
    }
  });
}

/* --------------------------------------------------------------------- wire */

function bindChrome() {
  el('#menuButton').onclick = () => document.body.classList.toggle('nav-open');
  el('#sidebarToggle').onclick = () => {
    document.body.classList.toggle('sidebar-collapsed');
    localStorage.setItem('dentiva.sidebarCollapsed', document.body.classList.contains('sidebar-collapsed') ? '1' : '0');
  };
  el('#globalSearchButton').onclick = openSearchPalette;
  el('#notificationsButton').onclick = openNotifications;
  el('#closeNotifications').onclick = () => {
    el('#notificationsDrawer').hidden = true;
  };
  el('#markAllRead').onclick = async () => {
    await api.post('/api/notifications/read-all', {});
    refreshNotificationBadge();
    openNotifications();
  };
  el('#languageButton').onclick = async () => {
    const next = state.locale === 'en' ? 'bn' : 'en';
    setLocale(next);
    try {
      await api.put('/api/preferences/profile', { locale: next });
    } catch {
      /* the choice still applies for this window */
    }
    renderChrome();
    refresh();
    toast({ message: LOCALE_LABELS[next], tone: 'ok' });
  };
  el('#accountButton').onclick = toggleAccountMenu;
  el('#accountMenu').addEventListener('click', (event) => {
    const action = event.target.closest('button')?.dataset.action;
    el('#accountMenu').hidden = true;
    if (!action) return;
    if (action === 'logout') return signOut();
    if (action === 'lock') return lockScreen();
    if (action === 'about') return navigate('/about');
    if (action === 'profile') return navigate('/settings?tab=profile');
    if (action === 'password') return navigate('/settings?tab=security');
    if (action === 'pin') return navigate('/settings?tab=security');
    if (action === 'sessions') return navigate('/settings?tab=sessions');
  });
}

if (localStorage.getItem('dentiva.sidebarCollapsed') === '1') document.body.classList.add('sidebar-collapsed');
bindChrome();
bindHotkeys();

boot().catch((error) => {
  el('#boot').hidden = true;
  el('#app').hidden = false;
  renderError(error);
});

window.addEventListener('error', (event) => console.error('[dentiva] window error', event.error ?? event.message));
export { t, emit };
