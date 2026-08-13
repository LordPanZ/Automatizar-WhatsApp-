/* Instalación como app y aviso de "añadir a la pantalla de inicio". */
(() => {
  const DISMISS_KEY = 'wa-drafts-install-dismissed';

  const ua = navigator.userAgent;
  // iPadOS 13+ se hace pasar por Mac; se delata por tener varios puntos táctiles.
  const isIos =
    /iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
  const isSafari = /safari/i.test(ua) && !/crios|fxios|edgios|opios|opera|chrome/i.test(ua);

  const standalone =
    window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

  // El service worker solo se registra en contextos seguros (https o localhost).
  // Por http en la red local no se registra: la app funciona igual, solo sin caché.
  if ('serviceWorker' in navigator && window.isSecureContext) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        /* sin service worker se sigue funcionando */
      });
    });
  }

  if (standalone || localStorage.getItem(DISMISS_KEY)) return;

  let deferredPrompt = null;

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event;
    const existing = document.getElementById('install-banner');
    if (existing) existing.remove(); // repintar con el botón de instalar ya disponible
    render();
  });

  /**
   * Cada plataforma ofrece cosas distintas, así que el aviso dice la verdad
   * sobre lo que se puede hacer aquí y ahora en vez de prometer un botón
   * que este navegador no va a enseñar.
   */
  function message() {
    if (deferredPrompt) {
      return {
        title: 'Instálalo como app',
        body: 'Se abrirá a pantalla completa, con su propio icono.',
        canInstall: true,
      };
    }
    if (isIos && !isSafari) {
      return {
        title: 'Ábrelo en Safari',
        body:
          'Desde este navegador iOS no deja añadirlo a la pantalla de inicio. Copia la dirección, ' +
          'ábrela en Safari y allí usa Compartir › Añadir a pantalla de inicio.',
        canInstall: false,
      };
    }
    if (isIos) {
      return {
        title: 'Añádelo a la pantalla de inicio',
        body: 'Pulsa Compartir (el cuadrado con la flecha) y luego Añadir a pantalla de inicio.',
        canInstall: false,
      };
    }
    if (!window.isSecureContext) {
      return {
        title: 'Añádelo a la pantalla de inicio',
        body:
          'Menú ⋮ › Añadir a pantalla de inicio. Como estás por http, el acceso directo se abrirá ' +
          'dentro del navegador. Para pantalla completa hace falta https (mira el README: tailscale serve).',
        canInstall: false,
      };
    }
    return {
      title: 'Añádelo a la pantalla de inicio',
      body: 'Menú ⋮ › Añadir a pantalla de inicio, o Instalar app si te aparece.',
      canInstall: false,
    };
  }

  function render() {
    if (document.getElementById('install-banner')) return;
    if (localStorage.getItem(DISMISS_KEY)) return;

    const info = message();
    const banner = document.createElement('div');
    banner.id = 'install-banner';
    banner.className = 'install-banner';
    banner.innerHTML = `
      <div class="install-text">
        <strong></strong>
        <span class="hint"></span>
      </div>
      <div class="install-actions">
        ${info.canInstall ? '<button class="btn primary small" data-install>Instalar</button>' : ''}
        <button class="btn small" data-dismiss>Entendido</button>
      </div>
    `;
    banner.querySelector('strong').textContent = info.title;
    banner.querySelector('.hint').textContent = info.body;

    banner.querySelector('[data-dismiss]').addEventListener('click', () => {
      localStorage.setItem(DISMISS_KEY, '1');
      banner.remove();
    });

    const installButton = banner.querySelector('[data-install]');
    if (installButton) {
      installButton.addEventListener('click', async () => {
        banner.remove();
        deferredPrompt.prompt();
        await deferredPrompt.userChoice;
        deferredPrompt = null;
      });
    }

    document.body.appendChild(banner);
  }

  // No taparle la pantalla de acceso: el aviso espera a que el panel esté dentro.
  let attempts = 0;
  const waitForPanel = setInterval(() => {
    attempts += 1;
    const app = document.getElementById('app');
    if (app && !app.hidden) {
      clearInterval(waitForPanel);
      render();
    } else if (attempts > 60) {
      clearInterval(waitForPanel);
    }
  }, 1000);
})();
