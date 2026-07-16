import { KeyRound } from "lucide-react";
import type { CSSProperties } from "react";
import "@/components/provider-brand-mark.css";
import codebergLogo from "@/assets/provider-brands/codeberg.svg";
import forgejoLogo from "@/assets/provider-brands/forgejo.svg";
import giteaLogo from "@/assets/provider-brands/gitea.svg";
import githubLogo from "@/assets/provider-brands/github.svg";
import gitlabLogo from "@/assets/provider-brands/gitlab.svg";
import type { IdentityProvider } from "@/lib/api";

export type ProviderBrand = IdentityProvider["brand"];

function providerLogo(brand: ProviderBrand): string | null {
  switch (brand) {
    case "github":
      return githubLogo;
    case "gitlab":
      return gitlabLogo;
    case "gitea":
      return giteaLogo;
    case "forgejo":
      return forgejoLogo;
    case "codeberg":
      return codebergLogo;
    case "identity":
      return null;
  }
}

export function ProviderBrandMark({
  brand,
  size = 32,
  className = ""
}: {
  brand: ProviderBrand;
  size?: number;
  className?: string;
}) {
  const logo = providerLogo(brand);
  const style = {
    "--provider-brand-mark-size": `${size}px`
  } as CSSProperties;
  return (
    <span
      className={`provider-brand-mark ${className}`.trim()}
      data-provider-brand={brand}
      data-provider-logo={brand}
      style={style}
      aria-hidden
    >
      {logo ? (
        <img src={logo} alt="" draggable={false} />
      ) : (
        <KeyRound size={Math.max(14, Math.round(size * 0.56))} strokeWidth={1.8} />
      )}
    </span>
  );
}
