/**
 * Builds the ghost element shown over whichever POI most recently played a sound (see main.ts's
 * ghost lifecycle, driven by engine 'layer:play'/'layer:stop' events). Uses AI-generated (Gemini)
 * ghost artwork (see public/ghost-images/NOTICE.md) rather than hand-drawn shapes — resized to
 * marker scale and made translucent. The source renders were already light/glowing wisps on a
 * solid black background; that background was converted to real alpha transparency
 * (luminance-as-alpha) ahead of time. Every category stays a plain white/monochrome glow (no
 * per-category hue tint, no small prop icon over the head) — categories are distinguished only by
 * which of the 4 source images is used (witch-shop and the crying-woman categories additionally
 * pick a random left/right mirror of the image per spawn — see `randomFlip` on GHOST_IMAGE).
 * All animation (entering/active/leaving, plus the idle sway) is done via CSS classes toggled by
 * main.ts; see the `.ghost*` rules in index.html.
 */
export const GHOST_CATEGORIES = ['cemetery', 'haunted-mansion', 'witch-shop', 'church', 'monument', 'info-booth'] as const;
export type HalloweenCategory = (typeof GHOST_CATEGORIES)[number];

export function isHalloweenCategory(value: string): value is HalloweenCategory {
  return (GHOST_CATEGORIES as readonly string[]).includes(value);
}

interface GhostImageConfig {
  /** Path under public/ghost-images/. */
  src: string;
  /** Natural width/height, used to size the marker while preserving aspect ratio. */
  ratio: number;
  /** Marker height in px (defaults to 110 — see DEFAULT_HEIGHT). */
  height?: number;
  /**
   * mapboxgl.Marker anchor point (defaults to 'center', the SDK/Mapbox default). gemini-ghost-girl
   * is drawn as a standing figure with her feet at the very bottom of the image, unlike the other
   * 3 images (all floating/flying apparitions with no "ground contact" point) — anchoring her at
   * 'center' put her feet a half-height above the POI, reading as "floating up" even though
   * nothing was animating. 'bottom' plants her feet on the point instead.
   */
  anchor?: 'center' | 'bottom';
  /** Mirror the image horizontally at random (50/50) per spawn, for visual variety. */
  randomFlip?: boolean;
}

const DEFAULT_HEIGHT = 110;

/** A single shared white/monochrome glow filter — no per-category hue tint. */
const GHOST_FILTER = 'drop-shadow(0 0 16px rgba(255,255,255,0.55)) saturate(0.4) brightness(1.1)';

const GHOST_IMAGE: Record<HalloweenCategory, GhostImageConfig> = {
  cemetery: {
    // Screaming skull wreathed in wispy hair — a floating apparition, not a standing figure, so
    // (unlike the old gemini-ghost-girl here) no 'bottom' anchor.
    src: 'ghost-images/gemini-skull-scream.png',
    ratio: 1032 / 760,
    height: 55,
  },
  'haunted-mansion': {
    // Screaming clawed apparition — grand and dramatic.
    src: 'ghost-images/gemini-scream-face.png',
    ratio: 406 / 753,
  },
  'witch-shop': {
    // Long horizontal streaming wisp — reads as a witch in flight.
    src: 'ghost-images/gemini-wisp-scream.png',
    ratio: 1325 / 745,
    height: 85,
    randomFlip: true,
  },
  church: {
    // Sorrowful long-haired figure.
    src: 'ghost-images/gemini-crying-woman.png',
    ratio: 433 / 717,
    height: 90,
    randomFlip: true,
  },
  monument: {
    // Standing ghost-girl, reused.
    src: 'ghost-images/gemini-ghost-girl.png',
    ratio: 324 / 632,
    height: 68,
    anchor: 'bottom',
  },
  'info-booth': {
    // Crying-woman wisp, reused.
    src: 'ghost-images/gemini-crying-woman.png',
    ratio: 433 / 717,
    height: 90,
    randomFlip: true,
  },
};

/**
 * Returns { root, ghost, syncElements, anchor }: `root` is a plain, class-free div meant only to
 * be handed to `new mapboxgl.Marker({ element: root, anchor })` — Marker writes its own inline
 * positioning `transform` directly onto whatever element it's given, which would silently clobber
 * any CSS `transform` rule placed on that same element. `ghost` is the actual
 * `.ghost ghost--<category>` div nested one level inside `root`, untouched by Marker, so all our
 * enter/active/leave CSS transitions (opacity/transform/filter, toggled by main.ts's ghost
 * lifecycle) apply correctly. `syncElements` is every element whose classes must mirror `ghost`'s
 * — currently always just `[ghost]` (a meteor-tail effect was tried here and removed; it never
 * lined up cleanly with the image, not worth the extra moving part). `anchor` is per-category
 * (see GHOST_IMAGE) — must be passed to the Marker constructor itself, not set via CSS, since
 * Marker uses it to compute its own positioning offset.
 */
export function createGhostElement(category: HalloweenCategory): {
  root: HTMLDivElement;
  ghost: HTMLDivElement;
  syncElements: HTMLDivElement[];
  anchor: 'center' | 'bottom';
} {
  const config = GHOST_IMAGE[category];
  const height = config.height ?? DEFAULT_HEIGHT;
  const width = Math.round(height * config.ratio);

  // gemini-wisp-scream.png (witch-shop) is drawn facing/screaming toward the upper-right, with
  // the wisp trailing off to the lower-left. Rather than a second exported image file, a mirrored
  // "facing upper-left" variant is just `scaleX(-1)` on the same asset — picked at random per
  // spawn so both orientations show up (see `randomFlip` on GHOST_IMAGE; also on for
  // church/info-booth's crying-woman, just for visual variety, no direction-dependent behavior).
  // The `ghost-flip` class lets index.html give witch-shop's flipped spawn its own fast, large
  // exit animation in the direction it's facing (see `.ghost--witch-shop.ghost-leaving` /
  // `.ghost--witch-shop.ghost-flip.ghost-leaving`) — inert for every other category.
  const flipped = Boolean(config.randomFlip) && Math.random() < 0.5;
  const flipClass = flipped ? ' ghost-flip' : '';
  const imageTransform = flipped ? ' transform:scaleX(-1);' : '';

  const root = document.createElement('div');
  const ghost = document.createElement('div');
  ghost.className = `ghost ghost--${category}${flipClass}`;
  ghost.innerHTML = `
    <div class="ghost-bob">
      <div class="ghost-image-wrap" style="width:${width}px;height:${height}px">
        <img class="ghost-image" src="${import.meta.env.BASE_URL}${config.src}" alt="" width="${width}" height="${height}" style="filter:${GHOST_FILTER};${imageTransform}" />
      </div>
    </div>
  `;
  root.appendChild(ghost);

  return { root, ghost, syncElements: [ghost], anchor: config.anchor ?? 'center' };
}
