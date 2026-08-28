// Service-role Supabase client shared by every edge function.
// Service role bypasses RLS, which is why these functions authenticate callers
// themselves (cron secret / console passcode) rather than relying on JWTs.
import { createClient } from "jsr:@supabase/supabase-js@2";

export const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);
