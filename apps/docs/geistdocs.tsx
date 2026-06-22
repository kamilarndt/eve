export const Logo = () => (
  <span className="flex items-center gap-2">
    <span className="font-semibold text-gray-1000 text-lg leading-none">eve</span>
    <span className="rounded-full border border-blue-300 px-2 py-0.5 font-medium text-blue-700 text-xs leading-none">
      Beta
    </span>
  </span>
);

export const github = {
  owner: "vercel",
  repo: "eve",
};

export const nav = [
  {
    label: "Docs",
    href: "/docs",
  },
  {
    label: "Integrations",
    href: "/integrations",
  },
  {
    label: "Resources",
    href: "/resources",
  },
  {
    label: "GitHub",
    href: `https://github.com/${github.owner}/${github.repo}/`,
  },
];

export const suggestions = [
  "How do I create my first agent?",
  "What is the agent directory structure?",
  "How do channels work?",
  "How do I add tools to an agent?",
];

export const agent = {
  product: {
    name: "eve",
    description:
      "A filesystem-first framework for durable backend agents, with a managed Vercel path and portable Node, provider, and sandbox options.",
    category: "Agent framework",
    audience: ["TypeScript engineers", "coding agents implementing eve applications"],
    useCases: [
      "Create durable agents with filesystem conventions",
      "Add channels, tools, skills, sandboxes, hooks, and schedules",
      "Deploy on Vercel or operate a self-hosted Node service",
    ],
  },
  instructions: [
    "To create or extend an eve agent, start from Quickstart at /llms.mdx/quickstart or use the task index in /llms.txt.",
    "Ask the user only for genuine decisions (name, model, channels, provider, deploy) and for browser/OAuth steps (vercel login, vercel link, vercel connect create slack); automate everything else.",
    "Verify setup with `eve info --json` and `eve channels list --json` before reporting success.",
    "Use /sitemap.md to identify the most relevant documentation pages before answering broad questions.",
    "Use /llms.txt when you need the complete documentation corpus as Markdown context.",
    "Fetch individual documentation pages with a .md or .mdx extension for focused page-level context.",
    "Use the authored HTTP API, stream-event, and TypeScript export references for exact contracts; do not infer APIs from examples.",
  ],
};

export const title = "Introducing eve";

export const prompt =
  "You are a helpful assistant specializing in eve, a filesystem-first framework for building durable agents on Vercel. You help users understand how to build agents using markdown for instructions, TypeScript for tools, and the framework's built-in durability, governance, and observability features.";

export const translations = {
  en: {
    displayName: "English",
  },
};

export const basePath: string | undefined = undefined;

export const siteId: string | undefined = "agent-framework";
