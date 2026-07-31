CREATE TABLE IF NOT EXISTS public.ama_prompt_versions (
  version text PRIMARY KEY,
  instructions text NOT NULL,
  tool_declarations jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ama_prompt_versions_tool_declarations_array
    CHECK (jsonb_typeof(tool_declarations) = 'array')
);

CREATE TABLE IF NOT EXISTS public.ama_traces (
  id uuid PRIMARY KEY,
  conversation_id text NOT NULL,
  turn integer NOT NULL,
  request_trigger text NOT NULL,
  deployment_environment text NOT NULL,
  system_prompt_version text NOT NULL,
  model text NOT NULL,
  response_model text NOT NULL,
  provider text,
  input_messages jsonb NOT NULL,
  response_messages jsonb NOT NULL,
  total_usage jsonb NOT NULL,
  finish_reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ama_traces_turn_positive CHECK (turn > 0),
  CONSTRAINT ama_traces_request_trigger_valid
    CHECK (request_trigger IN ('submit-message', 'regenerate-message')),
  CONSTRAINT ama_traces_input_messages_array
    CHECK (jsonb_typeof(input_messages) = 'array'),
  CONSTRAINT ama_traces_response_messages_array
    CHECK (jsonb_typeof(response_messages) = 'array'),
  CONSTRAINT ama_traces_total_usage_object
    CHECK (jsonb_typeof(total_usage) = 'object'),
  CONSTRAINT ama_traces_system_prompt_version_fkey
    FOREIGN KEY (system_prompt_version)
    REFERENCES public.ama_prompt_versions(version)
);

CREATE INDEX IF NOT EXISTS ama_traces_created_at_idx
  ON public.ama_traces (created_at DESC);

CREATE INDEX IF NOT EXISTS ama_traces_conversation_turn_idx
  ON public.ama_traces (conversation_id, turn);

CREATE INDEX IF NOT EXISTS ama_traces_prompt_model_idx
  ON public.ama_traces (system_prompt_version, model);

REVOKE ALL ON TABLE public.ama_prompt_versions FROM PUBLIC;
REVOKE ALL ON TABLE public.ama_traces FROM PUBLIC;
