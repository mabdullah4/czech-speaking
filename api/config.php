<?php
declare(strict_types=1);

header('X-Content-Type-Options: nosniff');

$configFile = dirname(__DIR__) . '/config.local.php';
if (is_readable($configFile)) {
    /** @var array{google_api_key?:string,google_api_keys?:list<string>,tts_model?:string,listen_model?:string,voice?:string} $local */
    $local = require $configFile;
} else {
    $local = [];
}

$GOOGLE_API_KEYS = [];
if (!empty($local['google_api_keys']) && is_array($local['google_api_keys'])) {
    foreach ($local['google_api_keys'] as $k) {
        $k = trim((string) $k);
        if ($k !== '') {
            $GOOGLE_API_KEYS[] = $k;
        }
    }
}
$primary = trim((string) (
    $local['google_api_key']
    ?? getenv('GOOGLE_API_KEY')
    ?: getenv('GEMINI_API_KEY')
    ?: ''
));
if ($primary !== '' && !in_array($primary, $GOOGLE_API_KEYS, true)) {
    array_unshift($GOOGLE_API_KEYS, $primary);
}
$envExtra = getenv('GEMINI_API_KEYS') ?: getenv('GOOGLE_API_KEYS') ?: '';
if (is_string($envExtra) && $envExtra !== '') {
    foreach (explode(',', $envExtra) as $k) {
        $k = trim($k);
        if ($k !== '' && !in_array($k, $GOOGLE_API_KEYS, true)) {
            $GOOGLE_API_KEYS[] = $k;
        }
    }
}

/** @deprecated use $GOOGLE_API_KEYS — kept for older endpoints */
$GOOGLE_API_KEY = $GOOGLE_API_KEYS[0] ?? '';

// Match czech-learning defaults (Interactions API)
$TTS_MODEL = $local['tts_model'] ?? 'gemini-3.8-flash-lite-tts';
$LISTEN_MODEL = $local['listen_model'] ?? 'gemini-3.5-flash-lite';
$VOICE_NAME = $local['voice'] ?? 'Kore';
$STT_URL = trim((string) ($local['stt_url'] ?? getenv('STT_URL') ?: ''));
$STT_API_KEY = trim((string) ($local['stt_api_key'] ?? getenv('STT_API_KEY') ?: ''));

function json_response(array $payload, int $status = 200): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function require_api_key(string $key = ''): void
{
    global $GOOGLE_API_KEYS;
    if ($key === '' && empty($GOOGLE_API_KEYS)) {
        json_response([
            'error' => 'Missing Google API key. Copy config.local.php.example to config.local.php and add your key.',
        ], 500);
    }
}

function gemini_is_rate_limited(array $result): bool
{
    if (($result['status'] ?? 0) === 429) {
        return true;
    }
    $err = (string) ($result['error'] ?? '');
    return stripos($err, 'rate') !== false || stripos($err, 'quota') !== false;
}

/**
 * POST to Gemini Interactions API (same path as czech-learning).
 *
 * @return array{ok:bool,status:int,error?:string,data?:array}
 */
function gemini_interactions(string $apiKey, array $payload, int $timeout = 90): array
{
    $payload['store'] = false;
    $url = 'https://generativelanguage.googleapis.com/v1beta/interactions';

    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_HTTPHEADER => [
            'Content-Type: application/json',
            'x-goog-api-key: ' . $apiKey,
            'x-goog-api-client: speaking-practice/1.0',
        ],
        CURLOPT_POSTFIELDS => json_encode($payload, JSON_UNESCAPED_UNICODE),
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => $timeout,
    ]);
    $raw = curl_exec($ch);
    $errno = curl_errno($ch);
    $error = curl_error($ch);
    $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($errno) {
        return ['ok' => false, 'status' => 0, 'error' => $error ?: 'cURL error'];
    }

    $decoded = json_decode((string) $raw, true);
    if (!is_array($decoded)) {
        return ['ok' => false, 'status' => $status, 'error' => 'Invalid JSON from Gemini', 'raw' => $raw];
    }

    if ($status >= 400) {
        $message = $decoded['error']['message'] ?? ('Gemini HTTP ' . $status);
        return ['ok' => false, 'status' => $status, 'error' => $message, 'raw' => $decoded];
    }

    return ['ok' => true, 'status' => $status, 'data' => $decoded];
}

function gemini_walk_extract_text(array $json): string
{
    $chunks = [];
    $walk = function ($node) use (&$walk, &$chunks): void {
        if (!is_array($node)) {
            return;
        }
        if (($node['type'] ?? '') === 'text' && isset($node['text']) && is_string($node['text'])) {
            $chunks[] = $node['text'];
        }
        foreach ($node as $value) {
            $walk($value);
        }
    };
    $walk($json);
    return trim(implode("\n", $chunks));
}

/** @return array{data:string,mime:string}|null */
function gemini_walk_extract_audio(array $json): ?array
{
    $found = null;
    $walk = function ($node) use (&$walk, &$found): void {
        if (!is_array($node) || $found !== null) {
            return;
        }
        if (($node['type'] ?? '') === 'audio' && !empty($node['data']) && is_string($node['data'])) {
            $found = [
                'data' => $node['data'],
                'mime' => is_string($node['mime_type'] ?? null) ? $node['mime_type'] : 'audio/wav',
            ];
            return;
        }
        foreach ($node as $value) {
            $walk($value);
        }
    };
    $walk($json);
    return $found;
}

function gemini_extract_json_object(array $json): ?array
{
    $text = gemini_walk_extract_text($json);
    if ($text === '') {
        return null;
    }
    if (preg_match('/```(?:json)?\s*(\{.*\})\s*```/s', $text, $m)) {
        $text = $m[1];
    }
    $decoded = json_decode($text, true);
    return is_array($decoded) ? $decoded : null;
}

function storage_dir(string $subdir): string
{
    $dir = dirname(__DIR__) . '/storage/' . $subdir;
    if (!is_dir($dir)) {
        mkdir($dir, 0755, true);
    }
    return $dir;
}

/**
 * Per-key free-tier TTS ≈ 3 RPM. Returns key index that has a free slot, or -1.
 * @param list<string> $keys
 */
function tts_acquire_key_slot(array $keys, int $maxPerMinute = 3, int $maxWaitSeconds = 8): int
{
    if (!$keys) {
        return -1;
    }
    $file = storage_dir('tts') . '/rate-limit-keys.json';
    $lockPath = storage_dir('tts') . '/rate-limit.lock';
    $lock = fopen($lockPath, 'c+');
    if ($lock === false) {
        return 0;
    }
    if (!flock($lock, LOCK_EX)) {
        fclose($lock);
        return 0;
    }

    $deadline = microtime(true) + $maxWaitSeconds;
    $chosen = -1;
    while (microtime(true) < $deadline) {
        $all = [];
        if (is_readable($file)) {
            $decoded = json_decode((string) file_get_contents($file), true);
            if (is_array($decoded)) {
                $all = $decoded;
            }
        }
        $now = microtime(true);
        foreach ($keys as $i => $key) {
            $id = substr(hash('sha256', $key), 0, 12);
            $times = [];
            if (isset($all[$id]) && is_array($all[$id])) {
                $times = array_values(array_filter(
                    array_map('floatval', $all[$id]),
                    static fn(float $t): bool => $t > $now - 60,
                ));
            }
            if (count($times) < $maxPerMinute) {
                $times[] = $now;
                $all[$id] = $times;
                file_put_contents($file, json_encode($all));
                $chosen = $i;
                break 2;
            }
        }
        // All keys busy — wait for the soonest free slot across keys
        $wake = $now + 5;
        foreach ($keys as $key) {
            $id = substr(hash('sha256', $key), 0, 12);
            $times = isset($all[$id]) && is_array($all[$id]) ? $all[$id] : [];
            $times = array_values(array_filter(
                array_map('floatval', $times),
                static fn(float $t): bool => $t > $now - 60,
            ));
            if ($times) {
                $wake = min($wake, min($times) + 60 + 0.35);
            }
        }
        $sleep = max(0.2, min(3.0, $wake - microtime(true)));
        flock($lock, LOCK_UN);
        usleep((int) ($sleep * 1_000_000));
        flock($lock, LOCK_EX);
    }

    flock($lock, LOCK_UN);
    fclose($lock);
    return $chosen;
}

/**
 * Call Gemini trying each API key; on rate-limit move to the next key.
 *
 * @param list<string> $keys
 * @return array{ok:bool,status:int,error?:string,data?:array,key_index?:int}
 */
function gemini_interactions_failover(array $keys, array $payload, int $timeout = 90): array
{
    if (!$keys) {
        return ['ok' => false, 'status' => 0, 'error' => 'No API keys configured'];
    }
    $last = ['ok' => false, 'status' => 0, 'error' => 'All API keys failed'];
    foreach ($keys as $i => $key) {
        $result = gemini_interactions($key, $payload, $timeout);
        if ($result['ok']) {
            $result['key_index'] = $i;
            return $result;
        }
        $last = $result;
        if (!gemini_is_rate_limited($result)) {
            return $result;
        }
    }
    return $last;
}

/**
 * TTS with per-key 3 RPM slots + key failover.
 *
 * @param list<string> $keys
 * @return array{ok:bool,status:int,error?:string,data?:array,key_index?:int}
 */
function gemini_tts_failover(array $keys, array $payload, int $timeout = 90): array
{
    if (!$keys) {
        return ['ok' => false, 'status' => 0, 'error' => 'No API keys configured'];
    }
    $last = ['ok' => false, 'status' => 0, 'error' => 'All API keys failed'];
    $n = count($keys);
    $start = tts_acquire_key_slot($keys, 3, 10);
    if ($start < 0) {
        $start = 0;
    }
    for ($offset = 0; $offset < $n; $offset += 1) {
        $i = ($start + $offset) % $n;
        if ($offset > 0) {
            // Reserve a slot on the fallback key when possible
            tts_acquire_key_slot([$keys[$i]], 3, 5);
        }
        $result = gemini_interactions($keys[$i], $payload, $timeout);
        if ($result['ok']) {
            $result['key_index'] = $i;
            return $result;
        }
        $last = $result;
        if (!gemini_is_rate_limited($result)) {
            return $result;
        }
    }
    return $last;
}

function pcm_to_wav(string $pcm, int $sampleRate = 24000, int $channels = 1, int $bits = 16): string
{
    $dataSize = strlen($pcm);
    $byteRate = (int) ($sampleRate * $channels * ($bits / 8));
    $blockAlign = (int) ($channels * ($bits / 8));

    return 'RIFF'
        . pack('V', 36 + $dataSize)
        . 'WAVEfmt '
        . pack('V', 16)
        . pack('v', 1)
        . pack('v', $channels)
        . pack('V', $sampleRate)
        . pack('V', $byteRate)
        . pack('v', $blockAlign)
        . pack('v', $bits)
        . 'data'
        . pack('V', $dataSize)
        . $pcm;
}
