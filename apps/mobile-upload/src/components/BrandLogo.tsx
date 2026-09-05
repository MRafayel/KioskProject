/**
 * The EasyPrint mark.
 *
 * The same brand file the kiosk uses, served from this app's own
 * `public/logo.svg` so the phone page has no cross-origin asset to fetch — the
 * page's content policy allows images from this origin only, and a logo is not
 * a reason to widen it.
 *
 * White on a transparent background, so it sits directly on the blue tile the
 * header already draws. Sizing is left to that tile, and `contain` keeps the
 * file's own aspect ratio, so it scales with the phone rather than being
 * stretched to fit.
 *
 * Decorative — the product name sits beside it as text — so it carries an empty
 * alt rather than being described twice.
 */
export function BrandLogo() {
  return <img className="brand-logo" src="/logo.svg" alt="" aria-hidden="true" />;
}
