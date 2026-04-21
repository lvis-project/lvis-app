/**
 * Hello World — dev-only sample plugin.
 * Registers a single `hello_world` tool for smoke-testing the plugin pipeline.
 */
export async function register(context, hostApi) {
  const { log } = context;
  log("[hello-world] registered");

  hostApi.registerKeywords([{ keyword: "안녕", skillId: "hello_world" }]);

  hostApi.registerMethod("hello_world", async ({ name }) => {
    const target = typeof name === "string" && name.trim() ? name.trim() : "World";
    return `Hello, ${target}! 👋 (LVIS dev plugin)`;
  });
}
