import { createClient } from '@supabase/supabase-js';

let rawUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
// Clean URL: remove trailing slashes or /rest/v1/ suffix if present
rawUrl = rawUrl.replace(/\/+$/, '').replace(/\/rest\/v1$/i, '');
const supabaseUrl = rawUrl;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

if (!supabaseUrl || !supabaseKey) {
  console.warn('Supabase credentials missing. Ensure NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are set.');
}

// We use the service role key if available for backend operations to bypass RLS,
// otherwise fallback to anon key for local testing.
export const supabase = createClient(supabaseUrl, supabaseKey);
