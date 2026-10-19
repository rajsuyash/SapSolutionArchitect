export async function register() {
  // Builds are portable and do not need deployment secrets or running infrastructure.
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NEXT_PHASE !== "phase-production-build") {
    const { getRuntime } = await import("./lib/runtime");
    try {
      getRuntime();
    } catch (error) {
      // Next logs registration failures but can leave the server process alive.
      // Validation emits variable names only; never print an arbitrary driver error.
      console.error(error instanceof Error && error.message.startsWith("Invalid environment variables:")
        ? error.message : "Server initialization failed");
      process.exit(1);
    }
  }
}
