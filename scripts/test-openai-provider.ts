/**
 * OpenAI Provider 직접 테스트 — Electron 없이 CLI에서 실행
 */
import { OpenAIProvider } from "../src/agent/llm/openai-provider.js";
import type { StreamEvent } from "../src/agent/llm/types.js";

const API_KEY = process.argv[2];
if (!API_KEY) {
  console.error("Usage: tsx scripts/test-openai-provider.ts <api-key>");
  process.exit(1);
}

async function testBasicChat() {
  console.log("=== Test 1: Basic Chat (no tools) ===");
  const provider = new OpenAIProvider(API_KEY);
  const events: StreamEvent[] = [];

  try {
    for await (const event of provider.streamTurn({
      model: "gpt-4o",
      systemPrompt: "You are a helpful assistant. Reply in Korean. Be concise.",
      messages: [{ role: "user", content: "안녕하세요, 간단히 자기소개해주세요." }],
      maxTokens: 200,
    })) {
      events.push(event);
      if (event.type === "text_delta") {
        process.stdout.write(event.text);
      } else {
        console.log("\n[EVENT]", JSON.stringify(event));
      }
    }
    console.log("\n--- Events count:", events.length);
    console.log("✅ Basic chat passed\n");
  } catch (err) {
    console.error("❌ Basic chat failed:", err);
  }
}

async function testWithTools() {
  console.log("=== Test 2: Chat with Tools ===");
  const provider = new OpenAIProvider(API_KEY);

  try {
    const events: StreamEvent[] = [];
    for await (const event of provider.streamTurn({
      model: "gpt-4o",
      systemPrompt: "You are a helpful assistant with tools.",
      messages: [{ role: "user", content: "Save a note with title 'test' and content 'hello world'" }],
      tools: [{
        name: "memory_save",
        description: "Save a note",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string", description: "Note title" },
            content: { type: "string", description: "Note content" },
          },
          required: ["title", "content"],
        },
      }],
      maxTokens: 200,
    })) {
      events.push(event);
      if (event.type === "text_delta") process.stdout.write(event.text);
      else console.log("\n[EVENT]", JSON.stringify(event));
    }
    console.log("\n--- Events:", events.length);
    const toolCalls = events.filter((e) => e.type === "tool_call");
    console.log("Tool calls:", toolCalls.length);
    console.log("✅ Tool test passed\n");
  } catch (err) {
    console.error("❌ Tool test failed:", err);
  }
}

async function main() {
  await testBasicChat();
  await testWithTools();
}

main().catch(console.error);
