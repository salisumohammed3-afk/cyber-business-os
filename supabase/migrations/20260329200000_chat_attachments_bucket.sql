-- Chat attachments storage bucket
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'chat-attachments',
  'chat-attachments',
  true,
  52428800, -- 50 MB
  ARRAY[
    'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
    'application/pdf',
    'text/plain', 'text/csv', 'text/markdown',
    'application/json',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/zip'
  ]
) ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Public read chat-attachments" ON storage.objects
  FOR SELECT USING (bucket_id = 'chat-attachments');

CREATE POLICY "Allow upload chat-attachments" ON storage.objects
  FOR INSERT WITH CHECK (bucket_id = 'chat-attachments');

CREATE POLICY "Allow delete chat-attachments" ON storage.objects
  FOR DELETE USING (bucket_id = 'chat-attachments');
