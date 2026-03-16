-- Fix tasks.id to auto-generate UUIDs so inserts without explicit id work
ALTER TABLE public.tasks ALTER COLUMN id SET DEFAULT gen_random_uuid()::text;

-- Also fix chat_messages.id default to use gen_random_uuid if not already
ALTER TABLE public.chat_messages ALTER COLUMN id SET DEFAULT gen_random_uuid()::text;
