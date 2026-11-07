# Hub Logo Direction C — Search Robot

Generation route: built-in `image_gen` tool (provider/model name is not exposed by the runtime).

Constraint delivery mode: `main-prompt constraints` (the tool exposes one prompt string and no dedicated negative-prompt parameter).

## C1

- File: `hub-logo-C1.png`
- Native dimensions: 1254 × 1254 (preserved; not resampled)
- Pixel/background mode: opaque RGB (`Format24bppRgb`), warm ivory background with no alpha
- Semantic colors: teal `#20A99A`, deep navy `#173B57`, warm ivory background `#F4F0E6`
- SHA-256: `50D7D16E01DB48F6791B66674704B847EB260DBE694D1BA1E4D90CBEBC3B5C06`
- Evaluation: compact logo silhouette, wide visor, both paired side chambers, two eyes and one mouth, no text or mechanical clutter. The mascot fills the intended scale and emerges from the lower-left.
- Deviations: the lower-left corner is occupied by the mascot; the opaque ivory background has slight visible tonal variation rather than being perfectly uniform; internal modeling is somewhat stronger than the requested 8–12%; the side chambers can read as ear/headphone forms more readily than document chambers.
- Recommendation: strongest of C1/C2 as a refinement base, but not a strict production recommendation until the background is flattened in a future image-generation refinement and the side chambers become more document-like.

### Complete final prompt

```text
Use case: logo-brand
Asset type: square desktop app icon candidate C1 for Hub, a local-first multi-library search and flashcard-memory application.
Create ONE complete full-bleed 1:1 square mascot LOGO, approximately 1536 × 1536. This is a compact symbol, NOT a character illustration.
MANDATORY OPAQUE BACKDROP: paint every background pixel fully opaque solid warm ivory (#F4F0E6), including all four corners. Do not return transparency or black. No variation anywhere in the backdrop.
SUBJECT ONLY: a simplified friendly ROBOT HEAD mark. Absolutely no torso, neck, shoulders, arms, hands, legs, accessories, or floating shapes. The compact head consists of a dominant heavy teal rounded continuous shell, one extremely wide rounded deep-navy visor, and exactly TWO thick deep-navy side chambers shaped as broad rounded document sheets—one on the left and one on the right, both fully visible and attached directly to the head. The two side chambers are the paired identifying feature; keep them equal, substantial, and unmistakable through silhouette alone, with no markings.
Face: exactly two simple teal oval eyes and one short thick teal curved mouth inside the navy visor.
Shape budget: 8 broad basic shapes total: head shell, visor, two side chambers, two eyes, mouth, and one broad lower teal mass. No other visible shape. Must read clearly at 32 × 32.
Colors: exactly three semantic colors in the complete artwork—teal (#20A99A) and deep navy (#173B57) as the only IP colors, plus warm ivory (#F4F0E6) background. No black, white, gray, cyan, or extra hue. Closely related 8–12% tonal modeling may remain only inside teal/navy masses.
Composition: upright robot head emerging from the lower-left corner, filling about 82% of the square. The bottom-left of the shell may crop at canvas edges; the full visor and BOTH side chambers must remain visible. Strong compact asymmetrical placement, but no tilt.
Style: ultra-clean Flat-first geometric logo; thick, soft, rounded, weighty contours; broad flat masses; only 8–12% barely visible internal tonal modeling; professional, reliable, intelligent, gentle; vector-friendly.
Constraints: no text, watermark, borders, frames, cards, rounded App-icon mask, external shadow, scenery, other subjects, search icons, magnifying glass, books, buttons, screws, labels, antennae, cables, seams, armor, screen UI, document lines, complex machinery, thin lines, narrow gaps, sharp corners, or pointed tips. No photorealism, clay, plastic, toy, dramatic bevel, glossy hotspot, deep occlusion, extrusion, or strong 3D. Background must remain perfectly flat opaque ivory with normal square corners.
```

## C2

- File: `hub-logo-C2.png`
- Native dimensions: 1254 × 1254 (preserved; not resampled)
- Pixel/background mode: opaque RGB (`Format24bppRgb`), pale mint background with no alpha
- Semantic colors: indigo `#3E3A8C`, coral orange `#F06F5D`, pale mint background `#DDEFE7`
- SHA-256: `4C7393D8E4DD6EE8018CDFC3D55CE74F687960A1BBCA76DDA076A2F61AD9E8F3`
- Evaluation: both paired side chambers are fully visible and safely inset; the broad visor and friendly face read at small scale; palette is more energetic and clearly distinct from C1; no text or complex mechanical details.
- Deviations: the lower-right corner is occupied by the intended cropped lower mass; the background has a visible soft vignette/tonal variation; the mouth was placed below rather than inside the visor; the broad lower-right extension reads somewhat like a neck/body; internal modeling exceeds the intended barely-visible level; side chambers remain ear/headphone-like.
- Recommendation: non-recommended under the strict skill rubric because of the background vignette, misplaced mouth, and body-like extension. Keep it as a palette/composition exploration only.

### Complete final prompt

```text
Use case: logo-brand
Asset type: final square desktop app icon candidate C2 for Hub, a local-first multi-library search and flashcard-memory application.
Generate ONE 1:1 square FLAT VECTOR-STYLE LOGO artwork, approximately 1536 × 1536, with normal square corners.
BACKGROUND HARD REQUIREMENT: a single mathematically even-looking opaque pale mint (#DDEFE7) flat color field across the whole canvas. All four corners must look exactly the same color. No transparency and absolutely no gradient, vignette, halo, glow, texture, lighting, or shade.
ONLY SUBJECT: one compact friendly ROBOT HEAD symbol—no body and no limbs. Build it from exactly 8 broad shapes: (1) one heavy rounded indigo head shell, (2) one extremely wide rounded coral-orange visor, (3–4) exactly two thick coral-orange side chambers shaped as broad rounded document sheets, (5–6) two indigo oval eyes, (7) one short thick indigo mouth, (8) one broad lower indigo mass merged visually into the head.
CRITICAL PAIRED FEATURE: show BOTH coral side chambers completely, including their entire outer rounded silhouettes, with generous pale-mint clearance between each chamber and every canvas edge. Neither chamber may touch or cross an image edge. They are attached directly to the head, one at left and one at right, and have no markings.
Colors: use exactly three semantic colors only—indigo (#3E3A8C), coral orange (#F06F5D), and pale mint (#DDEFE7). No black, white, gray, yellow, cyan, or fourth hue. Reuse indigo for the two eyes and mouth.
Composition: upright head emerging from the lower-right, occupying about 78% of the square. Crop only the broad indigo lower mass at the bottom-right corner. Keep the top of the head, the full visor, and BOTH full side chambers safely inset inside the canvas. Face slightly high-left, no tilt.
Brand feel: professional, reliable, intelligent, and gentle. The broad visor plus two side chambers is the single identifying feature. Must remain recognizable at 32 × 32.
Style: ultra-clean Flat-first geometric logo with thick, soft, rounded, weighty contours and broad purposeful color masses. Mostly perfectly flat; allow at most 8% barely perceptible tonal modeling inside the robot only. Vector-friendly.
Constraints: no text, watermark, border, frame, card, badge, App-icon mask, external shadow, extra subject, scene, object, symbol, search icon, magnifying glass, book, button, screw, label, antenna, cable, seam, armor, UI, document line, notch, mechanical detail, torso, neck, shoulder, arm, hand, leg, or floating shape. No thin line, narrow gap, sharp corner, pointed tip, photorealism, clay, plastic, toy look, bevel, gloss, hotspot, occlusion, extrusion, or strong 3D.
```
