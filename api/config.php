<?php
declare(strict_types=1);

header('X-Content-Type-Options: nosniff');

$configFile = dirname(__DIR__) . '/config.local.php';
if (is_readable($configFile)) {
    /** @var array{google_api_key?:string,tts_model?:string,listen_model?:string,voice?:string} $local */
    $local = require $configFile;
} else {
    $local = [];
}

$GOOGLE_API_KEY = $local['google_api_key']
    ?? getenv('GOOGLE_API_KEY')
    ?: getenv('GEMINI_API_KEY')
    ?: '';

// Match czech-learning defaults (Interactions API)
$TTS_MODEL = $local['tts_model'] ?? 'gemini-3.8-flash-lite-tts';
$LISTEN_MODEL = $local['listen_model'] ?? 'gemini-3.5-flash-lite';
$VOICE_NAME = $local['voice'] ?? 'Kore';

function json_response(array $payload, int $status = 200): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function require_api_key(string $key): void
{
    if ($key === '') {
        json_response([
            'error' => 'Missing Google API key. Copy config.local.php.example to config.local.php and add your key.',
        ], 500);
    }
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
 * Free-tier TTS is ~3 RPM. Wait until a slot is free (or give up).
 * Cached responses should call this only before live Gemini calls.
 */
function tts_rate_limit_wait(int $maxPerMinute = 3, int $maxWaitSeconds = 75): bool
{
    $file = storage_dir('tts') . '/rate-limit.json';
    $lockPath = storage_dir('tts') . '/rate-limit.lock';
    $lock = fopen($lockPath, 'c+');
    if ($lock === false) {
        return true;
    }
    if (!flock($lock, LOCK_EX)) {
        fclose($lock);
        return true;
    }

    $deadline = microtime(true) + $maxWaitSeconds;
    $ok = false;
    while (microtime(true) < $deadline) {
        $times = [];
        if (is_readable($file)) {
            $decoded = json_decode((string) file_get_contents($file), true);
            if (is_array($decoded)) {
                $times = array_values(array_filter(
                    array_map('floatval', $decoded),
                    static fn(float $t): bool => $t > microtime(true) - 60,
                ));
            }
        }
        if (count($times) < $maxPerMinute) {
            $times[] = microtime(true);
            file_put_contents($file, json_encode($times));
            $ok = true;
            break;
        }
        $oldest = min($times);
        $sleep = max(0.25, ($oldest + 60) - microtime(true) + 0.35);
        flock($lock, LOCK_UN);
        usleep((int) min($sleep, 5) * 1_000_000);
        flock($lock, LOCK_EX);
    }

    flock($lock, LOCK_UN);
    fclose($lock);
    return $ok;
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
