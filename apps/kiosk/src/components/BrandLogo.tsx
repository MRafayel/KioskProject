/**
 * The EasyPrint mark.
 *
 * The artwork is served from `public/logo.svg` rather than inlined here, so the
 * brand file is the single thing to replace when the brand changes and no
 * component has to be edited to do it. It is white on a transparent
 * background, which is what lets it sit directly on the blue tile the header
 * and welcome screen already draw instead of carrying a background of its own.
 *
 * Sizing is left entirely to that tile. The file is square and `contain` keeps
 * its own aspect ratio, so the mark scales with whatever box encloses it and
 * cannot be stretched by a tile that is a different size on another screen.
 *
 * Decorative in every place it is used — the product name is beside it as
 * text — so it carries an empty alt rather than being described twice.
 */
export function BrandLogo() {
  return <img className="brand-logo" src="/logo.svg" alt="" aria-hidden="true" />;
}
