import { NEXORA_LOGO_SRC } from "./nexora-logo-data";

export function BrandLogo({ logoClassName = "brand-logo" }: { logoClassName?: string }) {
  return (
    <a className="brand" href="/" aria-label="Nexora home">
      <img className={logoClassName} src={NEXORA_LOGO_SRC} alt="" />
    </a>
  );
}
