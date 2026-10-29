import { NEXORA_LOGO_SRC } from "./nexora-logo-data";

export function BrandLogo() {
  return (
    <a className="brand" href="/" aria-label="Nexora home">
      <img className="brand-logo" src={NEXORA_LOGO_SRC} alt="" />
    </a>
  );
}
