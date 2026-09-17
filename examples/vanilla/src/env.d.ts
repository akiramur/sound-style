/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MAPBOX_ACCESS_TOKEN?: string;
  /**
   * Points SoundStyleEngine at a CDN base URL (e.g. jsDelivr serving
   * github.com/akiramur/sound-style-assets). This app has no local public/audio-basic/ fallback —
   * always set this (see .env.local.example).
   */
  readonly VITE_AUDIO_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
