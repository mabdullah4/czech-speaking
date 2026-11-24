<?php
declare(strict_types=1);

/**
 * One Gemini call: transcribe learner audio + grade against the exam question.
 * Cuts free-tier usage vs separate listen.php + evaluate.php.
 */

require __DIR__ . '/config.php';
require_api_key();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_response(['error' => 'POST required'], 405);
}

$input = json_decode((string) file_get_contents('php://input'), true);
$audioB64 = (string) ($input['audio'] ?? '');
$mime = (string) ($input['mime'] ?? 'audio/webm');
$question = trim((string) ($input['question'] ?? ''));

if ($audioB64 === '') {
    json_response(['error' => 'Missing audio'], 400);
}
if ($question === '') {
    json_response(['error' => 'Missing question'], 400);
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

$prompt = "Otázka examinátora: {$question}\n\n"
    . "Přepiš nahrávku kandidáta doslova (čeština, s diakritikou, bez oprav) "
    . "a ohodnoť odpověď pro ústní A2 (trvalý pobyt). "
    . "Odpověď má být jedna celá věta.\n"
    . 'Vrať JSON: {"heard":"...","ok":true|false,"score":1-5,"note":"krátký feedback česky","better":"vzorová odpověď nebo null"}. '
    . 'Pokud není srozumitelná řeč: {"heard":"","ok":false,"score":1,"note":"Nerozumím.","better":null}';

$result = gemini_interactions_failover($GOOGLE_API_KEYS, [
    'model' => $LISTEN_MODEL,
    'system_instruction' => 'You are a Czech A2 oral-exam examiner. '
        . 'Transcribe then grade. Output JSON only, no markdown.',
    'input' => [
        [
            'type' => 'text',
            'text' => $prompt,
        ],
        [
            'type' => 'audio',
            'data' => $audioB64,
            'mime_type' => $mime,
        ],
    ],
    'generation_config' => [
        'thinking_level' => 'low',
        'max_output_tokens' => 320,
    ],
], 75);

if (!$result['ok']) {
    $status = gemini_is_rate_limited($result) ? 429 : 502;
    json_response([
        'error' => $result['error'] ?? 'Answer grading failed',
        'retry_after' => $status === 429 ? 20 : null,
    ], $status);
}

$parsed = gemini_extract_json_object($result['data']);
if (!is_array($parsed)) {
    $raw = gemini_walk_extract_text($result['data']);
    json_response([
        'transcript' => $raw,
        'feedback' => [
            'ok' => true,
            'score' => 3,
            'note' => 'Hotovo.',
            'better' => null,
        ],
    ]);
}

$transcript = trim((string) ($parsed['heard'] ?? ''));

json_response([
    'transcript' => $transcript,
    'feedback' => [
        'ok' => (bool) ($parsed['ok'] ?? ($transcript !== '')),
        'score' => (int) ($parsed['score'] ?? ($transcript !== '' ? 3 : 1)),
        'note' => (string) ($parsed['note'] ?? ''),
        'better' => $parsed['better'] ?? null,
    ],
]);
