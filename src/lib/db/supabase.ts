import { createClient, SupabaseClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

let serverSupabaseInstance: SupabaseClient | null = null;

export function getServerSupabase(): SupabaseClient {
  if (serverSupabaseInstance) {
    return serverSupabaseInstance;
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    if (process.env.NODE_ENV === "test") {
      // In test mode, fallback to placeholder if mocked
      return createClient("https://placeholder-test.supabase.co", "placeholder-key", {
        auth: { persistSession: false },
      });
    }
    throw new Error(
      "[Supabase Security Gate] Fail-closed: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are mandatory for trusted backend database operations."
    );
  }

  serverSupabaseInstance = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  return serverSupabaseInstance;
}

// Export default server client instance (fails closed if unconfigured)
export const supabase = {
  from(table: string) {
    return getServerSupabase().from(table);
  },
  rpc(fn: string, args: Record<string, unknown>) {
    return getServerSupabase().rpc(fn, args);
  },
};
