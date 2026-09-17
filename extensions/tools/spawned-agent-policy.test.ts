import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findPackageJSON } from "node:module";
import { pathToFileURL } from "node:url";
import { AuthStorage, createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@mariozechner/pi-coding-agent";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { registerSpawnedAgentCommunicationGuard, USER_INTERACTION_TOOLS } from "./spawned-agent-policy";

describe("spawned-agent communication guard", () => {
  let root: string;
  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("blocks activated user tools through the installed SDK while allowing lead communication", async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "spawned-agent-policy-"));
    const codingPackage = findPackageJSON("@mariozechner/pi-coding-agent", pathToFileURL(path.join(process.cwd(), "package.json")).href)!;
    const aiPackage = findPackageJSON("@mariozechner/pi-ai", pathToFileURL(fs.realpathSync(codingPackage)).href)!;
    const aiManifest = JSON.parse(fs.readFileSync(aiPackage, "utf8"));
    const { createAssistantMessageEventStream, getModel } = await import(pathToFileURL(path.resolve(path.dirname(aiPackage), aiManifest.main)).href);
    const forbiddenExecute = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "Asked user" }], details: {},
    }));
    const sendToLead = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "Sent to lead" }], details: {},
    }));
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const resourceLoader = new DefaultResourceLoader({
      cwd: root,
      agentDir: root,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      settingsManager,
      agentsFilesOverride: () => ({ agentsFiles: [] }),
      extensionFactories: [
        registerSpawnedAgentCommunicationGuard,
        pi => {
          for (const name of USER_INTERACTION_TOOLS) {
            pi.registerTool({ name, label: name, description: name, parameters: Type.Object({}), execute: forbiddenExecute });
          }
        },
      ],
    });
    await resourceLoader.reload();
    const model = getModel("openai", "gpt-4o");
    const { session } = await createAgentSession({
      cwd: root,
      agentDir: root,
      model,
      authStorage: AuthStorage.inMemory({ openai: { type: "api_key", key: "test-only" } }),
      settingsManager,
      sessionManager: SessionManager.inMemory(),
      resourceLoader,
      // Deliberately activate forbidden tools to exercise execution denial, not filtering.
      tools: [...USER_INTERACTION_TOOLS, "send_message"],
      customTools: [{
        name: "send_message",
        label: "Send",
        description: "Send to lead",
        parameters: Type.Object({}),
        execute: sendToLead,
      }],
    });
    let turns = 0;
    session.agent.streamFn = () => {
      const stream = createAssistantMessageEventStream();
      const toolTurn = turns++ === 0;
      const message: AssistantMessage = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        timestamp: Date.now(),
        content: toolTurn
          ? [...USER_INTERACTION_TOOLS, "send_message"].map(name => ({ type: "toolCall" as const, id: name, name, arguments: {} }))
          : [{ type: "text", text: "Done" }],
        stopReason: toolTurn ? "toolUse" : "stop",
        usage: {
          input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      stream.push({ type: "done", reason: toolTurn ? "toolUse" : "stop", message });
      stream.end();
      return stream;
    };
    try {
      await session.bindExtensions({});
      await session.prompt("Exercise the communication boundary");
      expect(forbiddenExecute).not.toHaveBeenCalled();
      expect(sendToLead).toHaveBeenCalledOnce();
      const denied = session.messages.filter(message => message.role === "toolResult" && message.isError);
      expect(denied).toHaveLength(USER_INTERACTION_TOOLS.length);
      expect(turns).toBe(2);
    } finally {
      session.dispose();
    }
  });
});
