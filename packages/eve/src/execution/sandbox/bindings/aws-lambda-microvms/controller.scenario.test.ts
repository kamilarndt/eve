import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterAll, describe, expect, it } from "vitest";

import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";

const runControllerScenarios = process.env.EVE_RUN_AWS_MICROVM_CONTROLLER_SCENARIOS === "1";
const runFile = promisify(execFile);
const createScratchDirectory = useTemporaryDirectories();
const controllerContext = fileURLToPath(new URL("./controller", import.meta.url));
const runId = `eve-aws-controller-${Date.now()}`;
const image = `${runId}:test`;
const containers = [`${runId}-source`, `${runId}-restore`] as const;

describe.runIf(runControllerScenarios)("AWS Lambda MicroVM ARM64 controller", () => {
  afterAll(async () => {
    for (const container of containers) {
      await docker(["rm", "-f", container]).catch(() => undefined);
    }
    await docker(["rmi", "-f", image]).catch(() => undefined);
  }, 60_000);

  it(
    "restores the complete overlay into a fresh ARM64 container",
    async () => {
      await docker(["build", "--platform", "linux/arm64", "-t", image, controllerContext]);
      const sourcePort = await startContainer(containers[0]);
      await waitForHealth(sourcePort);
      await postJson(
        `http://127.0.0.1:${sourcePort.hooks}/aws/lambda-microvms/runtime/v1/validate`,
        {},
      );
      await postJson(`http://127.0.0.1:${sourcePort.hooks}/aws/lambda-microvms/runtime/v1/run`, {
        microvmId: "mvm-scenario",
        runHookPayload: JSON.stringify({ controllerProtocolVersion: 1 }),
      });

      await runCommand(sourcePort.control, "background", "sleep 300 &", false);
      await docker(["pause", containers[0]]);
      await docker(["unpause", containers[0]]);
      expect(await processStatus(sourcePort.control, "background")).toMatchObject({
        state: "running",
      });
      await fetchOk(`http://127.0.0.1:${sourcePort.control}/v1/processes/background`, {
        method: "DELETE",
      });

      await runCommand(
        sourcePort.control,
        "write-state",
        [
          "test ! -e /opt/eve/controller",
          "if readlink /proc/1/exe | grep -q python; then echo controller-visible >&2; exit 1; fi",
          "if find /dev -type b -print -quit | grep -q .; then echo block-device-visible >&2; exit 1; fi",
          "if unshare --mount /bin/true 2>/dev/null; then echo unexpected-unshare >&2; exit 1; fi",
          "if mknod /tmp/eve-block b 7 0 2>/dev/null; then echo unexpected-mknod >&2; exit 1; fi",
          "test -e /etc/GREP_COLORS",
          "rm /etc/GREP_COLORS",
          "printf '#!/bin/bash\\necho hello-from-eve\\n' > /usr/local/bin/eve-greet",
          "chmod 0755 /usr/local/bin/eve-greet",
          "printf system > /etc/eve.conf",
          "mkdir -p /root/eve /var/lib/eve /workspace",
          "printf root > /root/eve/state",
          "printf var > /var/lib/eve/state",
          "printf tmp > /tmp/eve-state",
          "printf workspace > /workspace/state.txt",
          "setfattr -n user.eve -v xattr /workspace/state.txt",
          "setfacl -m u:1234:r /workspace/state.txt",
          "ln /workspace/state.txt /workspace/state.hardlink",
          "ln -s state.txt /workspace/state.symlink",
        ].join(" && "),
      );
      const checkpoint = await postJson<{
        checkpointId: string;
        sha256: string;
        size: number;
      }>(`http://127.0.0.1:${sourcePort.control}/v1/checkpoints/prepare`, {});
      const scratch = await createScratchDirectory("eve-aws-controller-");
      const archive = `${scratch}/checkpoint.tar.zst`;
      await docker([
        "cp",
        `${containers[0]}:/opt/eve/state/archives/${checkpoint.checkpointId}.tar.zst`,
        archive,
      ]);
      await docker(["rm", "-f", containers[0]]);

      const restorePort = await startContainer(containers[1]);
      await waitForHealth(restorePort);
      await docker(["cp", archive, `${containers[1]}:/tmp/checkpoint.tar.zst`]);
      await docker([
        "exec",
        "-d",
        containers[1],
        "python3",
        "-m",
        "http.server",
        "18081",
        "--bind",
        "127.0.0.1",
        "--directory",
        "/tmp",
      ]);
      await waitForArchiveServer(containers[1]);
      await postJson(`http://127.0.0.1:${restorePort.control}/v1/checkpoints/restore`, {
        sha256: checkpoint.sha256,
        size: checkpoint.size,
        url: "http://127.0.0.1:18081/checkpoint.tar.zst",
      });

      const output = await runCommand(
        restorePort.control,
        "verify-state",
        [
          "test ! -e /etc/GREP_COLORS",
          'test "$(cat /etc/eve.conf)" = system',
          'test "$(cat /root/eve/state)" = root',
          'test "$(cat /var/lib/eve/state)" = var',
          'test "$(cat /tmp/eve-state)" = tmp',
          'test "$(cat /workspace/state.txt)" = workspace',
          'test "$(/usr/local/bin/eve-greet)" = hello-from-eve',
          'test "$(getfattr --only-values -n user.eve /workspace/state.txt)" = xattr',
          "getfacl -cp /workspace/state.txt | grep -q 'user:1234:r--'",
          'test "$(stat -c %i /workspace/state.txt)" = "$(stat -c %i /workspace/state.hardlink)"',
          'test "$(readlink /workspace/state.symlink)" = state.txt',
          "printf verified",
        ].join(" && "),
      );
      expect(output).toBe("verified");
    },
    5 * 60_000,
  );
});

async function startContainer(
  name: string,
): Promise<{ readonly control: number; readonly hooks: number }> {
  await docker([
    "run",
    "--privileged",
    "--platform",
    "linux/arm64",
    "--name",
    name,
    "-P",
    "-d",
    image,
  ]);
  return {
    control: await mappedPort(name, 8080),
    hooks: await mappedPort(name, 9000),
  };
}

async function mappedPort(container: string, port: number): Promise<number> {
  const { stdout } = await docker(["port", container, `${port}/tcp`]);
  const value = Number(stdout.trim().split(":").at(-1));
  if (!Number.isInteger(value)) throw new Error(`Docker returned an invalid port: ${stdout}`);
  return value;
}

async function waitForHealth(ports: { readonly control: number }): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await fetchOk(`http://127.0.0.1:${ports.control}/v1/health`);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error("Controller did not become healthy.", { cause: lastError });
}

async function waitForArchiveServer(container: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      await docker([
        "exec",
        container,
        "python3",
        "-c",
        "import urllib.request; urllib.request.urlopen('http://127.0.0.1:18081/checkpoint.tar.zst').read(1)",
      ]);
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error("Checkpoint server did not become healthy.", { cause: lastError });
}

async function runCommand(
  port: number,
  requestId: string,
  command: string,
  wait = true,
): Promise<string> {
  await postJson(`http://127.0.0.1:${port}/v1/processes`, { command, requestId });
  if (!wait) return "";
  for (;;) {
    const status = await processStatus(port, requestId);
    if (status.state === "exited") {
      const [stdout, stderr] = await Promise.all([
        readProcessLog(port, requestId, "stdout"),
        readProcessLog(port, requestId, "stderr"),
      ]);
      expect(status.exitCode, `stdout:\n${stdout}\nstderr:\n${stderr}`).toBe(0);
      return stdout;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function readProcessLog(
  port: number,
  processId: string,
  stream: "stderr" | "stdout",
): Promise<string> {
  return await (
    await fetchOk(`http://127.0.0.1:${port}/v1/processes/${processId}/logs/${stream}?offset=0`)
  ).text();
}

async function processStatus(
  port: number,
  processId: string,
): Promise<{ readonly exitCode: number | null; readonly state: string }> {
  const response = await fetchOk(`http://127.0.0.1:${port}/v1/processes/${processId}`);
  return (await response.json()) as { exitCode: number | null; state: string };
}

async function postJson<T = Record<string, unknown>>(url: string, value: unknown): Promise<T> {
  const response = await fetchOk(url, {
    body: JSON.stringify(value),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  return (await response.json()) as T;
}

async function fetchOk(url: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response;
}

async function docker(args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  return await runFile(process.env.EVE_DOCKER_PATH ?? "docker", [...args], {
    maxBuffer: 10 * 1024 * 1024,
  });
}
