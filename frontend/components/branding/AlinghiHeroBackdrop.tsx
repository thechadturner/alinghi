import markPngUrl from "../../../assets/alinghi.png";

/**
 * Decorative Alinghi swirl + wordmark for the index hero (guest and logged-in).
 * Raster from `alinghi.png`; low-opacity via CSS under existing gradient overlays.
 */
export default function AlinghiHeroBackdrop() {
  return (
    <div class="alinghi-hero-backdrop pointer-events-none" aria-hidden="true">
      <svg
        class="alinghi-hero-backdrop__svg"
        viewBox="0 0 100 100"
        preserveAspectRatio="xMidYMid meet"
      >
        <image
          class="alinghi-hero-backdrop__image"
          href={markPngUrl}
          x="0"
          y="0"
          width="100"
          height="100"
          preserveAspectRatio="xMidYMid meet"
        />
      </svg>
    </div>
  );
}
