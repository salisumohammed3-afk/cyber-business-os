-- Allow 'jwt_es256' as a valid auth_type for vendors that use signed-JWT auth
-- (Apple App Store Connect, MapKit, MusicKit, etc.).
--
-- ES256 + IEEE P-1363 signature, signed per request by the runner using the
-- stored private_key + key_id + issuer_id credentials. See api/lib/jwt-es256.mjs.

ALTER TABLE public.integrations
  DROP CONSTRAINT IF EXISTS integrations_auth_type_check;

ALTER TABLE public.integrations
  ADD CONSTRAINT integrations_auth_type_check
  CHECK (auth_type IN ('api_key', 'bearer', 'basic', 'none', 'jwt_es256'));
