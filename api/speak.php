<?php
declare(strict_types=1);

require __DIR__ . '/config.php';
require_api_key($GOOGLE_API_KEY);

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_response(['error' => 'POST required'], 405);
}

$input = json_decode((string) file_get_contents('php://input'), true);
$text = trim((string) ($input['text'] ?? ''));
$style = trim((string) ($input['style'] ?? 'calm, clear Czech A2 exam examiner'));

if ($text === '') {
    json_response(['error' => 'Missing text'], 400);
}

$result = gemini_interactions($GOOGLE_API_KEY, [
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
], 90);

if (!$result['ok']) {
    json_response(['error' => $result['error'] ?? 'TTS failed'], 502);
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

json_response([
    'mime' => $outMime,
    'audio' => base64_encode($outBytes),
]);
