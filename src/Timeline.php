<?php

// Records what the CPU does over time and derives per-process metrics.
// Context switch rule (all algorithms): overhead is charged, and counted, whenever the CPU
// dispatches a different process than the one that ran last. The first dispatch is free.
class Timeline
{
    public int|float $time = 0;
    public array $segments = [];
    public array $rem = [];
    public array $first = [];
    public array $finish = [];
    public array $switches = [];
    public array $decisions = [];
    public bool $decisionsTruncated = false;
    private const MAX_DECISIONS = 1000; // each entry holds the whole ready set, so the log is capped
    private ?string $last = null;
    private array $procs;
    private int|float $overhead;

    public function __construct(array $procs, int|float $overhead)
    {
        $this->procs = $procs;
        $this->overhead = $overhead;
        foreach ($procs as $p) {
            $this->rem[$p['pid']] = $p['burst'];
            $this->switches[$p['pid']] = 0;
        }
    }

    public function idleUntil(int|float $t): void
    {
        if ($t > $this->time) {
            $this->add('IDLE', $t, '');
        }
    }

    // $extra: additional dispatch cost (cache miss, paging) shown together with the switch overhead.
    public function switchTo(string $pid, string $vm, int|float $extra = 0): void
    {
        $cost = $extra;
        if ($this->last !== null && $this->last !== $pid) {
            $this->switches[$pid]++;
            $cost += $this->overhead;
        }
        if ($cost > 0) {
            $this->add('CS', $this->time + $cost, $vm);
        }
        $this->last = $pid;
    }

    // Why $pid was picked now. $ready: pid => comparison value (burst, remaining, priority, arrival or queue level).
    public function decide(string $reason, string $pid, array $ready): void
    {
        if (count($this->decisions) >= self::MAX_DECISIONS) {
            $this->decisionsTruncated = true;
            return;
        }
        $list = [];
        foreach ($ready as $k => $v) {
            $list[] = ['pid' => (string)$k, 'value' => $v];
        }
        $this->decisions[] = ['time' => $this->time, 'pid' => $pid, 'reason' => $reason, 'ready' => $list];
    }

    public function run(string $pid, int|float $len, string $vm): void
    {
        $this->first[$pid] ??= $this->time;
        $this->add($pid, $this->time + $len, $vm);
        $this->rem[$pid] -= $len;
        if ($this->rem[$pid] <= 0) {
            $this->finish[$pid] = $this->time;
        }
    }

    public function penalty(string $label, int|float $len, string $vm): void
    {
        if ($len > 0) {
            $this->add($label, $this->time + $len, $vm);
        }
    }

    private function add(string $pid, int|float $end, string $vm): void
    {
        $n = count($this->segments);
        if ($n && $this->segments[$n - 1]['pid'] === $pid && $this->segments[$n - 1]['vm'] === $vm
            && $this->segments[$n - 1]['end'] == $this->time) {
            $this->segments[$n - 1]['end'] = $end;
        } else {
            $this->segments[] = ['pid' => $pid, 'start' => $this->time, 'end' => $end, 'vm' => $vm];
        }
        $this->time = $end;
    }

    public function results(): array
    {
        $results = [];
        foreach ($this->procs as $p) {
            $pid = $p['pid'];
            $turnaround = $this->finish[$pid] - $p['arrival'];
            $results[] = [
                'pid' => $pid,
                'vm' => $p['vm'],
                'arrival' => $p['arrival'],
                'burst' => $p['burst'],
                'completion' => $this->finish[$pid],
                'turnaround' => $turnaround,
                'waiting' => $turnaround - $p['burst'],
                'response' => $this->first[$pid] - $p['arrival'],
                'contextSwitches' => $this->switches[$pid],
            ];
        }
        return [
            'results' => $results,
            'segments' => $this->segments,
            'decisions' => $this->decisions,
            'decisionsTruncated' => $this->decisionsTruncated,
            'contextSwitches' => array_sum($this->switches),
        ];
    }
}
