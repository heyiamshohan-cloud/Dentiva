/**
 * Sign in and first-run setup.
 *
 * The first-run wizard collects the clinic identity, the lead dentist and the
 * owner account — no demo data is ever pre-filled, and the creator details are
 * deliberately absent (they belong to About/Credits only).
 */
import { api } from '../core/api.js';
import { h, mount, toast } from '../core/dom.js';
import { LOCALE_LABELS } from '/shared/i18n/index.js';
import { today } from '../core/format.js';

/** @param {{ t: any, onSignedIn: () => void }} options */
export function renderLogin({ t, onSignedIn }) {
  const error = h('p', { class: 'form-error', hidden: true });
  const username = h('input', { name: 'username', autocomplete: 'username', required: true, autofocus: true });
  const password = h('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true });
  const show = h('input', { type: 'checkbox', onchange: (event) => { password.type = event.target.checked ? 'text' : 'password'; } });

  const form = h('form', { class: 'stack', onsubmit: submit }, [
    h('label', {}, [h('span', {}, t('auth.username')), username]),
    h('label', {}, [h('span', {}, t('auth.password')), password]),
    h('label', { class: 'checkbox' }, [show, h('span', {}, t('auth.showPassword'))]),
    error,
    h('button', { type: 'submit', class: 'primary' }, t('auth.signIn')),
  ]);

  async function submit(event) {
    event.preventDefault();
    error.hidden = true;
    const button = form.querySelector('button[type=submit]');
    button.disabled = true;
    try {
      const result = await api.post('/api/auth/login', { username: username.value.trim(), password: password.value });
      if (result?.mustChangePassword) {
        toast({ message: t('auth.changePasswordForced'), tone: 'warn' });
      }
      onSignedIn();
    } catch (failure) {
      error.textContent = failure.message;
      error.hidden = false;
      password.select();
    } finally {
      button.disabled = false;
    }
  }

  return h('div', { class: 'lock-screen' }, h('div', { class: 'lock-card' }, [
    h('div', { class: 'brand-mark large' }, 'D'),
    h('h2', {}, t('auth.signInTitle')),
    h('p', { class: 'muted small' }, t('auth.signInSubtitle')),
    form,
    h('p', { class: 'help' }, t('app.offline')),
  ]));
}

const STEPS = ['clinic', 'dentist', 'owner', 'confirm'];

/** @param {{ t: any, onDone: () => void, dataDir?: string }} options */
export function renderFirstRun({ t, onDone, dataDir = '' }) {
  const data = {
    clinic: { code: 'MAIN', name: '', legal_name: '', phone: '', email: '', address: '', city: '', country: 'Bangladesh', currency_code: 'BDT', currency_symbol: '৳', locale: 'en' },
    dentist: { full_name: '', designation: '', registration_no: '', phone: '', email: '', specialty: '' },
    admin: { username: '', display_name: '', password: '', confirm: '' },
  };
  let step = 0;
  const error = h('div', { class: 'alert hidden' });
  const host = h('div', { class: 'wizard' });

  const stepsBar = () => h('div', { class: 'wizard-steps' }, STEPS.map((key, index) => h('span', {
    class: `wizard-step ${index === step ? 'active' : ''} ${index < step ? 'done' : ''}`.trim(),
  }, [
    h('span', {}, index < step ? '✓' : String(index + 1)),
    h('span', {}, t(`firstRun.${key}Step`)),
  ])));

  function render() {
    mount(host, [stepsBar(), body(), error, footer()]);
  }

  function body() {
    switch (STEPS[step]) {
      case 'clinic':
        return h('div', { class: 'grid-2' }, [
          field('text', t('firstRun.clinicCode'), data.clinic.code, (value) => { data.clinic.code = value; }, { hint: t('firstRun.clinicHint') }),
          field('text', t('firstRun.clinicName'), data.clinic.name, (value) => { data.clinic.name = value; }, { required: true }),
          field('text', t('common.phone'), data.clinic.phone, (value) => { data.clinic.phone = value; }, { type: 'tel' }),
          field('text', t('common.email'), data.clinic.email, (value) => { data.clinic.email = value; }, { type: 'email' }),
          field('text', t('common.address'), data.clinic.address, (value) => { data.clinic.address = value; }),
          field('text', t('common.city'), data.clinic.city, (value) => { data.clinic.city = value; }),
          h('label', {}, [h('span', {}, t('firstRun.language')), h('select', {
            onchange: (event) => { data.clinic.locale = event.target.value; },
          }, Object.entries(LOCALE_LABELS).map(([value, label]) => h('option', { value, selected: data.clinic.locale === value ? true : undefined }, label)))]),
          h('label', {}, [h('span', {}, t('firstRun.currency')), h('select', {
            onchange: (event) => {
              const [code, symbol] = event.target.value.split('|');
              data.clinic.currency_code = code;
              data.clinic.currency_symbol = symbol;
            },
          }, [
            ['BDT|৳', 'BDT — ৳'],
            ['USD|$', 'USD — $'],
            ['EUR|€', 'EUR — €'],
            ['GBP|£', 'GBP — £'],
            ['INR|₹', 'INR — ₹'],
            ['PKR|₨', 'PKR — ₨'],
            ['MYR|RM', 'MYR — RM'],
            ['SAR|﷼', 'SAR — ﷼'],
            ['AED|د.إ', 'AED — د.إ'],
          ].map(([value, label]) => h('option', { value, selected: data.clinic.currency_code === value.split('|')[0] ? true : undefined }, label)))]),
        ]);
      case 'dentist':
        return h('div', { class: 'grid-2' }, [
          field('text', t('patients.fullName'), data.dentist.full_name, (value) => { data.dentist.full_name = value; }, { required: true, hint: t('firstRun.dentistHint') }),
          field('text', t('staff.designation'), data.dentist.designation, (value) => { data.dentist.designation = value; }),
          field('text', t('staff.registrationNo'), data.dentist.registration_no, (value) => { data.dentist.registration_no = value; }),
          field('text', t('staff.specialty'), data.dentist.specialty, (value) => { data.dentist.specialty = value; }),
          field('text', t('common.phone'), data.dentist.phone, (value) => { data.dentist.phone = value; }, { type: 'tel' }),
          field('text', t('common.email'), data.dentist.email, (value) => { data.dentist.email = value; }, { type: 'email' }),
        ]);
      case 'owner':
        return h('div', { class: 'grid-2' }, [
          field('text', t('users.username'), data.admin.username, (value) => { data.admin.username = value; }, { required: true, hint: t('firstRun.ownerHint') }),
          field('text', t('users.displayName'), data.admin.display_name, (value) => { data.admin.display_name = value; }),
          field('password', t('auth.password'), data.admin.password, (value) => { data.admin.password = value; }, { required: true, hint: t('auth.passwordHint') }),
          field('password', t('auth.confirmPassword'), data.admin.confirm, (value) => { data.admin.confirm = value; }, { required: true }),
          h('p', { class: 'help span-all' }, t('firstRun.useSuggested')),
        ]);
      default:
        return h('div', { class: 'stack' }, [
          h('p', { class: 'muted' }, t('firstRun.confirmStep')),
          h('p', { class: 'help' }, t('firstRun.dataLocation', { path: dataDir || '—' })),
          h('dl', { class: 'kv' }, [
            h('dt', {}, t('firstRun.clinicStep')), h('dd', {}, data.clinic.name || '—'),
            h('dt', {}, t('firstRun.dentistStep')), h('dd', {}, data.dentist.full_name || '—'),
            h('dt', {}, t('firstRun.ownerStep')), h('dd', {}, data.admin.username || '—'),
            h('dt', {}, t('backup.dataLocation')), h('dd', { class: 'mono small' }, dataDir || '—'),
          ]),
        ]);
    }
  }

  function field(type, label, value, onChange, options = {}) {
    return h('label', { class: options.span === 'all' ? 'span-all' : '' }, [
      h('span', {}, [label, options.required ? h('span', { class: 'muted' }, ' *') : null]),
      h('input', {
        type,
        value: value ?? '',
        required: options.required,
        placeholder: options.placeholder,
        autocomplete: 'off',
        oninput: (event) => onChange(event.target.value),
        onchange: (event) => onChange(event.target.value),
      }),
      options.hint ? h('p', { class: 'field-hint' }, options.hint) : null,
    ]);
  }

  function footer() {
    return h('div', { class: 'row-actions end' }, [
      step > 0 ? h('button', { type: 'button', class: 'ghost', onclick: () => { step -= 1; render(); } }, t('common.back')) : null,
      step < STEPS.length - 1
        ? h('button', { type: 'button', class: 'primary', onclick: next }, t('common.next'))
        : h('button', { type: 'button', class: 'primary', onclick: finish }, t('firstRun.create')),
    ]);
  }

  function next() {
    error.classList.add('hidden');
    if (STEPS[step] === 'clinic' && !data.clinic.name.trim()) {
      return fail(t('validation.required'));
    }
    if (STEPS[step] === 'dentist' && !data.dentist.full_name.trim()) {
      return fail(t('validation.required'));
    }
    if (STEPS[step] === 'owner') {
      if (!data.admin.username.trim() || !data.admin.password) return fail(t('validation.required'));
      if (data.admin.password !== data.admin.confirm) return fail(t('auth.passwordMismatch'));
    }
    step += 1;
    render();
  }

  function fail(message) {
    error.textContent = message;
    error.classList.remove('hidden');
  }

  async function finish() {
    error.classList.add('hidden');
    try {
      await api.post('/api/auth/first-run', {
        clinic: data.clinic,
        dentist: data.dentist,
        admin: { username: data.admin.username.trim(), display_name: data.admin.display_name || data.admin.username, password: data.admin.password },
      });
      toast({ message: t('firstRun.done'), tone: 'ok' });
      onDone();
    } catch (failure) {
      fail(failure.message);
    }
  }

  render();
  return h('div', { class: 'content', style: { maxWidth: '880px', margin: '0 auto' } }, [
    h('div', { class: 'card' }, h('div', { class: 'card-body' }, [
      h('h2', {}, t('firstRun.title')),
      h('p', { class: 'muted' }, t('firstRun.subtitle')),
      h('div', { class: 'divider' }),
      host,
      h('p', { class: 'help' }, `${t('app.offline')} · ${today()}`),
    ])),
  ]);
}
