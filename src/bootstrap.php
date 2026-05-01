<?php
// Request plumbing shared by both endpoints: constants, headers, CORS, method gate, rate limiting and
// JSON helpers. Loads the validation helpers and the Timeline engine.

ini_set('display_errors', '0');
error_reporting(E_ALL);

const MAX_BODY_BYTES = 65536;
const MAX_PROCESSES = 100;
const MAX_VMS = 20;
const MAX_ARRIVAL = 10000;
const MAX_BURST = 1000;
const MAX_TOTAL_BURST = 20000; // keeps the schedule (and the response) within PHP's memory limit
const MAX_QUANTUM = 1000;
const NAME_PATTERN = '/^[A-Za-z0-9_.\- ]{1,32}$/';

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: no-referrer');
header("Content-Security-Policy: default-src 'none'; frame-ancestors 'none'"); // JSON is never rendered
header('Cache-Control: no-store');

// Same-origin by default. Set ALLOWED_ORIGIN to allow one cross-origin frontend.
$allowedOrigin = getenv('ALLOWED_ORIGIN');
if ($allowedOrigin && ($_SERVER['HTTP_ORIGIN'] ?? '') === $allowedOrigin) {
    header("Access-Control-Allow-Origin: $allowedOrigin");
    header('Vary: Origin');
    header('Access-Control-Allow-Methods: POST, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type');
}

$method = PHP_SAPI === 'cli' ? 'POST' : ($_SERVER['REQUEST_METHOD'] ?? 'GET'); // CLI: used by tests/check.php
if ($method === 'OPTIONS') {
    http_response_code(204);
    exit;
}
if ($method !== 'POST') {
    header('Allow: POST, OPTIONS');
    fail(405, 'Method not allowed');
}
if (PHP_SAPI !== 'cli') {
    enforce_rate_limit();
}

// Fixed-window limiter, one small file per client in the system temp directory.
// Returns 0 when the request is allowed, otherwise the seconds until the window resets.
// Fails open if the directory isn't writable, so a broken temp dir never takes the API down.
function rate_limit_allow(string $dir, string $key, int $limit, int $window = 60, ?int $now = null): int
{
    $now ??= time();
    $file = rtrim($dir, '/\\') . '/cpusim-rl-' . hash('sha256', $key);
    $fh = @fopen($file, 'c+');
    if ($fh === false) {
        return 0;
    }
    flock($fh, LOCK_EX);
    $parts = explode(' ', trim((string)stream_get_contents($fh)));
    $start = (int)($parts[0] ?? 0);
    $count = (int)($parts[1] ?? 0);
    if ($now - $start >= $window) {
        $start = $now;
        $count = 0;
    }
    $count++;
    ftruncate($fh, 0);
    rewind($fh);
    fwrite($fh, "$start $count");
    flock($fh, LOCK_UN);
    fclose($fh);

    if (random_int(1, 100) === 1) { // occasional sweep of stale counters
        foreach (glob(rtrim($dir, '/\\') . '/cpusim-rl-*') ?: [] as $old) {
            if (@filemtime($old) < time() - 2 * $window) {
                @unlink($old);
            }
        }
    }
    return $count > $limit ? max(1, $start + $window - $now) : 0;
}

// RATE_LIMIT_PER_MIN: requests per client per minute (default 300, 0 turns it off).
// RATE_LIMIT_IP_HEADER: name of a $_SERVER key such as HTTP_X_FORWARDED_FOR, for use behind a trusted
// reverse proxy only. Never set it when clients can reach PHP directly: they could forge it.
function enforce_rate_limit(): void
{
    $limit = getenv('RATE_LIMIT_PER_MIN');
    $limit = $limit === false || $limit === '' ? 300 : max(0, (int)$limit);
    if ($limit === 0) {
        return;
    }
    $ip = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
    $header = getenv('RATE_LIMIT_IP_HEADER');
    if ($header && !empty($_SERVER[$header])) {
        $first = trim(explode(',', (string)$_SERVER[$header])[0]);
        if (filter_var($first, FILTER_VALIDATE_IP)) {
            $ip = $first;
        }
    }
    $retry = rate_limit_allow(sys_get_temp_dir(), $ip, $limit);
    if ($retry > 0) {
        header("Retry-After: $retry");
        fail(429, "Too many requests. Try again in {$retry}s.");
    }
}

function fail(int $status, string $message): never
{
    http_response_code($status);
    echo json_encode(['error' => $message]);
    exit;
}

function respond(mixed $data): never
{
    echo json_encode($data);
    exit;
}

function read_input(): array
{
    $source = PHP_SAPI === 'cli' ? 'php://stdin' : 'php://input';
    if (PHP_SAPI !== 'cli' && stripos($_SERVER['CONTENT_TYPE'] ?? '', 'application/json') !== 0) {
        fail(415, 'Content-Type must be application/json');
    }
    $raw = file_get_contents($source, false, null, 0, MAX_BODY_BYTES + 1);
    if ($raw === false || strlen($raw) > MAX_BODY_BYTES) {
        fail(413, 'Request body too large');
    }
    $input = json_decode($raw, true);
    if (!is_array($input)) {
        fail(400, 'Invalid JSON input');
    }
    return $input;
}

require __DIR__ . '/validation.php';
require __DIR__ . '/Timeline.php';
