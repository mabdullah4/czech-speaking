<?php
declare(strict_types=1);

require __DIR__ . '/config.php';
require_api_key($GOOGLE_API_KEY);

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_response(['error' => 'POST required'], 405);
}

$input = json_decode((string) file_get_contents('php://input'), true);
$audioB64 = (string) ($input['audio'] ?? '');
$mime = (string) ($input['mime'] ?? 'audio/webm');

if ($audioB64 === '') {
    json_response(['error' => 'Missing audio'], 400);
}

if (str_starts_with($audioB64, 'data:')) {
    $comma = strpos($audioB64, ',');
    if ($comma !== false) {
        $meta = substr($audioB64, 5, $comma - 5);
        if (preg_match('#^([^;]+)#', $meta, $m)) {
            $mime = $m[1];
        }
        $audioB64 = substr($audioB64, $comma + 1);
    }
}

$result = gemini_interactions($GOOGLE_API_KEY, [
    'model' => $LISTEN_MODEL,
    'system_instruction' => 'Transcribe the speech verbatim. It is a language learner speaking Czech, '
        . 'possibly with mistakes: write exactly the words they said, in Czech with diacritics, '
        . 'without correcting grammar or completing sentences. If there is no intelligible speech, '
        . 'output an empty string. Output JSON only: {"heard":"..."}. No markdown.',
    'input' => [[
        'type' => 'audio',
        'data' => $audioB64,
        'mime_type' => $mime,
    ]],
    'generation_config' => [
        'thinking_level' => 'low',
        'max_output_tokens' => 256,
    ],
], 60);

if (!$result['ok']) {
    json_response(['error' => $result['error'] ?? 'Listen failed'], 502);
}

$parsed = gemini_extract_json_object($result['data']);
$transcript = trim((string) ($parsed['heard'] ?? ''));
if ($transcript === '') {
    $transcript = gemini_walk_extract_text($result['data']);
}

json_response([
    'transcript' => $transcript,
]);
