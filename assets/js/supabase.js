import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm";

const supabaseUrl = "https://fanixwnyglkvkgsxxrtn.supabase.co";
const supabaseKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZhbml4d255Z2xrdmtnc3h4cnRuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI4MTEwOTEsImV4cCI6MjA5ODM4NzA5MX0.a8ixSq_-50Pz4vmfcvNv1JRGWe0gV9OfIluU-_TrCts";

export const supabase = createClient(supabaseUrl, supabaseKey);