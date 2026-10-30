import { NEXORA_LOGO_SRC } from "./nexora-logo-data";

export function BrandLogo({
  logoClassName = "brand-logo",
  href = "/",
}: {
  logoClassName?: string;
  href?: string;
}) {
  return (
    <a
      className="brand"
      href={href}
      aria-label={href === "/workspaces" ? "Nexora workspaces" : "Nexora home"}
    >
      <img className={logoClassName} src={NEXORA_LOGO_SRC} alt="" />
    </a>
  );
}
