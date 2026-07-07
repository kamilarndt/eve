import type { Metadata } from "next";
import { galleryIntegrations, integrations } from "@/lib/integrations/data";
import { translations } from "@/geistdocs";
import { Gallery } from "./components/gallery";

const title = "Integrations";
const description =
  "Browse every third-party service eve connects to: messaging channels, MCP connections, and OpenAPI connections, each with install, quick start, and configuration steps.";

export const metadata: Metadata = {
  title,
  description,
};

export const generateStaticParams = () => Object.keys(translations).map((lang) => ({ lang }));

const integrationCount = integrations.length.toLocaleString();
const generatedCount = integrations
  .filter((integration) => integration.source === "generated")
  .length.toLocaleString();

const IntegrationsPage = () => (
  <main
    className="mx-auto w-screen overflow-hidden px-4 pb-32 sm:px-6"
    style={{ maxWidth: "min(1080px, 100vw)" }}
  >
    <section className="flex w-full min-w-0 flex-col items-center px-4 pt-24 pb-12 text-center">
      <h1 className="font-bold text-5xl text-gray-1000 tracking-tighter sm:text-6xl">
        Integrations
      </h1>
      <p className="mt-5 w-full min-w-0 max-w-full text-gray-900 text-lg sm:max-w-2xl">
        Browse {integrationCount} integration options across Channels, MCP, and OpenAPI, including{" "}
        {generatedCount} remote MCP servers and OpenAPI specs from public registries.
      </p>
    </section>
    <Gallery integrations={galleryIntegrations} />
  </main>
);

export default IntegrationsPage;
