module.exports = {
      content: { relative: true, files: ["../public/insights-workspace/*.{html,js}"] },
      theme: {
        extend: {
          fontFamily: {
            sans: ['Inter', 'Noto Sans SC', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
            mono: ['JetBrains Mono', 'Courier New', 'monospace'],
          },
          colors: {
            studio: '#ECEEF2',
            paper: '#FFFFFF',
            paperWell: '#F8F9FB',
            paperWarm: '#FDFCFA',
            ink: '#141413',
            inkBody: '#2C2C2A',
            inkSecondary: '#575754',
            inkMuted: '#8A8A86',
            hair: 'rgba(20, 20, 19, 0.07)',
            hairStrong: 'rgba(20, 20, 19, 0.12)',
            accent: '#2563EB',
            ok: '#0F766E',
            warn: '#B45309',
            err: '#B91C1C',
          }
        }
      }
    };
