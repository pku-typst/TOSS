## Start a background task

Signed-in users can follow durable work from **Tasks** in the application header. In a LaTeX project, use **Build PDF in background** in the preview toolbar to request a native build when the deployment enables it.

Submitting a build captures one immutable snapshot of the project state already accepted by the service, including the entry file, settings, text files, and assets. Wait for pending edits and uploads to synchronize before submitting when they must be included. Later edits continue normally but belong to a future build.

The action reflects deployment capacity:

- **Build PDF in background** submits immediately to the durable queue.
- **Queue background PDF build; worker is temporarily offline** accepts bounded queued work and waits for compatible capacity.
- **Background PDF build is unavailable** means the deployment has not configured a compatible processor for this action.

## Browser preview and native processing

Live Typst and LaTeX preview still compile in your browser. A background build is a separate, explicit operation using an isolated native toolchain; it never becomes the preferred preview compiler or an automatic fallback. Browser preview and local PDF download remain usable when background capacity is unavailable.

Because the browser and native toolchains have independent package, font, and sandbox contracts, their PDFs can differ. The background task records the processor contract used for its result.

## Follow, cancel, and recover

The task center shows active and recent tasks for the signed-in account, with the source project, current phase, failure details, and update time. Closing the drawer, navigating away, or closing the browser does not cancel a task.

You can request cancellation while a task is preparing, queued, or running. Cancellation may take a short time while an active worker stops safely. A task cannot be cancelled after result finalization begins. Temporary worker interruptions may retry automatically; after a terminal compile failure, fix the project and submit a new build.

## Download and retain results

A succeeded task provides its artifacts as download buttons in the task center. Access to the source project is checked again whenever the task is shown or an artifact is downloaded.

Tasks and artifacts follow the deployment's retention policy and are not a permanent publication archive. Download important results promptly and keep the source in your normal backup or Git workflow.

## Data sent to the worker

Unlike live browser preview, a background build sends the captured project snapshot through the service to an authenticated processing worker. The worker receives scoped, expiring input and output access for that task; it does not receive your application session, database credentials, object-storage credentials, or external Git grants.
