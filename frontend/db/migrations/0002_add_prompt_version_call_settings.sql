ALTER TABLE public.ama_prompt_versions
  ADD COLUMN IF NOT EXISTS call_settings jsonb NOT NULL DEFAULT '{}'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ama_prompt_versions_call_settings_object'
      AND conrelid = 'public.ama_prompt_versions'::regclass
  ) THEN
    ALTER TABLE public.ama_prompt_versions
      ADD CONSTRAINT ama_prompt_versions_call_settings_object
      CHECK (jsonb_typeof(call_settings) = 'object');
  END IF;
END $$;
