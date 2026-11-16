/*
  The AERONEX brand, as it appears inside the app.

  The masters are in brand/ (the primary logo and the app icon). Every file
  made from them, here and in public/, comes from scripts/brand-assets.py, so
  change a master and run that script rather than editing these images:

    mark-tile.png  the app icon's orange-rimmed tile with the A mark alone,
                   for small sizes where the icon's words can't be read
    logo.webp      the primary logo with its paper background taken off
*/
import markTile from "../../assets/brand/mark-tile.png";
import logo from "../../assets/brand/logo.webp";

/** Pixel size of logo.webp, so the page keeps its space while it loads. */
const LOGO_SIZE = { width: 960, height: 621 } as const;

export function BrandMark({ className = "brand-mark" }: { className?: string }) {
  return <img className={className} src={markTile} alt="" width={192} height={192} draggable={false} />;
}

/** The primary logo: mark, wordmark and "UAV Application". */
export function BrandLogo({ className }: { className?: string }) {
  return <img className={className} src={logo} alt="AERONEX UAV Application" {...LOGO_SIZE} draggable={false} />;
}

/** Mark and name together, as they sit in the top-left of the app. */
export function BrandLockup() {
  return (
    <>
      <BrandMark />
      <span className="brand-name">
        {/* The orange X, as in the logo's wordmark. */}
        <span className="brand-word">
          AERONE<em>X</em>
        </span>
        <span>Ground Station</span>
      </span>
    </>
  );
}
