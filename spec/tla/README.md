# RouteStore models

These finite TLA+ models describe the route lock and port reservation in `packages/portless/src/routes.ts`. `RouteStoreOld.tla` models the design before `register()`, where a process probed a free port, took the lock later, and saved the route without checking the table again. `RouteStore.tla` models the current design, where the port is probed before the lock is taken and reserved inside the critical section. The old model uses two processes and two ports. The current model uses the same bounds for reservation checks and three processes for the reclaim race. TLC explores the reachable state space of each configuration, not all possible deployments.

## Models and limits

`RouteStoreOld.tla` separates an OS-free port probe, a later route save, and the app's later bind. The save does not check the route table for the candidate port. Lock acquisition can reclaim an old lock even if its holder is alive. The model uses a single hostname per process.

`RouteStore.tla` probes before acquiring the lock and checks the route table inside the critical section. A live route or pid 0 alias reserves its port; a rejected candidate can be probed again after release. Aliases can share ports with each other and with existing dynamic routes. `UniqueLivePorts` checks only routes belonging to different live dynamic owners. `Crash` removes a process from the critical section and frees its bound port, but leaves its route and lock behind. The model also includes bind, remove, alias, lock aging, and release. Lock creation and owner file writing are separate actions, so a crash can leave an ownerless lock.

`RouteStore.cfg` treats eligibility checking and removal as one atomic reclaim action. An old lock is eligible if its owner is dead or its owner file is missing. `NoWedge` checks that this abstract action is enabled in every eligible state. It assumes an external reclaimer is available, and it does not prove eventual recovery, fairness, or behavior under timeouts or filesystem errors. `WriteOwner` also assumes a process can write only to the lock directory it created. The implementation does not verify that identity. An ownerless directory can age and be reclaimed while its creator is still alive; the model does not explore that creator writing into a replacement directory.

`RouteStore-Reclaim.cfg` instead separates reading an old dead owner from removing the lock. It restricts the race to the dead owner case and omits route operations to focus on locking. Two waiters can read the same dead owner; one removes and recreates the lock, then the other removes the new lock. The resulting `LockExclusion` violation is a residual race in the current implementation. It is documented here, not fixed. The passing atomic reclaim configuration does not cover it.

`NoPidReuse` checks that an identity marked dead never returns to `alive`. This is a model assumption, not a check of operating system PID reuse. Both models assume a crash frees the associated bound port; a real dev server can outlive its portless process. Neither model includes foreign processes binding after a probe, address family differences, explicit user selected ports, force replacement, multiple dynamic hostnames per process, real elapsed time, lock timeouts, or filesystem failures. Bind only succeeds if the modeled port is free. The models do not prove application startup succeeds or that a failed probe to bind race is impossible.

## Run TLC

`check.sh` downloads TLC v1.7.4, verifies the jar checksum, and runs all four configurations:

```sh
bash spec/tla/check.sh
```

Set `TLA_JAR` to a jar on disk to skip the download. The checksum is verified either way. Java 11 or newer is required. The `tla` job in `.github/workflows/ci.yml` runs the same script.

GitHub publishes no independent digest for the jar, so the expected SHA-256 in `check.sh` was computed from the v1.7.4 release asset and is recorded here. A hash fetched from the same endpoint as the jar is not independent authentication; review the release source before treating it as one.

The script fails unless every configuration gives its expected result, so a green run proves both that the current design has no counterexample and that the checker still finds each known bug.

## Results

These results were observed in the sandbox with the v1.7.4 jar, which reports `TLC2 Version 2.19 of 08 August 2024`, revision `5a47802`. Trace lengths count states, including the initial state. Exit code 12 means TLC stopped on an invariant violation. Counterexample searches stop at the first violation, so their state counts are not complete state spaces.

| Configuration            | Result                                                                                              | Exit code |
| ------------------------ | --------------------------------------------------------------------------------------------------- | --------- |
| `RouteStoreOld.cfg`      | `UniqueLivePorts` violated; 8-state trace                                                           | 12        |
| `RouteStoreOld-Lock.cfg` | `LockExclusion` violated; 4-state trace                                                             | 12        |
| `RouteStore.cfg`         | No error for `UniqueLivePorts`, `LockExclusion`, `NoWedge`, or `NoPidReuse`; 67,752 distinct states | 0         |
| `RouteStore-Reclaim.cfg` | `LockExclusion` violated; 13-state trace. The known two reclaimer race in the lock                  | 12        |
