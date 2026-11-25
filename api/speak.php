<?php
declare(strict_types=1);

require __DIR__ . '/config.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_response(['error' => 'POST required'], 405);
}

$input = json_decode((string) file_get_contents('php://input'), true);
$text = trim((string) ($input['text'] ?? ''));
$gender = strtolower(trim((string) ($input['gender'] ?? 'male')));
$style = trim((string) ($input['style'] ?? 'calm, clear Czech A2 exam examiner'));

if ($text === '') {
    json_response(['error' => 'Missing text'], 400);
}

if ($gender !== 'male' && $gender !== 'female') {
    $gender = 'male';
}

/**
 * Resolve exam slash forms into one gender variant for TTS / display.
 * Mirrors tools/generate-question-audio.py::resolve_gender.
 */
function resolve_gender_form(string $text, string $gender): string
{
    $t = trim($text);
    $special = [
        'vdaná/ženatý' => ['male' => 'ženatý', 'female' => 'vdaná'],
    ];
    foreach ($special as $pair => $forms) {
        $t = str_replace($pair, $forms[$gender], $t);
    }
    $t = str_replace('ý/á', $gender === 'male' ? 'ý' : 'á', $t);
    if ($gender === 'male') {
        $t = preg_replace('#/a\b#u', '', $t) ?? $t;
    } else {
        $t = preg_replace('#/a\b#u', 'a', $t) ?? $t;
    }
    $t = str_replace('/', ' nebo ', $t);
    while (str_contains($t, '  ')) {
        $t = str_replace('  ', ' ', $t);
    }
    return $t;
}

/**
 * Prefer pre-baked clips so practice never depends on Gemini TTS quota.
 * File id = first 40 hex chars of sha256(utf8 bank text).
 * Layout: assets/audio/questions/{male|female}/{id}.mp3
 */
function static_question_audio(string $text, string $gender): ?array
{
    $id = substr(hash('sha256', $text), 0, 40);
    $relDirs = [
        'assets/audio/questions/' . $gender . '/',
        // Legacy flat layout (pre gender split)
        'assets/audio/questions/',
    ];
    $root = dirname(__DIR__);
    foreach ($relDirs as $rel) {
        foreach (['mp3' => 'audio/mpeg', 'wav' => 'audio/wav'] as $ext => $mime) {
            $path = $root . '/' . $rel . $id . '.' . $ext;
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
                'url' => $rel . $id . '.' . $ext,
                'cached' => true,
                'source' => 'static',
                'gender' => $gender,
                'spoken' => resolve_gender_form($text, $gender),
            ];
        }
    }
    return null;
}

$static = static_question_audio($text, $gender);
if ($static !== null) {
    json_response($static);
}

// Fallback: Gemini TTS (needs API keys; may hit free-tier limits)
require_api_key();

$spoken = resolve_gender_form($text, $gender);
$cacheKey = hash('sha256', $TTS_MODEL . "\n" . $VOICE_NAME . "\n" . $style . "\n" . $gender . "\n" . $spoken);
$cacheFile = storage_dir('tts') . '/' . $cacheKey . '.json';

if (is_readable($cacheFile)) {
    $cached = json_decode((string) file_get_contents($cacheFile), true);
    if (is_array($cached) && !empty($cached['audio']) && !empty($cached['mime'])) {
        json_response([
            'mime' => (string) $cached['mime'],
            'audio' => (string) $cached['audio'],
            'cached' => true,
            'source' => 'gemini-cache',
            'gender' => $gender,
            'spoken' => $spoken,
        ]);
    }
}

$payload = [
    'model' => $TTS_MODEL,
    'input' => [[
        'type' => 'user_input',
        'content' => [[
            'type' => 'text',
            'text' => $spoken,
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
        'hint' => 'Question audio missing from assets/audio/questions/{male|female} — regenerate with tools/generate-question-audio.py',
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
    'gender' => $gender,
    'spoken' => $spoken,
]);
