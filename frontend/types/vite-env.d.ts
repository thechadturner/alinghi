/// <reference types="vite/client" />

interface ImportMetaEnv {
  // API Configuration
  readonly VITE_API_HOST: string;
  readonly VITE_APP_PORT: string;
  readonly VITE_ADMIN_PORT: string;
  readonly VITE_FILE_PORT: string;
  readonly VITE_MEDIA_PORT: string;
  readonly VITE_PYTHON_PORT: string;
  
  // Mapbox Configuration
  readonly VITE_MAPBOX_TOKEN: string;
  readonly VITE_MAPBOX_STYLE: string;
  
  // Development Configuration
  readonly VITE_DEV_TOOLS: string;
  readonly VITE_DEBUG_MODE: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
