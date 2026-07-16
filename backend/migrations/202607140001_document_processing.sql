-- Durable document-processing jobs and isolated worker protocol state.
--
-- Processing owns these tables. Worker processes access them only through the
-- authenticated HTTP protocol and never receive database credentials.

CREATE TABLE public.processing_blobs (
    id uuid PRIMARY KEY,
    sha256 bytea NOT NULL,
    size_bytes bigint NOT NULL,
    media_type text NOT NULL,
    content bytea NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT processing_blobs_sha256_length CHECK (octet_length(sha256) = 32),
    CONSTRAINT processing_blobs_size_nonnegative CHECK (size_bytes >= 0),
    CONSTRAINT processing_blobs_size_matches_content CHECK (size_bytes = octet_length(content)),
    CONSTRAINT processing_blobs_digest_size_unique UNIQUE (sha256, size_bytes)
);

CREATE TABLE public.processing_jobs (
    id uuid PRIMARY KEY,
    operation text NOT NULL,
    requester_user_id uuid NOT NULL,
    project_id uuid,
    idempotency_scope text NOT NULL,
    idempotency_key text NOT NULL,
    command_digest bytea NOT NULL,
    input_schema text,
    input_blob_id uuid,
    input_digest bytea,
    normalized_options jsonb NOT NULL,
    options_digest bytea NOT NULL,
    state text NOT NULL,
    phase text NOT NULL,
    cancellation_requested boolean DEFAULT false NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    max_attempts integer NOT NULL,
    current_claim_id uuid,
    claim_expires_at timestamp with time zone,
    processor_contract text,
    cache_hit boolean DEFAULT false NOT NULL,
    cache_source_job_id uuid,
    finalization_token uuid,
    finalization_expires_at timestamp with time zone,
    failure_class text,
    failure_code text,
    failure_message text,
    result_project_id uuid,
    retry_of_job_id uuid,
    source_workspace_version bigint,
    source_content_epoch bigint,
    source_epoch bigint,
    next_attempt_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    queued_at timestamp with time zone,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    queue_expires_at timestamp with time zone NOT NULL,
    retained_until timestamp with time zone NOT NULL,
    CONSTRAINT processing_jobs_operation_check CHECK (
        operation = ANY (ARRAY[
            'latex.compile.pdf/v1'::text,
            'typst.export.pptx/v1'::text,
            'pptx.import.typst/v1'::text
        ])
    ),
    CONSTRAINT processing_jobs_state_check CHECK (
        state = ANY (ARRAY[
            'preparing'::text,
            'queued'::text,
            'running'::text,
            'finalizing'::text,
            'succeeded'::text,
            'failed'::text,
            'cancelled'::text,
            'expired'::text
        ])
    ),
    CONSTRAINT processing_jobs_phase_check CHECK (
        phase = ANY (ARRAY[
            'capturing_input'::text,
            'waiting_for_worker'::text,
            'processing'::text,
            'uploading_result'::text,
            'validating_result'::text,
            'publishing_result'::text,
            'complete'::text
        ])
    ),
    CONSTRAINT processing_jobs_command_digest_length CHECK (octet_length(command_digest) = 32),
    CONSTRAINT processing_jobs_input_digest_length CHECK (
        input_digest IS NULL OR octet_length(input_digest) = 32
    ),
    CONSTRAINT processing_jobs_options_digest_length CHECK (octet_length(options_digest) = 32),
    CONSTRAINT processing_jobs_attempt_count_nonnegative CHECK (attempt_count >= 0),
    CONSTRAINT processing_jobs_max_attempts_positive CHECK (max_attempts > 0),
    CONSTRAINT processing_jobs_idempotency_unique UNIQUE (
        requester_user_id,
        idempotency_scope,
        idempotency_key
    ),
    FOREIGN KEY (requester_user_id) REFERENCES public.users(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES public.projects(id) ON DELETE CASCADE,
    FOREIGN KEY (input_blob_id) REFERENCES public.processing_blobs(id),
    FOREIGN KEY (result_project_id) REFERENCES public.projects(id) ON DELETE SET NULL,
    FOREIGN KEY (retry_of_job_id) REFERENCES public.processing_jobs(id) ON DELETE SET NULL,
    FOREIGN KEY (cache_source_job_id) REFERENCES public.processing_jobs(id) ON DELETE SET NULL
);

CREATE TABLE public.processing_worker_sessions (
    id uuid PRIMARY KEY,
    worker_identity text NOT NULL,
    worker_instance text NOT NULL,
    protocol_version integer NOT NULL,
    state text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    last_heartbeat_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT processing_worker_sessions_protocol_positive CHECK (protocol_version > 0),
    CONSTRAINT processing_worker_sessions_state_check CHECK (
        state = ANY (ARRAY['active'::text, 'draining'::text, 'expired'::text])
    )
);

CREATE TABLE public.processing_input_asset_pins (
    job_id uuid NOT NULL,
    object_key text NOT NULL,
    created_at timestamp with time zone NOT NULL,
    PRIMARY KEY (job_id, object_key),
    FOREIGN KEY (job_id) REFERENCES public.processing_jobs(id) ON DELETE CASCADE
);

CREATE TABLE public.processing_worker_processors (
    session_id uuid NOT NULL,
    operation text NOT NULL,
    processor_contract text NOT NULL,
    runtime_version text NOT NULL,
    slots integer NOT NULL,
    healthy boolean DEFAULT true NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    PRIMARY KEY (session_id, operation, processor_contract),
    CONSTRAINT processing_worker_processors_slots_positive CHECK (slots > 0),
    FOREIGN KEY (session_id) REFERENCES public.processing_worker_sessions(id) ON DELETE CASCADE
);

CREATE TABLE public.processing_attempts (
    id uuid PRIMARY KEY,
    job_id uuid NOT NULL,
    attempt_number integer NOT NULL,
    claim_id uuid NOT NULL,
    worker_session_id uuid NOT NULL,
    processor_contract text NOT NULL,
    state text NOT NULL,
    phase text NOT NULL,
    lease_expires_at timestamp with time zone NOT NULL,
    limits jsonb NOT NULL,
    failure_class text,
    failure_code text,
    failure_message text,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT processing_attempts_number_positive CHECK (attempt_number > 0),
    CONSTRAINT processing_attempts_state_check CHECK (
        state = ANY (ARRAY[
            'running'::text,
            'delivered'::text,
            'failed'::text,
            'released'::text,
            'lost'::text,
            'cancelled'::text
        ])
    ),
    CONSTRAINT processing_attempts_phase_check CHECK (
        phase = ANY (ARRAY[
            'processing'::text,
            'uploading_result'::text,
            'complete'::text
        ])
    ),
    CONSTRAINT processing_attempts_job_number_unique UNIQUE (job_id, attempt_number),
    CONSTRAINT processing_attempts_claim_unique UNIQUE (claim_id),
    FOREIGN KEY (job_id) REFERENCES public.processing_jobs(id) ON DELETE CASCADE,
    FOREIGN KEY (worker_session_id) REFERENCES public.processing_worker_sessions(id)
);

CREATE TABLE public.processing_transfers (
    id uuid PRIMARY KEY,
    token_fingerprint bytea NOT NULL,
    job_id uuid NOT NULL,
    attempt_id uuid NOT NULL,
    claim_id uuid NOT NULL,
    direction text NOT NULL,
    role text NOT NULL,
    media_type text NOT NULL,
    filename text,
    exact_size_bytes bigint,
    max_size_bytes bigint NOT NULL,
    expected_sha256 bytea,
    blob_id uuid,
    state text NOT NULL,
    remaining_uses integer NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    CONSTRAINT processing_transfers_token_length CHECK (octet_length(token_fingerprint) = 32),
    CONSTRAINT processing_transfers_direction_check CHECK (
        direction = ANY (ARRAY['download'::text, 'upload'::text])
    ),
    CONSTRAINT processing_transfers_state_check CHECK (
        state = ANY (ARRAY['issued'::text, 'uploaded'::text, 'consumed'::text, 'expired'::text])
    ),
    CONSTRAINT processing_transfers_exact_size_nonnegative CHECK (
        exact_size_bytes IS NULL OR exact_size_bytes >= 0
    ),
    CONSTRAINT processing_transfers_max_size_positive CHECK (max_size_bytes > 0),
    CONSTRAINT processing_transfers_expected_digest_length CHECK (
        expected_sha256 IS NULL OR octet_length(expected_sha256) = 32
    ),
    CONSTRAINT processing_transfers_remaining_uses_nonnegative CHECK (remaining_uses >= 0),
    FOREIGN KEY (job_id) REFERENCES public.processing_jobs(id) ON DELETE CASCADE,
    FOREIGN KEY (attempt_id) REFERENCES public.processing_attempts(id) ON DELETE CASCADE,
    FOREIGN KEY (blob_id) REFERENCES public.processing_blobs(id)
);

CREATE TABLE public.processing_artifacts (
    id uuid PRIMARY KEY,
    job_id uuid NOT NULL,
    blob_id uuid NOT NULL,
    role text NOT NULL,
    media_type text NOT NULL,
    filename text NOT NULL,
    size_bytes bigint NOT NULL,
    sha256 bytea NOT NULL,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT processing_artifacts_size_nonnegative CHECK (size_bytes >= 0),
    CONSTRAINT processing_artifacts_sha256_length CHECK (octet_length(sha256) = 32),
    CONSTRAINT processing_artifacts_job_role_unique UNIQUE (job_id, role),
    FOREIGN KEY (job_id) REFERENCES public.processing_jobs(id) ON DELETE CASCADE,
    FOREIGN KEY (blob_id) REFERENCES public.processing_blobs(id)
);

CREATE TABLE public.processing_worker_requests (
    worker_identity text NOT NULL,
    request_id uuid NOT NULL,
    route_key text NOT NULL,
    payload_digest bytea NOT NULL,
    response_status integer NOT NULL,
    response_body jsonb,
    created_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    PRIMARY KEY (worker_identity, request_id),
    CONSTRAINT processing_worker_requests_payload_digest_length CHECK (
        octet_length(payload_digest) = 32
    ),
    CONSTRAINT processing_worker_requests_status_range CHECK (
        response_status >= 100 AND response_status <= 599
    )
);

CREATE INDEX processing_jobs_queue_idx
    ON public.processing_jobs (operation, next_attempt_at, created_at)
    WHERE state = 'queued';
CREATE INDEX processing_jobs_requester_updated_idx
    ON public.processing_jobs (requester_user_id, updated_at DESC);
CREATE INDEX processing_jobs_project_updated_idx
    ON public.processing_jobs (project_id, updated_at DESC)
    WHERE project_id IS NOT NULL;
CREATE INDEX processing_jobs_claim_expiry_idx
    ON public.processing_jobs (claim_expires_at)
    WHERE state = 'running';
CREATE INDEX processing_jobs_finalization_expiry_idx
    ON public.processing_jobs (finalization_expires_at)
    WHERE state = 'finalizing';
CREATE INDEX processing_jobs_cache_idx
    ON public.processing_jobs (
        project_id,
        operation,
        input_digest,
        processor_contract,
        options_digest,
        completed_at DESC
    )
    WHERE state = 'succeeded';
CREATE INDEX processing_worker_sessions_expiry_idx
    ON public.processing_worker_sessions (expires_at)
    WHERE state = 'active';
CREATE INDEX processing_attempts_active_session_idx
    ON public.processing_attempts (worker_session_id, lease_expires_at)
    WHERE state = 'running';
CREATE INDEX processing_transfers_expiry_idx
    ON public.processing_transfers (expires_at)
    WHERE state IN ('issued', 'uploaded');
CREATE INDEX processing_worker_requests_expiry_idx
    ON public.processing_worker_requests (expires_at);
