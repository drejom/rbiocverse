/**
 * ThemeToggle - Cycles through system → light → dark themes
 */

import { Sun, Moon, Monitor } from 'lucide-react';
import { useTheme } from '../contexts/ThemeContext';

const labels = {
  auto: 'System',
  light: 'Light',
  dark: 'Dark',
};

function ThemeToggle() {
  const { preference, toggleTheme } = useTheme();

  const icon = preference === 'auto' ? <Monitor size={18} /> :
               preference === 'light' ? <Sun size={18} /> :
               <Moon size={18} />;

  return (
    <button
      className="theme-toggle"
      onClick={toggleTheme}
      title={`Theme: ${labels[preference]} (click to change)`}
      aria-label={`Change theme (currently ${labels[preference]})`}
    >
      {icon}
    </button>
  );
}

export default ThemeToggle;
