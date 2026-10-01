import fs from "node:fs";
import { awaitWithContext } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { DurableAgentRuntime } from "./agent-runtime";

const [file, marker, cwd] = process.argv.slice(2);
if (!file || !marker || !cwd) throw new Error("file, marker, and cwd are required");

const hold = defineTool({
  name: "hold",
  description: "Report that the call started, then wait until the process ends.",
  parameters: Type.Object({}),
  execute: async (_args, _api, context) => {
    fs.writeFileSync(marker, String(process.pid));
    await awaitWithContext(new Promise<never>(() => {}), context);
    return {};
  },
});

async function main(): Promise<void> {
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage([fauxToolCall("hold", {})], { stopReason: "toolUse" })]);
  const runtime = await DurableAgentRuntime.open({
    file: file!,
    models,
    extensions: [defineExtension({ name: "hold-tools", tools: [hold] })],
  });
  await runtime.spawn({
    name: "reader",
    role: "read",
    prompt: "Inspect the build and report.",
    cwd: cwd!,
    model: { provider: "faux", modelId: "faux-1" },
    requestId: "spawn:reader",
  });
  // The parent test kills this process; exit on its own if that never happens.
  setTimeout(() => process.exit(2), 60_000);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
