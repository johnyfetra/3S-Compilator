// Thème clair / sombre partagé par le compilateur et l'espace admin.
import { prefs } from './store.js';

const media = matchMedia('(prefers-color-scheme: dark)');

export function currentTheme() {
  const chosen = prefs.load().theme;
  return chosen || (media.matches ? 'dark' : 'light');
}

function apply(button) {
  const chosen = prefs.load().theme;
  if (chosen) document.documentElement.dataset.theme = chosen;
  else delete document.documentElement.dataset.theme;
  button.setAttribute('aria-label', currentTheme() === 'dark' ? 'Passer au thème clair' : 'Passer au thème sombre');
}

// Branche le bouton de thème ; onChange(theme) permet d'adapter l'éditeur.
export function initTheme(button, onChange = () => {}) {
  apply(button);
  button.addEventListener('click', () => {
    const p = prefs.load();
    p.theme = currentTheme() === 'dark' ? 'light' : 'dark';
    prefs.save(p);
    apply(button);
    onChange(currentTheme());
  });
  media.addEventListener('change', () => { apply(button); onChange(currentTheme()); });
}

export const editorTheme = () => (currentTheme() === 'dark' ? 'threes-dark' : 'threes-light');
