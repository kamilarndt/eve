import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  CREDENTIAL_PROBE_CLEANUP_PATH,
  CREDENTIAL_PROBE_PATH,
  CREDENTIAL_PROBE_TOKEN,
  CREDENTIAL_PROBE_UNAVAILABLE_PATH,
} from "../credential-probe.js";

export default defineTool({
  description:
    "Vercel-only E2E fixture: verify sandbox firewall credential injection and schedule a post-step cleanup probe. Only call when explicitly asked to use `credential-probe`.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    if (typeof process.env.VERCEL_REGION !== "string") {
      return { mode: "local", supported: false } as const;
    }

    const deploymentHost = process.env.VERCEL_URL;
    if (deploymentHost === undefined || deploymentHost.length === 0) {
      throw new Error("credential-probe: VERCEL_URL is unavailable in a Vercel deployment");
    }

    const sandbox = await ctx.getSandbox();
    const environment = await sandbox.run({
      command: "env; if [ -r /proc/self/environ ]; then tr '\\0' '\\n' < /proc/self/environ; fi",
    });
    const credentialVisibleToProcess = `${environment.stdout}\n${environment.stderr}`.includes(
      CREDENTIAL_PROBE_TOKEN,
    );

    const authorizedUrl = `https://${deploymentHost}${CREDENTIAL_PROBE_PATH}`;
    const authorized = await sandbox.run({
      command: `curl -sS --max-time 15 ${shellQuote(authorizedUrl)}`,
    });
    const authorizedResponse = parseProbeResponse(authorized.stdout);

    const unavailableUrl = `https://${deploymentHost}${CREDENTIAL_PROBE_UNAVAILABLE_PATH}`;
    const unavailable = await sandbox.run({
      command: `curl -sS --max-time 5 -o /dev/null ${shellQuote(unavailableUrl)}`,
    });

    await sandbox.removePath({ force: true, path: CREDENTIAL_PROBE_CLEANUP_PATH });
    await sandbox.spawn({
      command:
        `sleep 3; if curl -sS --max-time 5 -o /dev/null ${shellQuote(authorizedUrl)}; ` +
        `then printf allowed; else printf blocked; fi > ${shellQuote(CREDENTIAL_PROBE_CLEANUP_PATH)}`,
    });

    return {
      authorized: authorized.exitCode === 0 && authorizedResponse.authorized === true,
      credentialVisibleToProcess,
      mode: "vercel",
      supported: true,
      unavailableRouteBlocked: unavailable.exitCode !== 0,
    } as const;
  },
});

function parseProbeResponse(value: string): { readonly authorized?: unknown } {
  try {
    return JSON.parse(value) as { readonly authorized?: unknown };
  } catch {
    return {};
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
