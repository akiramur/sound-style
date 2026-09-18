# Ghost image asset notice

All images in this directory are AI-generated (Google Gemini), not hand-drawn or third-party
stock art. The source renders were opaque JPEGs on a solid black background; each was converted
to a transparent PNG by treating per-pixel luminance as alpha (`alpha = max(R, G, B)`, a standard
technique for extracting a glow/light-on-black render into a transparent cutout — it preserves the
soft glow falloff at the wisps' edges instead of a hard-edged silhouette cutout), then autocropped
to the opaque bounding box. Resized and CSS-tinted per Halloween category at runtime (see
`../../src/ghosts.ts`) rather than re-exported as separate files per tint.

- `gemini-scream-face.png` — screaming face with clawed hands, tapering into a wispy trail
- `gemini-ghost-girl.png` — a small, sorrowful floating girl in a tattered dress
- `gemini-crying-woman.png` — sorrowful long-haired figure
- `gemini-wisp-scream.png` — a screaming face trailing into a long horizontal wisp
- `gemini-skull-scream.png` — a screaming skull wreathed in wispy, wind-blown hair
