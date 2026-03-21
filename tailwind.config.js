module.exports = {
  content: [
    "./index.html",          // HTML entry file
    "./frontend/**/*.{js,ts,jsx,tsx}", // All JS/TS/JSX/TSX files in the frontend folder
  ],
  darkMode: 'class', // Enable class-based dark mode
  theme: {
    extend: {
      colors: {
        // Theme-aware colors that will be overridden by CSS custom properties
        'bg-primary': 'var(--color-bg-primary)',
        'bg-secondary': 'var(--color-bg-secondary)',
        'bg-tertiary': 'var(--color-bg-tertiary)',
        'bg-card': 'var(--color-bg-card)',
        'bg-sidebar': 'var(--color-bg-sidebar)',
        'bg-header': 'var(--color-bg-header)',
        'bg-input': 'var(--color-bg-input)',
        'bg-button': 'var(--color-bg-button)',
        'bg-button-hover': 'var(--color-bg-button-hover)',
        'bg-button-secondary': 'var(--color-bg-button-secondary)',
        'bg-button-secondary-hover': 'var(--color-bg-button-secondary-hover)',
        'bg-modal': 'var(--color-bg-modal)',
        'bg-overlay': 'var(--color-bg-overlay)',
        
        'text-primary': 'var(--color-text-primary)',
        'text-secondary': 'var(--color-text-secondary)',
        'text-tertiary': 'var(--color-text-tertiary)',
        'text-inverse': 'var(--color-text-inverse)',
        'text-link': 'var(--color-text-link)',
        'text-link-hover': 'var(--color-text-link-hover)',
        'text-error': 'var(--color-text-error)',
        'text-success': 'var(--color-text-success)',
        'text-warning': 'var(--color-text-warning)',
        
        'border-primary': 'var(--color-border-primary)',
        'border-secondary': 'var(--color-border-secondary)',
        'border-focus': 'var(--color-border-focus)',
        'border-error': 'var(--color-border-error)',
        'border-success': 'var(--color-border-success)',
        
        'shadow-sm': 'var(--color-shadow-sm)',
        'shadow-md': 'var(--color-shadow-md)',
        'shadow-lg': 'var(--color-shadow-lg)',
        
        'chart-grid': 'var(--color-chart-grid)',
        'chart-axis': 'var(--color-chart-axis)',
        'chart-text': 'var(--color-chart-text)',
      }
    },
  },
  plugins: [],
};

