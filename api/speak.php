<?php
declare(strict_types=1);

require __DIR__ . '/config.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_response(['error' => 'POST required'], 405);
}

$input = json_decode((string) file_get_contents('php://input'), true);
$text = trim((string) ($input['text'] ?? ''));
$style = trim((string) ($input['style'] ?? 'calm, clear Czech A2 exam examiner'));

if ($text === '') {
    json_response(['error' => 'Missing text'], 400);
}

/**
 * Prefer pre-baked Piper clips so practice never depends on Gemini TTS quota.
 * File id = first 40 hex chars of sha256(utf8 text).
 */
function static_question_audio(string $text): ?array
{
    $id = substr(hash('sha256', $text), 0, 40);
    $base = dirname(__DIR__) . '/assets/audio/questions/' . $id;
    foreach (['mp3' => 'audio/mpeg', 'wav' => 'audio/wav'] as $ext => $mime) {
        $path = $base . '.' . $ext;
        if (!is_readable($path)) {
            continue;
        }
        $bytes = file_get_contents($path);
        if ($bytes === false || $bytes === '') {
            continue;
        }
        return [
            'mime' => $mime,
            'audio' => base64_encode($bytes),
            'url' => 'assets/audio/questions/' . $id . '.' . $ext,
            'cached' => true,
            'source' => 'static',
        ];
    }
    return null;
}

$static = static_question_audio($text);
if ($static !== null) {
    json_response($static);
}

// Fallback: Gemini TTS (needs API keys; may hit free-tier limits)
require_api_key();

$cacheKey = hash('sha256', $TTS_MODEL . "\n" . $VOICE_NAME . "\n" . $style . "\n" . $text);
$cacheFile = storage_dir('tts') . '/' . $cacheKey . '.json';

if (is_readable($cacheFile)) {
    $cached = json_decode((string) file_get_contents($cacheFile), true);
    if (is_array($cached) && !empty($cached['audio']) && !empty($cached['mime'])) {
        json_response([
            'mime' => (string) $cached['mime'],
            'audio' => (string) $cached['audio'],
            'cached' => true,
            'source' => 'gemini-cache',
        ]);
    }
}

$payload = [
    'model' => $TTS_MODEL,
    'input' => [[
        'type' => 'user_input',
        'content' => [[
            'type' => 'text',
            'text' => $text,
            'annotations' => [[
                'type' => 'speech_metadata',
                'style' => $style,
            ]],
        ]],
    ]],
    'response_format' => ['type' => 'audio'],
    'generation_config' => [
        'speech_config' => [
            ['voice' => $VOICE_NAME],
        ],
    ],
];

$result = gemini_tts_failover($GOOGLE_API_KEYS, $payload, 90);

if (!$result['ok'] && gemini_is_rate_limited($result)) {
    sleep(12);
    $result = gemini_tts_failover($GOOGLE_API_KEYS, $payload, 90);
}

if (!$result['ok']) {
    $status = gemini_is_rate_limited($result) ? 429 : 502;
    json_response([
        'error' => $result['error'] ?? 'TTS failed',
        'retry_after' => $status === 429 ? 25 : null,
        'hint' => 'Question audio missing from assets/audio/questions — regenerate with tools/generate-question-audio.py',
    ], $status);
}

$audio = gemini_walk_extract_audio($result['data']);
if ($audio === null) {
    json_response(['error' => 'No audio returned from Gemini TTS'], 502);
}

$mime = $audio['mime'];
$bytes = base64_decode($audio['data'], true);
if ($bytes === false) {
    json_response(['error' => 'Invalid audio payload'], 502);
}

$outMime = 'audio/wav';
$outBytes = $bytes;
if (stripos($mime, 'wav') === false) {
    $rate = 24000;
    if (preg_match('/rate=(\d+)/i', $mime, $m)) {
        $rate = (int) $m[1];
    }
    $outBytes = pcm_to_wav($bytes, $rate);
    $outMime = 'audio/wav';
} else {
    $outMime = $mime;
}

$out = [
    'mime' => $outMime,
    'audio' => base64_encode($outBytes),
];
file_put_contents($cacheFile, json_encode($out));

json_response($out + [
    'cached' => false,
    'source' => 'gemini',
    'key_index' => $result['key_index'] ?? 0,
]);
