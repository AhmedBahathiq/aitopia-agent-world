interface Env {
  DB: D1Database;
  WorldAgent: DurableObjectNamespace;
  PUBLIC_RATE_LIMITER?: RateLimit;
  ADMIN_RATE_LIMITER?: RateLimit;
  SIMULATION_MODEL: string;
  ALLOWED_ORIGIN: string;
  MAX_MODEL_CALLS_PER_DAY?: string;
  MAX_TOTAL_TOKENS_PER_DAY?: string;
  SIMULATION_MODE?: string;
  OPENAI_API_KEY?: string;
  ADMIN_BRIDGE_SECRET?: string;
}
