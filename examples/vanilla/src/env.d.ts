/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MAPBOX_ACCESS_TOKEN?: string;
  /**
   * Points SoundStyleEngine at a CDN base URL (e.g. jsDelivr serving
   * github.com/akiramur/sound-style-assets) instead of this app's own bundled /audio/ files.
   * Unset to load audio from this app's own public/audio/ (bring your own files there) instead.
   */
  readonly VITE_AUDIO_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
