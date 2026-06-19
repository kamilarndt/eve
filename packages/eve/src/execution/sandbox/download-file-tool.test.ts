import { describe, expect, it, vi } from "vitest";

import { MAX_DOWNLOAD_FILE_BYTES } from "#shared/download-file.js";
import type { SandboxSession } from "#shared/sandbox-session.js";

import { executeDownloadFileOnSandbox } from "./download-file-tool.js";

describe("executeDownloadFileOnSandbox", () => {
  it("returns a bounded file as a data URL", async () => {
    const readFile = vi.fn(async () => streamOf(Buffer.from("hello")));
    const sandbox = createTestSandboxSession(readFile);

    const result = await executeDownloadFileOnSandbox(sandbox, {
      filePath: "/workspace/report.txt",
      mediaType: "text/plain",
    });

    expect(readFile).toHaveBeenCalledWith({ path: "/workspace/report.txt" });
    expect(result).toEqual({
      filename: "report.txt",
      mediaType: "text/plain",
      size: 5,
      type: "file",
      url: "data:text/plain;base64,aGVsbG8=",
    });
  });

  it("supports an explicit download filename", async () => {
    const sandbox = createTestSandboxSession(async () => streamOf(new Uint8Array([0, 1, 2])));

    const result = await executeDownloadFileOnSandbox(sandbox, {
      filePath: "/workspace/output.bin",
      filename: "archive.dat",
    });

    expect(result.filename).toBe("archive.dat");
    expect(result.mediaType).toBe("application/octet-stream");
  });

  it("rejects missing files", async () => {
    const sandbox = createTestSandboxSession(async () => null);

    await expect(
      executeDownloadFileOnSandbox(sandbox, { filePath: "/workspace/missing.txt" }),
    ).rejects.toThrow("File not found: /workspace/missing.txt");
  });

  it("cancels the read when the file exceeds the byte cap", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_DOWNLOAD_FILE_BYTES + 1));
      },
    });
    const sandbox = createTestSandboxSession(async () => stream);

    await expect(
      executeDownloadFileOnSandbox(sandbox, { filePath: "/workspace/large.bin" }),
    ).rejects.toThrow(`${String(MAX_DOWNLOAD_FILE_BYTES)}-byte download limit`);
    expect(cancelled).toBe(true);
  });

  it("rejects unsafe filenames and media types", async () => {
    const sandbox = createTestSandboxSession(async () => streamOf(new Uint8Array()));

    await expect(
      executeDownloadFileOnSandbox(sandbox, {
        filePath: "/workspace/report.txt",
        filename: "../report.txt",
      }),
    ).rejects.toThrow("filename must be a non-empty base name");

    await expect(
      executeDownloadFileOnSandbox(sandbox, {
        filePath: "/workspace/report.txt",
        mediaType: "text/plain;base64",
      }),
    ).rejects.toThrow("mediaType must be a valid MIME type");
  });

  it("rejects files outside the workspace", async () => {
    const readFile = vi.fn(async () => streamOf(new Uint8Array()));
    const sandbox = createTestSandboxSession(readFile);

    await expect(
      executeDownloadFileOnSandbox(sandbox, { filePath: "/workspace/../etc/passwd" }),
    ).rejects.toThrow("only supports files under /workspace");
    expect(readFile).not.toHaveBeenCalled();
  });
});

function streamOf(content: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(content);
      controller.close();
    },
  });
}

function createTestSandboxSession(readFile: SandboxSession["readFile"]): SandboxSession {
  return {
    id: "test-sandbox",
    readBinaryFile: async () => null,
    readFile,
    readTextFile: async () => null,
    removePath: async () => {},
    resolvePath: (path) => path,
    run: async () => ({ exitCode: 0, stderr: "", stdout: "" }),
    setNetworkPolicy: async () => {},
    spawn: async () => {
      throw new Error("spawn is not implemented in this test sandbox");
    },
    writeBinaryFile: async () => {},
    writeFile: async () => {},
    writeTextFile: async () => {},
  };
}
