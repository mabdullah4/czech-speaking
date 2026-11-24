<?php
declare(strict_types=1);

require __DIR__ . '/config.php';
require_api_key();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_response(['error' => 'POST required'], 405);
}

$input = json_decode((string) file_get_contents('php://input'), true);
$question = trim((string) ($input['question'] ?? ''));
$answer = trim((string) ($input['answer'] ?? ''));

if ($question === '' || $answer === '') {
    json_response(['error' => 'Missing question or answer'], 400);
}

$prompt = "Jsi examinátor ústní části české zkoušky A2 (trvalý pobyt).\n"
    . "Hodnoť stručně odpověď kandidáta.\n\n"
    . "Pravidla: odpověď má být jedna celá věta (ne jedno slovo, ne dlouhý monolog).\n\n"
    . "Otázka: {$question}\n"
    . "Odpověď kandidáta: {$answer}\n\n"
    . 'Vrať JSON: {"ok":true|false,"score":1-5,"note":"krátký feedback česky","better":"vzorová odpověď nebo null"}';

$result = gemini_interactions_failover($GOOGLE_API_KEYS, [
    'model' => $LISTEN_MODEL,
    'system_instruction' => 'You grade A2 Czech speaking answers. Output JSON only, no markdown.',
    'input' => $prompt,
    'generation_config' => [
        'thinking_level' => 'low',
        'max_output_tokens' => 256,
    ],
], 60);

if (!$result['ok']) {
    json_response(['error' => $result['error'] ?? 'Evaluate failed'], 502);
}

$feedback = gemini_extract_json_object($result['data']);
if (!is_array($feedback)) {
    $raw = gemini_walk_extract_text($result['data']);
    json_response([
        'ok' => true,
        'score' => 3,
        'note' => $raw ?: 'Hotovo.',
        'better' => null,
    ]);
}

json_response([
    'ok' => (bool) ($feedback['ok'] ?? true),
    'score' => (int) ($feedback['score'] ?? 3),
    'note' => (string) ($feedback['note'] ?? ''),
    'better' => $feedback['better'] ?? null,
]);
