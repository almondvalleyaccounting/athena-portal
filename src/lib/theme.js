// Athena colour palette — single source of truth
// Scottish Coast base + three view accents
//
// Usage: import { theme, viewTheme } from '../lib/theme';
//        const t = viewTheme('management'); // or 'client' or 'staff'
//        <button className={t.btnPrimary}>Save</button>

export const theme = {
  // Scottish Coast primary
  primary: {
    900: '#0E2230',
    800: '#132E40',
    700: '#193A50',
    600: '#1E4560',  // ← main primary
    500: '#2A6580',
    400: '#3A7FA0',  // ← main accent
    300: '#7BB5CC',
    200: '#B8D5E3',
    100: '#DFECF2',
    50:  '#F5F8FA',
  },

  // Management — sunshine yellow
  management: {
    accent: '#F5C518',
    light:  '#FEF5CC',
    dark:   '#9E7F10',
  },

  // Client — blue-teal
  client: {
    accent: '#12AABC',
    light:  '#D0F3F8',
    dark:   '#0A6E7C',
  },

  // Staff — soft violet
  staff: {
    accent: '#7C6EBF',
    light:  '#E8E4F5',
    dark:   '#4C3D8F',
  },
};

// Tailwind class bundles per view — use these for buttons, badges, active states
export const viewTheme = (view = 'management') => {
  const map = {
    management: {
      btnPrimary: 'bg-sun-300 text-ocean-600 hover:bg-sun-200',
      btnSecondary: 'bg-white text-sun-500 border border-sun-300 hover:bg-sun-50',
      badgeActive: 'bg-sun-50 text-sun-600',
      badgeMuted: 'bg-sun-300/15 text-sun-500',
      accent: 'text-sun-300',
      accentBg: 'bg-sun-300',
      ring: 'ring-sun-300',
    },
    client: {
      btnPrimary: 'bg-surf-300 text-white hover:bg-surf-400',
      btnSecondary: 'bg-white text-surf-500 border border-surf-300 hover:bg-surf-50',
      badgeActive: 'bg-surf-50 text-surf-600',
      badgeMuted: 'bg-surf-300/15 text-surf-500',
      accent: 'text-surf-300',
      accentBg: 'bg-surf-300',
      ring: 'ring-surf-300',
    },
    staff: {
      btnPrimary: 'bg-violet-300 text-white hover:bg-violet-400',
      btnSecondary: 'bg-white text-violet-500 border border-violet-300 hover:bg-violet-50',
      badgeActive: 'bg-violet-50 text-violet-600',
      badgeMuted: 'bg-violet-300/15 text-violet-500',
      accent: 'text-violet-300',
      accentBg: 'bg-violet-300',
      ring: 'ring-violet-300',
    },
  };
  return map[view] || map.management;
};
