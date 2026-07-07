import Link from "next/link";
import {
  type GalleryIntegration,
  protocolBadgeClassName,
  protocolLabel,
} from "@/lib/integrations/data";
import { IntegrationLogo } from "./integration-logo";

interface IntegrationCardProps {
  integration: GalleryIntegration;
}

export const IntegrationCard = ({ integration }: IntegrationCardProps) => {
  const surfaces = integration.surfaces ?? [];
  const authLabels = [...new Set(surfaces.flatMap((surface) => surface.authLabels))];
  const detailLabels =
    integration.type === "channel"
      ? ["Channel"]
      : [...authLabels, ...(integration.source === "generated" ? ["Generated"] : [])];

  return (
    <Link
      className="group flex min-h-52 min-w-0 flex-col gap-4 rounded-lg border bg-background-100 p-5 transition-colors [contain-intrinsic-size:208px] [content-visibility:auto] hover:border-gray-400 hover:bg-gray-100"
      href={`/integrations/${integration.slug}`}
    >
      <div className="flex items-center justify-between">
        <span className="flex size-10 items-center justify-center rounded-md border bg-background text-gray-1000">
          <IntegrationLogo className="size-5" integration={integration} size={20} />
        </span>
        <div className="flex items-center gap-1.5">
          {integration.type === "channel" ? (
            <span className="rounded-full border bg-background px-2 py-0.5 font-medium text-gray-900 text-xs">
              Channel
            </span>
          ) : (
            surfaces.map((surface) => (
              <span
                className={`rounded-full px-2 py-0.5 font-medium text-xs ${protocolBadgeClassName[surface.protocol]}`}
                key={surface.protocol}
              >
                {protocolLabel[surface.protocol]}
              </span>
            ))
          )}
        </div>
      </div>
      <div className="flex flex-1 flex-col gap-1">
        <h3 className="break-words font-medium text-base text-gray-1000 tracking-tight">
          {integration.name}
        </h3>
        <p className="break-words text-gray-900 text-sm leading-relaxed">{integration.tagline}</p>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {detailLabels.slice(0, 3).map((label) => (
          <span className="rounded-full border px-2 py-0.5 text-gray-900 text-xs" key={label}>
            {label}
          </span>
        ))}
        {detailLabels.length > 3 ? (
          <span className="rounded-full border px-2 py-0.5 text-gray-900 text-xs">
            +{detailLabels.length - 3}
          </span>
        ) : null}
      </div>
    </Link>
  );
};
