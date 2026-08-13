/* Instalación como app y aviso de "añadir a la pantalla de inicio". */
(() => {
  const DISMISS_KEY = 'wa-drafts-install-dismissed';

  const standalone =
    window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

  // El service worker solo se registra en contextos seguros (https o localhost).
  // Por http en la red local simplemente no se registra: la app va igual.
  if ('serviceWorker' in navigator && window.isSecureContext) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        /* sin service worker se sigue funcionando */
      });
    });
  }

  if (standalone || localStorage.getItem(DISMISS_KEY)) return;

  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  let deferredPrompt = null;

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredPrompt = event;
    render();
  });

  function render() {
    if (document.getElementById('install-banner')) return;

    const banner = document.createElement('div');
    banner.id = 'install-banner';
    banner.className = 'install-banner';

    const instructions = isIos
      ? 'Pulsa <strong>Compartir</strong> y luego <strong>Añadir a pantalla de inicio</strong>.'
      : 'Instálalo para abrirlo como una app, sin barra del navegador.';

    banner.innerHTML = `
      <div class="install-text">
        <strong>Añádelo a la pantalla de inicio</strong>
        <span class="hint">${instructions}</span>
      </div>
      <div class="install-actions">
        ${deferredPrompt ? '<button class="btn primary small" data-install>Instalar</button>' : ''}
        <button class="btn small" data-dismiss>Ahora no</button>
      </div>
    `;

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

  // En iOS no existe beforeinstallprompt: el aviso se muestra sin más.
  if (isIos) window.addEventListener('load', render);
})();
