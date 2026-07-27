import { useEffect, useState } from 'react';

type Theme = 'light' | 'dark';

function currentTheme(): Theme {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(currentTheme);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    try {
      localStorage.setItem('saga.theme', theme);
    } catch {
      // A browser with storage disabled still gets the toggle for this session.
    }
  }, [theme]);

  return (
    <button
      type="button"
      className="btn-secondary"
      aria-pressed={theme === 'dark'}
      onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
    >
      <span aria-hidden="true">{theme === 'dark' ? '☾' : '☀'}</span>
      <span className="sr-only">
        Switch to {theme === 'dark' ? 'light' : 'dark'} theme (currently {theme})
      </span>
    </button>
  );
}
