# CPU Scheduling Simulator

Compare CPU scheduling algorithms on one workload. Pick several algorithms, run once, and read them side by side on a shared clock. An optional hypervisor mode adds a VM scheduler on top.

Built with plain HTML, CSS and vanilla JavaScript, plus two PHP endpoints. There is no build step.

## Features

- **Six algorithms:** FCFS, SJF, SRTF, Priority (lower number = higher priority), Round Robin, and MLFQ (three levels, quantum q, 2q, 4q).
- **Timetable chart:** one track per algorithm on a shared time axis, with arrival and departure markers, idle time, and context-switch overhead.
  - Drag the red clock hand, or use the arrow keys (Shift moves by 10), to see what every algorithm is running at that moment.
  - Hover a process to follow it across all tracks.
- **Comparison table:** average turnaround, waiting and response time, throughput, CPU busy %, and context switches, with the best value per column marked. Select a row for its per-process results.
- **Live re-run:** change the algorithm set, quantum, or overhead and every track updates.
- **Hypervisor mode:** define VMs and assign processes to them.
  - VM schedulers: round robin, priority, proportional share, credit, lottery (seeded, so reproducible).
  - Optional live migration, memory overcommit, I/O blocking, and a CPU cache model; each changes the timeline.
- **Presets** for processes and VMs, and an optional "add a random process every 5 s" generator.

## Run it

Requires PHP 8.1 or newer.

```bash
php -S localhost:8000
```

Then open <http://localhost:8000>. The page must be served by PHP, because it posts to `simulate.php` and `simulate_hypervisor.php`; opening `index.html` as a file won't work.

GSAP and Lenis (animation and smooth scrolling) and the Barlow font load from public CDNs. The simulator still works if they're blocked, just without the animation.

## How scheduling is modelled

- **Context switch:** the overhead (0 to 5 in steps of 0.5) is charged, and counted, whenever the CPU dispatches a different process than the one that ran last. The first dispatch is free.
- **Timing metrics:** turnaround = completion − arrival; waiting = turnaround − burst; response = first run − arrival.
- **Ties:** among equal candidates, the process that arrived first runs first.
- **Round Robin / MLFQ:** new arrivals join the queue before a preempted process is re-queued. MLFQ demotes a process after it uses a full quantum.
- **Hypervisor I/O:** a process with I/O time blocks once, halfway through its burst; one device serves requests in order.

## Input limits

The server validates every request and returns a 4xx with a message if a limit is broken.

| Field | Limit |
| --- | --- |
| Processes / VMs | up to 100 / 20 |
| Process ID, VM name | 1–32 characters: letters, digits, space, `_ . -` (`Host` is reserved) |
| Arrival | 0–10000 |
| Burst | 1–1000 |
| Quantum, VM time slice | 1–1000 |
| Request body | 64 KB |

## Configuration

- `ALLOWED_ORIGIN`: set this environment variable to a single origin (for example `https://example.com`) to allow cross-origin POSTs. By default the API is same-origin only.
- For production, also set `display_errors=0` (the endpoints already do this at runtime) and keep the folder out of a web-writable location.

## Tests

```bash
php tests/check.php
```

Runs both endpoints from the command line against hand-computed schedules and checks that bad input is rejected. It prints one line per check and exits non-zero if any fail.

## Project layout

| Path | Purpose |
| --- | --- |
| `index.html`, `styles.css`, `script.js` | The single-page UI |
| `simulate.php` | Standard scheduling endpoint |
| `simulate_hypervisor.php` | Hypervisor scheduling endpoint |
| `common.php` | Shared validation, headers, and the timeline/metrics engine |
| `tests/check.php` | Backend self-check |
| `PRODUCT.md`, `DESIGN.md`, `.impeccable/design.json` | Product and design-system notes |

## License

See [LICENSE](LICENSE).
