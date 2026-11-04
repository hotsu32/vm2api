# Orphaned native-kernel recovery

This control-plane fix addresses a live kernel reporting `healthy=true`,
unchanged native occupancy, but no gateway-owned requests. The kernel can
have zero ready slots or still advertise spare slots while its CLI is blocked.
It does not change account priority, affinity, quota or per-account concurrency.
The native kernel is a pinned binary: its initial slot-release defect is not
claimed fixed by this JavaScript change.

## Cancellation

Both inference clients send one bounded (3-second) cancellation for a failed
transport, gateway timeout or caller abort. A truncated stream without an
explicit upstream error is cancelled too. Successful completions are not.
Concurrent abort/error paths share a single cancellation attempt. HTTP status
and acceptance are logged without request IDs, prompts or credentials. A 2xx
acknowledgement is acceptance, not proof of completed native cleanup; a 404 or
negative acknowledgement is visible and never masks the original error.
If the Rust cancellation endpoint itself cannot be reached, new dispatch is
quarantined immediately and the request does not retry into that kernel.
Owned sibling jobs are not killed; the watchdog still waits for its full idle
observation window before restarting. A reachable legacy 404 alone does not
establish a stall. Healthy native idle clears this precautionary quarantine.

## Watchdog

`routing.kernel_watchdog.orphan_stall_sec` defaults to **900 seconds** (minimum
60). At least three consecutive samples must show all of:

- kernel reachable, healthy, not recovering, live CLI, known ready-slot count;
- known native pending/running/payload counters with nonzero occupancy;
- unchanged CLI identity and those occupancy counters;
- zero pool reservations and zero tracked inference hops for this VM.

Ownership that is unknown, gaps longer than 2.5 watchdog intervals, changed
counters or owned requests reset the observation window. Long *owned* jobs are
not timed out by this mechanism. Counter stability alone is not a native
progress signal; installations allowing direct, untracked kernel callers must
include those callers in `getInflight` before enabling orphan recovery. On
process restart the full observation window starts again.

The watchdog quarantines a confirmed orphan before the first recovery backoff.
Scheduler selection, atomic reservation and hop dispatch all reject quarantine;
existing affinity bindings and account credentials are not deleted. It checks
ownership again after runtime observation and uses a real per-slot restart,
not `ensure()` (which deliberately leaves healthy busy kernels alone). Existing
restart spacing/window/budget applies; exhaustion faults the VM instead of
creating an unbounded restart loop. KVM recovery restarts the guest kernel
service, not the runner or unrelated VMs. A fresh healthy/ready observation
with zero native pending/running clears quarantine; spare slots alone do not
clear the spent orphan-fault budget.

The diagnostic watchdog check exposes `kernel_stalled` while quarantined.
New orphan observations and cancel outcomes are available in control logs.

## Deployment and acceptance

Keep the official base image digest and record the Git revision plus changed
file hashes in the derived image. Preserve the previous image and Compose
configuration. Do not include credentials, VM disks, runtime configuration or
database files in build context or Git.

Drain incoming inference at the existing ingress, wait for all pool leases to
finish, then replace only the official control container. Do not mix other
unreleased feature branches into this repair. Initially recover the known
stalled VM with admission disabled and zero gateway leases. Real small SDK
requests must demonstrate both slots completing and returning to idle,
including two overlapping requests on the repaired slot. Verify later requests
still work and inspect usage terminal states, not only HTTP 200.

Rollback switches the official control container to its recorded previous
image/Compose files. Account OAuth, pool membership, Key secret and public Base
URL remain unchanged. A kernel restart may lose warm in-process state; cache
preservation is not guaranteed. In-flight stream continuity is not promised
during a control-container replacement, hence the ingress drain.
