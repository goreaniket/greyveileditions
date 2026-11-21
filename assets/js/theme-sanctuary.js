(() => {
  const STORAGE_KEY = 'greyveil-theme';
  const NIGHT = 'night';
  const LIGHT = 'light';

  const ensureFonts = () => {
    if (!document.querySelector('link[data-greyveil-sanctuary-fonts]')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.dataset.greyveilSanctuaryFonts = 'true';
      link.href = 'https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,400;0,500;0,600;0,700;1,400;1,500&family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap';
      document.head.append(link);
    }
  };

  const ensureStyles = () => {
    if (!document.querySelector('link[data-greyveil-warm-editorial]')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.dataset.greyveilWarmEditorial = 'true';
      link.href = '/assets/css/warm-editorial.css?v=20261121';
      document.head.append(link);
    }
  };

  const applyTheme = (theme, persist = true) => {
    const next = theme === NIGHT ? NIGHT : LIGHT;
    document.documentElement.dataset.theme = next;
    document.documentElement.style.colorScheme = next === NIGHT ? 'dark' : 'light';
    if (next === NIGHT) document.documentElement.dataset.readerTheme = 'dark';
    else if (document.documentElement.dataset.readerTheme === 'dark') document.documentElement.dataset.readerTheme = 'light';
    if (persist) localStorage.setItem(STORAGE_KEY, next);
    document.querySelectorAll('[data-sanctuary-theme]').forEach((button) => {
      const night = next === NIGHT;
      button.setAttribute('aria-pressed', String(night));
      button.setAttribute('aria-label', night ? 'Switch to Light theme' : 'Switch to Night Sanctuary');
      button.textContent = night ? '☀' : '☾';
      button.title = night ? 'Light theme' : 'Night Sanctuary';
    });
  };

  ensureFonts();
  ensureStyles();
  const saved = localStorage.getItem(STORAGE_KEY);
  const preferred = window.matchMedia?.('(prefers-color-scheme: dark)').matches ? NIGHT : LIGHT;
  applyTheme(saved || preferred, false);

  const mountToggle = () => {
    document.querySelectorAll('.gv-global-header, .site-header').forEach((header) => {
      const nav = header.querySelector('.gv-global-nav, .primary-nav');
      if (!nav || header.querySelector(':scope > [data-sanctuary-theme]')) return;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'gv-sanctuary-toggle';
      button.dataset.sanctuaryTheme = '';
      button.addEventListener('click', () => {
        applyTheme(document.documentElement.dataset.theme === NIGHT ? LIGHT : NIGHT);
      });
      const menuToggle = header.querySelector('.gv-global-toggle');
      header.insertBefore(button, menuToggle?.nextSibling || nav);
    });

    if (!document.querySelector('[data-sanctuary-theme]:not(.gv-sanctuary-toggle)')) {
      const existingShell = document.querySelector('.admin-topbar, .topbar, .reader-toolbar');
      if (existingShell && !existingShell.querySelector('[data-sanctuary-theme]')) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'gv-sanctuary-toggle';
        button.dataset.sanctuaryTheme = '';
        button.addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === NIGHT ? LIGHT : NIGHT));
        existingShell.append(button);
      }
    }
  };

  mountToggle();
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY) applyTheme(event.newValue, false);
  });

  window.GreyveilSanctuary = Object.freeze({
    applyTheme,
    getTheme: () => document.documentElement.dataset.theme || LIGHT,
  });
})();
